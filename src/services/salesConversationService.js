'use strict';

/**
 * Instagram Sales Conversation Service
 *
 * Manages the multi-turn DM sales funnel triggered by a sales-intent comment.
 *
 * Stage flow:
 *   initial_cta_sent
 *     → (user wants payment)  → payment_link_sent
 *     → (user wants details)  → details_sent
 *     → (user is hesitant)    → whatsapp_requested
 *   details_sent
 *     → (user wants payment)  → payment_link_sent
 *     → (user is hesitant)    → whatsapp_requested
 *   payment_link_sent
 *     → (user is hesitant)    → whatsapp_requested
 *   whatsapp_requested
 *     → (user shares number)  → whatsapp_captured
 *     → (no number found)     → stays (re-prompt once)
 */

const Organization = require('../models/Organization');
const SalesConversationState = require('../models/SalesConversationState');
const ProductOrder = require('../models/ProductOrder');
const Product = require('../models/Product');
const PlatformConnection = require('../models/PlatformConnection');
const instagramService = require('../integrations/meta/instagramService');
const logger = require('../config/logger');

const svcLogger = logger.createChild({ module: 'salesConversationService' });

// ── Default keyword lists ────────────────────────────────────────────────────

const DEFAULT_HESITANCY_KEYWORDS = [
  'no', 'nahi', 'not interested', 'later', 'abhi nahi',
  'nope', 'not now', 'maybe later', 'bas', 'ok later', 'dekh lete'
];

const DETAILS_KEYWORDS = [
  'detail', 'details', 'price', 'cost', 'kitna', 'how much', 'bata',
  'info', 'information', 'tell me', 'more', 'kya hai', 'size', 'sizes',
  'colour', 'color', 'colors', 'colours', 'description', 'product'
];

const PAYMENT_KEYWORDS = [
  'pay', 'payment', 'link', 'buy', 'order', 'checkout', 'khareed',
  'purchase', 'place order', 'pay now', 'send link', 'payment link',
  'pay karo', 'kaise order', 'order karna', 'buy now'
];

// ── Intent helpers ───────────────────────────────────────────────────────────

function wantsPayment(text) {
  const lower = String(text || '').toLowerCase();
  return PAYMENT_KEYWORDS.some(kw => lower.includes(kw));
}

function wantsDetails(text) {
  const lower = String(text || '').toLowerCase();
  return DETAILS_KEYWORDS.some(kw => lower.includes(kw));
}

function isHesitant(text, keywords) {
  const lower = String(text || '').toLowerCase();
  return (keywords || DEFAULT_HESITANCY_KEYWORDS).some(kw =>
    lower.includes(String(kw).toLowerCase().trim())
  );
}

function extractPhone(text) {
  const match = String(text || '').match(/[\+]?[0-9][\d\s\-().]{7,}/);
  if (!match) return null;
  const cleaned = match[0].replace(/\s+/g, ' ').trim();
  return cleaned.length >= 8 ? cleaned : null;
}

// ── Connection resolver ──────────────────────────────────────────────────────

async function resolveIgConnection(organizationId, interactionConnection) {
  const conn = interactionConnection
    ? await PlatformConnection.findById(interactionConnection)
        .select('accessToken platformData platformPageId platformUserId metadata').lean()
    : await PlatformConnection.findOne({
        organization: organizationId,
        platform: 'instagram',
        isActive: true
      }).sort({ updatedAt: -1 }).select('accessToken platformData platformPageId platformUserId metadata').lean();

  if (!conn?.accessToken) return null;

  const connType = conn.metadata?.connectionType
    || (typeof conn.accessToken === 'string' && conn.accessToken.startsWith('IGAA')
        ? 'instagram_login'
        : null);

  const pageId = connType === 'instagram_login'
    ? (conn.metadata?.igLoginScopedId || conn.platformUserId)
    : (conn.platformData?.pageId || conn.platformPageId || conn.platformUserId);

  return { accessToken: conn.accessToken, pageId, connType };
}

// ── Product loader ───────────────────────────────────────────────────────────

/**
 * Loads the Product and orderToken from the SalesConversationState's ProductOrder.
 * Returns null if the state has no productOrderId or the order/product is missing.
 */
async function loadProductFromState(state) {
  if (!state.productOrderId) return null;
  const order = await ProductOrder.findById(state.productOrderId)
    .populate({ path: 'product', model: Product })
    .lean();
  if (!order?.product) return null;
  return { product: order.product, orderToken: order.orderToken };
}

// ── DM send helpers ──────────────────────────────────────────────────────────

/**
 * Sends the full product details as a plain-text DM.
 */
async function sendProductDetails(instagramUserId, product, conn) {
  const lines = [];
  lines.push(`🛍️ *${product.name}*`);
  if (product.description) lines.push(`📝 ${product.description}`);
  if (product.price != null) lines.push(`💵 Price: ${product.currency || 'AED'} ${product.price}`);
  if (product.sizes?.length) lines.push(`📦 Sizes: ${product.sizes.join(', ')}`);
  if (product.colors?.length) lines.push(`🎨 Colors: ${product.colors.join(', ')}`);
  lines.push('');
  lines.push('Reply with "payment link" to place your order, or ask us anything! 😊');

  await instagramService.sendMessage(
    instagramUserId,
    lines.join('\n'),
    conn.accessToken,
    conn.pageId,
    false,
    conn.connType
  );
}

/**
 * Sends the payment link as a plain-text DM.
 */
async function sendPaymentLink(instagramUserId, product, orderToken, conn) {
  if (!product.paymentUrl) {
    await instagramService.sendMessage(
      instagramUserId,
      'Our payment link will be ready shortly. We\'ll send it to you as soon as it\'s available! 🙏',
      conn.accessToken,
      conn.pageId,
      false,
      conn.connType
    );
    return;
  }

  const sep = product.paymentUrl.includes('?') ? '&' : '?';
  const url = orderToken ? `${product.paymentUrl}${sep}ref=${orderToken}` : product.paymentUrl;

  await instagramService.sendMessage(
    instagramUserId,
    `👉 Here's your order link:\n\n${url}\n\nTap the link to complete your purchase! 🛍️`,
    conn.accessToken,
    conn.pageId,
    false,
    conn.connType
  );
}

// ── Main entry point ─────────────────────────────────────────────────────────

/**
 * Called from instagramWebhookService after a DM Interaction is saved.
 * Checks whether the sender has an active sales conversation state and advances
 * the funnel based on the detected intent in the user's reply.
 *
 * @param {object} interaction - Saved Interaction document (or lean object)
 * @param {string} organizationId
 */
async function handleInboundDm(interaction, organizationId) {
  try {
    if (!interaction || interaction.type !== 'dm') return;

    const instagramUserId = String(interaction.author?.platformId || '');
    if (!instagramUserId) return;

    // ── 1. Load org settings ───────────────────────────────────────────
    const org = await Organization.findById(organizationId)
      .select('salesFlowSettings')
      .lean();

    if (!org?.salesFlowSettings?.enabled) {
      svcLogger.debug('[salesConversation] Skipping — salesFlowSettings.enabled is false', { organizationId });
      return;
    }

    const settings = org.salesFlowSettings;

    // ── 2. Load active sales state for this user ───────────────────────
    const state = await SalesConversationState.findOne({
      organization: organizationId,
      instagramUserId
    }).sort({ createdAt: -1 }); // most recent if multiple

    if (!state) {
      svcLogger.debug('[salesConversation] No active SalesConversationState found for user', {
        instagramUserId, organizationId
      });
      return;
    }

    if (['whatsapp_captured', 'dropped'].includes(state.stage)) {
      svcLogger.debug('[salesConversation] Conversation already concluded', {
        instagramUserId, stage: state.stage
      });
      return;
    }

    // Extract the latest inbound message text from the interaction
    const incomingMessages = interaction.metadata?.incomingMessages || [];
    const latestMsg = incomingMessages[incomingMessages.length - 1];
    const replyText = latestMsg?.text || interaction.content || '';

    svcLogger.info('[salesConversation] Handling inbound DM', {
      instagramUserId, stage: state.stage, replyPreview: replyText.substring(0, 80)
    });

    // ── 3. Resolve IG connection for sending ───────────────────────────
    const conn = await resolveIgConnection(organizationId, interaction.platformConnection);
    if (!conn) {
      svcLogger.warn('[salesConversation] No active Instagram connection — cannot send DM', { organizationId });
      return;
    }

    // ── 4. Stage-specific logic ────────────────────────────────────────

    // ── Stage: initial_cta_sent ────────────────────────────────────────
    if (state.stage === 'initial_cta_sent') {
      const payIntent = wantsPayment(replyText);
      const detailIntent = wantsDetails(replyText);
      const hesitant = isHesitant(replyText, settings.hesitancyKeywords);

      if (payIntent) {
        const data = await loadProductFromState(state);
        if (data) {
          await sendPaymentLink(instagramUserId, data.product, data.orderToken, conn);
          state.stage = 'payment_link_sent';
          state.lastStageAt = new Date();
          await state.save();
          svcLogger.info('[salesConversation] Payment intent detected — sent payment link', { instagramUserId });
        } else {
          svcLogger.warn('[salesConversation] Payment intent but no product found on state', { instagramUserId, stateId: state._id });
        }
        return;
      }

      if (detailIntent) {
        const data = await loadProductFromState(state);
        if (data) {
          await sendProductDetails(instagramUserId, data.product, conn);
          state.stage = 'details_sent';
          state.lastStageAt = new Date();
          await state.save();
          svcLogger.info('[salesConversation] Detail intent detected — sent product details', { instagramUserId });
        } else {
          svcLogger.warn('[salesConversation] Detail intent but no product found on state', { instagramUserId, stateId: state._id });
        }
        return;
      }

      if (hesitant) {
        const captureMsg = settings.whatsappCaptureMessage
          || 'No problem! Would you like us to reach you on WhatsApp? Just share your number and we\'ll be in touch. 😊';
        await instagramService.sendMessage(instagramUserId, captureMsg, conn.accessToken, conn.pageId, false, conn.connType);
        state.stage = 'whatsapp_requested';
        state.lastStageAt = new Date();
        await state.save();
        svcLogger.info('[salesConversation] Hesitancy detected at initial_cta_sent — asked for WhatsApp', { instagramUserId });
        return;
      }

      svcLogger.info('[salesConversation] No clear intent detected — no action taken', { instagramUserId, replyPreview: replyText.substring(0, 60) });
      return;
    }

    // ── Stage: details_sent ────────────────────────────────────────────
    if (state.stage === 'details_sent') {
      const payIntent = wantsPayment(replyText);
      const hesitant = isHesitant(replyText, settings.hesitancyKeywords);

      if (payIntent) {
        const data = await loadProductFromState(state);
        if (data) {
          await sendPaymentLink(instagramUserId, data.product, data.orderToken, conn);
          state.stage = 'payment_link_sent';
          state.lastStageAt = new Date();
          await state.save();
          svcLogger.info('[salesConversation] Payment intent after details — sent payment link', { instagramUserId });
        }
        return;
      }

      if (hesitant) {
        const captureMsg = settings.whatsappCaptureMessage
          || 'No problem! Would you like us to reach you on WhatsApp? Just share your number and we\'ll be in touch. 😊';
        await instagramService.sendMessage(instagramUserId, captureMsg, conn.accessToken, conn.pageId, false, conn.connType);
        state.stage = 'whatsapp_requested';
        state.lastStageAt = new Date();
        await state.save();
        svcLogger.info('[salesConversation] Hesitancy detected at details_sent — asked for WhatsApp', { instagramUserId });
        return;
      }

      svcLogger.info('[salesConversation] No clear intent after details — no action taken', { instagramUserId });
      return;
    }

    // ── Stage: payment_link_sent ───────────────────────────────────────
    if (state.stage === 'payment_link_sent') {
      const hesitant = isHesitant(replyText, settings.hesitancyKeywords);

      if (hesitant) {
        const captureMsg = settings.whatsappCaptureMessage
          || 'No problem! Would you like us to reach you on WhatsApp? Just share your number and we\'ll be in touch. 😊';
        await instagramService.sendMessage(instagramUserId, captureMsg, conn.accessToken, conn.pageId, false, conn.connType);
        state.stage = 'whatsapp_requested';
        state.lastStageAt = new Date();
        await state.save();
        svcLogger.info('[salesConversation] Hesitancy detected at payment_link_sent — asked for WhatsApp', { instagramUserId });
      } else {
        svcLogger.info('[salesConversation] Reply after payment link — no action taken', { instagramUserId });
      }
      return;
    }

    // ── Stage: whatsapp_requested ──────────────────────────────────────
    if (state.stage === 'whatsapp_requested') {
      const phone = extractPhone(replyText);

      if (phone) {
        const confirmMsg = settings.whatsappCaptureConfirmation
          || 'Thank you! We\'ll contact you on WhatsApp soon. 🙏';
        await instagramService.sendMessage(instagramUserId, confirmMsg, conn.accessToken, conn.pageId, false, conn.connType);
        state.stage = 'whatsapp_captured';
        state.whatsappNumber = phone;
        state.lastStageAt = new Date();
        await state.save();
        svcLogger.info('[salesConversation] WhatsApp number captured', { instagramUserId, phone });
      } else {
        const reprompt = 'Please share your WhatsApp number (e.g. +91 98765 43210) so we can reach you. 😊';
        await instagramService.sendMessage(instagramUserId, reprompt, conn.accessToken, conn.pageId, false, conn.connType);
        svcLogger.info('[salesConversation] No phone found — re-prompted user', { instagramUserId });
      }
      return;
    }
  } catch (err) {
    // Non-fatal: never break the webhook pipeline
    svcLogger.error('[salesConversation] Unhandled error', { error: err.message, stack: err.stack });
  }
}

module.exports = { handleInboundDm, isHesitant, wantsDetails, wantsPayment, extractPhone };
