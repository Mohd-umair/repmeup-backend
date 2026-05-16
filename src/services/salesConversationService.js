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

/**
 * Merges product.dmConfig over the org-level salesFlowSettings.
 * Product fields always win; org settings are the fallback.
 * Returns a flat effective-config object used for hesitancy keywords and messages.
 */
function effectiveConfig(product, orgSettings) {
  const pdc = product?.dmConfig || {};
  const sf  = orgSettings || {};
  return {
    hesitancyKeywords:           (pdc.hesitancyKeywords?.length   ? pdc.hesitancyKeywords   : sf.hesitancyKeywords)   || [],
    whatsappCaptureMessage:      pdc.whatsappCaptureMessage      || sf.whatsappCaptureMessage      || '',
    whatsappCaptureConfirmation: pdc.whatsappCaptureConfirmation || sf.whatsappCaptureConfirmation || '',
  };
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

// ── Postback (CTA button tap) handler ────────────────────────────────────────

/**
 * Parses a CTA postback payload formatted as `SALES:<action>:<orderToken>`.
 * Returns { action, orderToken } or null if the payload is malformed.
 */
function parsePostbackPayload(payload) {
  if (typeof payload !== 'string') return null;
  if (!payload.startsWith('SALES:')) return null;
  const parts = payload.split(':');
  if (parts.length < 3) return null;
  const action = (parts[1] || '').toLowerCase().trim();
  const orderToken = parts.slice(2).join(':').trim();
  if (!action || !orderToken) return null;
  return { action, orderToken };
}

/**
 * Called from instagramWebhookService when a user taps a postback CTA button.
 * The payload was generated in commentToDmService as `SALES:<action>:<orderToken>`.
 *
 * Recognized actions: 'details' | 'payment' | 'hesitant'
 * Free-form actions are echoed back to the user as text.
 *
 * @param {object} args
 * @param {string} args.instagramUserId  IG-scoped sender id (event.sender.id)
 * @param {string} args.organizationId
 * @param {string} args.payload          Raw postback payload
 * @param {string} [args.title]          Button title (for free-form fallback)
 * @param {string} [args.platformConnectionId]
 */
async function handlePostback({ instagramUserId, organizationId, payload, title, platformConnectionId }) {
  try {
    if (!instagramUserId || !organizationId || !payload) return;

    const parsed = parsePostbackPayload(payload);
    if (!parsed) {
      svcLogger.debug('[salesConversation] Postback payload not recognized — ignoring', { payload });
      return;
    }
    const { action, orderToken } = parsed;

    // Look up the ProductOrder by orderToken (set when the CTA card was sent).
    const order = await ProductOrder.findOne({
      organization: organizationId,
      orderToken
    }).populate({ path: 'product', model: Product });

    if (!order || !order.product) {
      svcLogger.warn('[salesConversation] Postback received but no ProductOrder found', { orderToken, action });
      return;
    }

    // Resolve a working IG connection
    const conn = await resolveIgConnection(organizationId, platformConnectionId);
    if (!conn) {
      svcLogger.warn('[salesConversation] No active Instagram connection for postback', { organizationId });
      return;
    }

    // Locate (or create) the sales state row so the typed-intent flow can keep going
    let state = await SalesConversationState.findOne({
      organization: organizationId,
      instagramUserId,
      postId: order.instagramPostId
    });

    if (action === 'details') {
      await sendProductDetails(instagramUserId, order.product, conn);
      if (state) {
        state.stage = 'details_sent';
        state.lastStageAt = new Date();
        await state.save();
      }
      svcLogger.info('[salesConversation] Postback action handled: details', { instagramUserId, orderToken });
      return;
    }

    if (action === 'payment') {
      await sendPaymentLink(instagramUserId, order.product, order.orderToken, conn);
      if (state) {
        state.stage = 'payment_link_sent';
        state.lastStageAt = new Date();
        await state.save();
      }
      svcLogger.info('[salesConversation] Postback action handled: payment', { instagramUserId, orderToken });
      return;
    }

    if (action === 'hesitant') {
      const org = await Organization.findById(organizationId).select('salesFlowSettings').lean();
      const cfg = effectiveConfig(order.product, org?.salesFlowSettings);
      const captureMsg = cfg.whatsappCaptureMessage
        || 'No problem! Would you like us to reach you on WhatsApp? Just share your number and we\'ll be in touch. 😊';
      await instagramService.sendMessage(instagramUserId, captureMsg, conn.accessToken, conn.pageId, false, conn.connType);
      if (state) {
        state.stage = 'whatsapp_requested';
        state.lastStageAt = new Date();
        await state.save();
      }
      svcLogger.info('[salesConversation] Postback action handled: hesitant', { instagramUserId, orderToken });
      return;
    }

    // Free-form action — echo the button title so the user gets some response
    const echo = title ? `You tapped "${title}". Reply with "details" for product info or "buy" to order. 🛍️` : null;
    if (echo) {
      await instagramService.sendMessage(instagramUserId, echo, conn.accessToken, conn.pageId, false, conn.connType);
      svcLogger.info('[salesConversation] Postback action unrecognized — echoed title', { action, title });
    } else {
      svcLogger.info('[salesConversation] Postback action unrecognized and no title', { action });
    }
  } catch (err) {
    // Non-fatal: never break the webhook pipeline
    svcLogger.error('[salesConversation] handlePostback unhandled error', { error: err.message, stack: err.stack });
  }
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

    // Load product early so we can apply per-product overrides to hesitancy
    // keywords / WhatsApp messages. This is a single DB call that is re-used
    // across all stages that might need product data anyway.
    const productData = await loadProductFromState(state);
    const cfg = effectiveConfig(productData?.product, settings);

    // ── Stage: initial_cta_sent ────────────────────────────────────────
    if (state.stage === 'initial_cta_sent') {
      const payIntent = wantsPayment(replyText);
      const detailIntent = wantsDetails(replyText);
      const hesitant = isHesitant(replyText, cfg.hesitancyKeywords);

      if (payIntent) {
        if (productData) {
          await sendPaymentLink(instagramUserId, productData.product, productData.orderToken, conn);
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
        if (productData) {
          await sendProductDetails(instagramUserId, productData.product, conn);
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
        const captureMsg = cfg.whatsappCaptureMessage
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
      const hesitant = isHesitant(replyText, cfg.hesitancyKeywords);

      if (payIntent) {
        if (productData) {
          await sendPaymentLink(instagramUserId, productData.product, productData.orderToken, conn);
          state.stage = 'payment_link_sent';
          state.lastStageAt = new Date();
          await state.save();
          svcLogger.info('[salesConversation] Payment intent after details — sent payment link', { instagramUserId });
        }
        return;
      }

      if (hesitant) {
        const captureMsg = cfg.whatsappCaptureMessage
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
      const hesitant = isHesitant(replyText, cfg.hesitancyKeywords);

      if (hesitant) {
        const captureMsg = cfg.whatsappCaptureMessage
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
        const confirmMsg = cfg.whatsappCaptureConfirmation
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

module.exports = { handleInboundDm, handlePostback, isHesitant, wantsDetails, wantsPayment, extractPhone };
