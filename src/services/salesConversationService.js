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
const commentToDmService = require('./commentToDmService');
const { recordAutomationReply } = require('./inbox/inboxAutomationReplyService');
const productVariantService = require('./productVariantService');
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

function resolveCommentInteractionId(state, order = null) {
  return state?.commentInteractionId || order?.commentInteractionId || null;
}

async function recordSalesOutbound(state, organizationId, order, payload) {
  const interactionId = resolveCommentInteractionId(state, order);
  if (!interactionId) return;
  await recordAutomationReply({
    interactionId,
    organizationId,
    ...payload
  });
}

async function sendInstagramTextAndRecord({ state, organizationId, order, conn, instagramUserId, content }) {
  const result = await instagramService.sendMessage(
    instagramUserId,
    content,
    conn.accessToken,
    conn.pageId,
    false,
    conn.connType
  );

  if (result?.success) {
    await recordSalesOutbound(state, organizationId, order, {
      content,
      platformResponseId: result.platformResponseId || null,
      messageType: 'instagram_private_dm'
    });
  }

  return result;
}

function buildProductDetailsText(product, selectedVariant = null) {
  const lines = [];
  lines.push(`🛍️ *${product.name}*`);
  if (product.description) lines.push(`📝 ${product.description}`);
  if (product.price != null) lines.push(`💵 Price: ${product.currency || 'AED'} ${product.price}`);
  if (product.sizes?.length) lines.push(`📦 Sizes: ${product.sizes.join(', ')}`);
  if (product.colors?.length) lines.push(`🎨 Colours: ${product.colors.join(', ')}`);

  const chosen = productVariantService.summarizeVariant(selectedVariant);
  if (chosen) lines.push(`✅ Your pick: ${chosen}`);

  lines.push('');
  const { hasVariants } = productVariantService.variantDimensions(product);
  lines.push(hasVariants && !isVariantComplete(product, selectedVariant)
    ? 'Tell me the size/colour you want, then reply "payment link" to order — or ask us anything! 😊'
    : 'Reply with "payment link" to place your order, or ask us anything! 😊');
  return lines.join('\n');
}

/** True when the product's required variant dimensions are all chosen. */
function isVariantComplete(product, variant) {
  const { needsSize, needsColor } = productVariantService.variantDimensions(product);
  if (needsSize && !variant?.size) return false;
  if (needsColor && !variant?.color) return false;
  return true;
}

/**
 * Sends the full product details as a plain-text DM.
 */
async function sendProductDetails(instagramUserId, product, conn, recordCtx = null, selectedVariant = null) {
  const content = buildProductDetailsText(product, selectedVariant);
  if (recordCtx) {
    return sendInstagramTextAndRecord({
      ...recordCtx,
      conn,
      instagramUserId,
      content
    });
  }
  return instagramService.sendMessage(
    instagramUserId,
    content,
    conn.accessToken,
    conn.pageId,
    false,
    conn.connType
  );
}

function buildPaymentLinkText(product, orderToken, variant = null) {
  if (!product.paymentUrl) {
    return 'Our payment link will be ready shortly. We\'ll send it to you as soon as it\'s available! 🙏';
  }
  const sep = product.paymentUrl.includes('?') ? '&' : '?';
  let url = orderToken ? `${product.paymentUrl}${sep}ref=${orderToken}` : product.paymentUrl;
  url = productVariantService.appendVariantToUrl(url, variant);

  const chosen = productVariantService.summarizeVariant(variant);
  const confirm = chosen ? `✅ ${product.name} — ${chosen}\n\n` : '';
  return `${confirm}👉 Here's your order link:\n\n${url}\n\nTap the link to complete your purchase! 🛍️`;
}

/**
 * Sends the payment link as a plain-text DM (variant embedded when chosen).
 */
async function sendPaymentLink(instagramUserId, product, orderToken, conn, recordCtx = null, variant = null) {
  const content = buildPaymentLinkText(product, orderToken, variant);
  if (recordCtx) {
    return sendInstagramTextAndRecord({
      ...recordCtx,
      conn,
      instagramUserId,
      content
    });
  }
  return instagramService.sendMessage(
    instagramUserId,
    content,
    conn.accessToken,
    conn.pageId,
    false,
    conn.connType
  );
}

// ── Variant capture & payment gating ─────────────────────────────────────────

/**
 * Ask the customer for their WhatsApp number (hesitancy path). Advances the state
 * to `whatsapp_requested`. Shared by every stage that can divert to WA capture.
 */
async function askForWhatsApp({ recordCtx, conn, instagramUserId, state, cfg }) {
  const captureMsg = cfg?.whatsappCaptureMessage
    || 'No problem! Would you like us to reach you on WhatsApp? Just share your number and we\'ll be in touch. 😊';
  await sendInstagramTextAndRecord({
    ...recordCtx,
    conn,
    instagramUserId,
    content: captureMsg
  });
  if (state) {
    state.stage = 'whatsapp_requested';
    state.lastStageAt = new Date();
    await state.save();
  }
}

/**
 * Persist a chosen variant to the conversation state, its ProductOrder, and the
 * mirrored CommerceOrder line item. `state` is a live mongoose doc; the order and
 * commerce updates are best-effort and never break the funnel.
 */
async function persistSelectedVariant(state, product, variant, organizationId) {
  const clean = { size: variant?.size || null, color: variant?.color || null };
  if (state) {
    state.selectedVariant = clean;
  }
  try {
    if (state?.productOrderId) {
      await ProductOrder.updateOne(
        { _id: state.productOrderId },
        { $set: { selectedVariant: clean } }
      );
    }
  } catch (e) {
    svcLogger.warn('[salesConversation] persist variant → ProductOrder failed (non-fatal)', { error: e.message });
  }
  try {
    if (product?._id && (clean.size || clean.color)) {
      const CommerceOrder = require('../models/CommerceOrder');
      await CommerceOrder.updateOne(
        {
          organization: organizationId,
          channel: 'instagram',
          instagramUserId: String(state?.instagramUserId || ''),
          'lineItems.product': product._id,
          status: { $nin: ['cancelled', 'returned', 'refunded'] }
        },
        { $set: { 'lineItems.$.variant': clean } }
      );
    }
  } catch (e) {
    svcLogger.warn('[salesConversation] persist variant → CommerceOrder failed (non-fatal)', { error: e.message });
  }
}

/**
 * Opportunistically capture any size/colour the customer mentioned in a message
 * (in any stage) and merge it into the running selection on state. Returns the
 * merged selection. Does NOT persist to order/commerce — that happens at payment.
 */
function captureVariantMention(state, product, text) {
  const { needsSize, needsColor } = productVariantService.variantDimensions(product);
  if (!needsSize && !needsColor) return state?.selectedVariant || { size: null, color: null };

  const prior = state?.selectedVariant || {};
  const sizeMatch = needsSize ? productVariantService.matchSize(text, product.sizes) : { matched: null };
  const colorMatch = needsColor ? productVariantService.matchColor(text, product.colors) : { matched: null };

  const merged = {
    size: sizeMatch.matched || prior.size || null,
    color: colorMatch.matched || prior.color || null
  };
  if (state) state.selectedVariant = merged;
  return merged;
}

/**
 * The single gate before taking payment. Ensures a complete, in-stock variant is
 * chosen; otherwise sends the right prompt (ask-missing / unavailable / OOS) and
 * parks the conversation in `awaiting_variant`.
 *
 * @returns {Promise<boolean>} true if the payment link was sent, false if we asked
 *   the customer for more info (or the product is unbuyable right now).
 */
async function proceedToPaymentOrAskVariant({
  state, product, orderToken, text, conn, instagramUserId, organizationId, order = null
}) {
  const recordCtx = { state, organizationId, order };
  const result = productVariantService.resolveVariantForPayment(product, state?.selectedVariant, text);

  if (result.status === 'complete') {
    await persistSelectedVariant(state, product, result.variant, organizationId);
    await sendPaymentLink(instagramUserId, product, orderToken, conn, recordCtx, result.variant);
    if (state) {
      state.stage = 'payment_link_sent';
      state.lastStageAt = new Date();
      await state.save();
    }
    svcLogger.info('[salesConversation] Variant complete — payment link sent', {
      instagramUserId, variant: result.variant
    });
    return true;
  }

  // incomplete | unavailable | out_of_stock → remember partial choice and ask.
  if (state) {
    state.selectedVariant = result.variant || state.selectedVariant;
  }
  await persistSelectedVariant(state, product, result.variant || {}, organizationId);
  await sendInstagramTextAndRecord({
    ...recordCtx,
    conn,
    instagramUserId,
    content: result.message
  });
  if (state) {
    state.stage = 'awaiting_variant';
    state.lastStageAt = new Date();
    await state.save();
  }
  svcLogger.info('[salesConversation] Variant not ready — asked customer', {
    instagramUserId, status: result.status, missing: result.missing
  });
  return false;
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
 * Parses product-picker postback: `PICK:<productId>:<selectionToken>`.
 */
function parsePickPayload(payload) {
  if (typeof payload !== 'string') return null;
  if (!payload.startsWith('PICK:')) return null;
  const parts = payload.split(':');
  if (parts.length < 3) return null;
  const productId = parts[1]?.trim();
  const selectionToken = parts.slice(2).join(':').trim();
  if (!productId || !selectionToken) return null;
  return { productId, selectionToken };
}

/**
 * Handle product-picker button tap from multi-product carousel comment flow.
 */
async function handleProductPickPostback({ instagramUserId, organizationId, payload, platformConnectionId }) {
  const parsed = parsePickPayload(payload);
  if (!parsed) return;

  const state = await SalesConversationState.findOne({
    organization: organizationId,
    instagramUserId: String(instagramUserId),
    stage: 'awaiting_product_selection',
    selectionToken: parsed.selectionToken
  }).lean();

  if (!state?.postId) {
    svcLogger.warn('[salesConversation] PICK postback — no matching state', { instagramUserId, selectionToken: parsed.selectionToken });
    return;
  }

  await commentToDmService.completeProductSelection({
    organizationId,
    instagramUserId,
    postId: state.postId,
    productId: parsed.productId,
    selectionToken: parsed.selectionToken,
    platformConnectionId
  });
}

/**
 * Numeric/text fallback when user replies "1", "2", etc. to numbered picker DM.
 */
async function handleNumericProductSelection({
  state,
  replyText,
  instagramUserId,
  organizationId,
  platformConnectionId
}) {
  const trimmed = String(replyText || '').trim();
  if (!trimmed || !state.selectionToken || !state.postId) return false;

  const candidateIds = (state.candidateProductIds || []).map(id => String(id));
  if (!candidateIds.length) return false;

  let productId = null;

  const numMatch = trimmed.match(/^(\d{1,2})$/);
  if (numMatch) {
    const idx = parseInt(numMatch[1], 10) - 1;
    if (idx >= 0 && idx < candidateIds.length) {
      productId = candidateIds[idx];
    }
  }

  if (!productId) {
    const products = await Product.find({
      _id: { $in: candidateIds },
      organization: organizationId,
      isActive: true
    }).select('name sku').lean();

    const { matchProductByCommentText } = require('./commentToDmProductHelpers');
    const matched = matchProductByCommentText(products, trimmed);
    if (matched) productId = String(matched._id);
  }

  if (!productId) {
    const conn = await resolveIgConnection(organizationId, platformConnectionId);
    if (conn) {
      await sendInstagramTextAndRecord({
        state,
        organizationId,
        conn,
        instagramUserId,
        content: 'Please reply with the number of the product you want (e.g. 1 or 2), or tap Select on a product card. 🛍️'
      });
    }
    return true;
  }

  await commentToDmService.completeProductSelection({
    organizationId,
    instagramUserId,
    postId: state.postId,
    productId,
    selectionToken: state.selectionToken,
    platformConnectionId
  });
  return true;
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

    if (String(payload).startsWith('PICK:')) {
      await handleProductPickPostback({ instagramUserId, organizationId, payload, platformConnectionId });
      return;
    }

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

    const wasPickerPending = order.status === 'picker_pending';
    if (wasPickerPending) {
      order.status = 'dm_sent';
      await order.save();
      await commentToDmService.cancelSiblingPickerPendingOrders({
        organizationId,
        instagramUserId,
        instagramPostId: order.instagramPostId,
        exceptOrderId: order._id
      });
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

    if (!state) {
      state = await SalesConversationState.create({
        organization: organizationId,
        instagramUserId,
        postId: order.instagramPostId,
        productOrderId: order._id,
        commentInteractionId: order.commentInteractionId || null,
        stage: 'initial_cta_sent',
        lastStageAt: new Date()
      });
    } else if (wasPickerPending && state.stage === 'awaiting_product_selection') {
      state.productOrderId = order._id;
      state.stage = 'initial_cta_sent';
      state.selectionToken = null;
      state.candidateProductIds = [];
      state.lastStageAt = new Date();
      await state.save();
    } else if (!state.productOrderId) {
      state.productOrderId = order._id;
      await state.save();
    }

    const recordCtx = { state, organizationId, order };

    if (action === 'details') {
      await sendProductDetails(instagramUserId, order.product, conn, recordCtx, state?.selectedVariant);
      if (state) {
        state.stage = 'details_sent';
        state.lastStageAt = new Date();
        await state.save();
      }
      svcLogger.info('[salesConversation] Postback action handled: details', { instagramUserId, orderToken });
      return;
    }

    if (action === 'payment') {
      // Gate on a complete, in-stock variant before sending the link. With no free
      // text on a button tap, this uses any variant already captured or asks for it.
      await proceedToPaymentOrAskVariant({
        state,
        product: order.product,
        orderToken: order.orderToken,
        text: '',
        conn,
        instagramUserId,
        organizationId,
        order
      });
      svcLogger.info('[salesConversation] Postback action handled: payment', { instagramUserId, orderToken });
      return;
    }

    if (action === 'hesitant') {
      const org = await Organization.findById(organizationId).select('salesFlowSettings').lean();
      const cfg = effectiveConfig(order.product, org?.salesFlowSettings);
      const captureMsg = cfg.whatsappCaptureMessage
        || 'No problem! Would you like us to reach you on WhatsApp? Just share your number and we\'ll be in touch. 😊';
      await sendInstagramTextAndRecord({
        state,
        organizationId,
        order,
        conn,
        instagramUserId,
        content: captureMsg
      });
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
      await sendInstagramTextAndRecord({
        state,
        organizationId,
        order,
        conn,
        instagramUserId,
        content: echo
      });
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

    const state = await SalesConversationState.findOne({
      organization: organizationId,
      instagramUserId
    }).sort({ createdAt: -1 });

    if (!state) {
      svcLogger.debug('[salesConversation] No active SalesConversationState found for user', {
        instagramUserId, organizationId
      });
      return;
    }

    const incomingMessages = interaction.metadata?.incomingMessages || [];
    const latestMsg = incomingMessages[incomingMessages.length - 1];
    const replyText = latestMsg?.text || interaction.content || '';

    if (['whatsapp_captured', 'dropped'].includes(state.stage)) {
      svcLogger.debug('[salesConversation] Conversation already concluded', {
        instagramUserId, stage: state.stage
      });
      return;
    }

    // Multi-product picker: numeric reply (works even when salesFlow is disabled)
    if (state.stage === 'awaiting_product_selection') {
      const handled = await handleNumericProductSelection({
        state,
        replyText,
        instagramUserId,
        organizationId,
        platformConnectionId: interaction.platformConnection
      });
      if (handled) return;
    }

    // ── 1. Load org settings ───────────────────────────────────────────
    const org = await Organization.findById(organizationId)
      .select('salesFlowSettings')
      .lean();

    if (!org?.salesFlowSettings?.enabled) {
      svcLogger.debug('[salesConversation] Skipping — salesFlowSettings.enabled is false', { organizationId });
      return;
    }

    const settings = org.salesFlowSettings;

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
    const recordCtx = { state, organizationId };
    const product = productData?.product || null;

    // ── Variant awareness (all stages) ─────────────────────────────────
    // Capture any size/colour the customer mentioned so a later "buy" doesn't
    // re-ask, and answer pure "what sizes/colours do you have?" questions directly.
    if (product) {
      const beforeCapture = JSON.stringify(state.selectedVariant || {});
      captureVariantMention(state, product, replyText);
      if (JSON.stringify(state.selectedVariant || {}) !== beforeCapture) {
        try { await state.save(); } catch (_) { /* non-fatal */ }
      }

      if (productVariantService.isAvailabilityQuery(replyText) && !wantsPayment(replyText)) {
        await sendInstagramTextAndRecord({
          ...recordCtx,
          conn,
          instagramUserId,
          content: productVariantService.buildAvailabilityText(product)
        });
        svcLogger.info('[salesConversation] Answered variant availability query', { instagramUserId });
        return;
      }
    }

    // ── Stage: awaiting_variant ────────────────────────────────────────
    // We asked for size/colour. Hesitancy still diverts to WhatsApp capture;
    // otherwise re-run the payment gate with the newly captured variant.
    if (state.stage === 'awaiting_variant') {
      if (isHesitant(replyText, cfg.hesitancyKeywords)) {
        await askForWhatsApp({ recordCtx, conn, instagramUserId, state, cfg });
        return;
      }
      if (productData) {
        await proceedToPaymentOrAskVariant({
          state,
          product,
          orderToken: productData.orderToken,
          text: replyText,
          conn,
          instagramUserId,
          organizationId
        });
      } else {
        svcLogger.warn('[salesConversation] awaiting_variant but no product on state', { instagramUserId, stateId: state._id });
      }
      return;
    }

    // ── Stage: initial_cta_sent ────────────────────────────────────────
    if (state.stage === 'initial_cta_sent') {
      const payIntent = wantsPayment(replyText);
      const detailIntent = wantsDetails(replyText);
      const hesitant = isHesitant(replyText, cfg.hesitancyKeywords);

      if (payIntent) {
        if (productData) {
          await proceedToPaymentOrAskVariant({
            state,
            product,
            orderToken: productData.orderToken,
            text: replyText,
            conn,
            instagramUserId,
            organizationId
          });
        } else {
          svcLogger.warn('[salesConversation] Payment intent but no product found on state', { instagramUserId, stateId: state._id });
        }
        return;
      }

      if (detailIntent) {
        if (productData) {
          await sendProductDetails(instagramUserId, product, conn, recordCtx, state.selectedVariant);
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
        await askForWhatsApp({ recordCtx, conn, instagramUserId, state, cfg });
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
          await proceedToPaymentOrAskVariant({
            state,
            product,
            orderToken: productData.orderToken,
            text: replyText,
            conn,
            instagramUserId,
            organizationId
          });
        }
        return;
      }

      if (hesitant) {
        const captureMsg = cfg.whatsappCaptureMessage
          || 'No problem! Would you like us to reach you on WhatsApp? Just share your number and we\'ll be in touch. 😊';
        await sendInstagramTextAndRecord({
          ...recordCtx,
          conn,
          instagramUserId,
          content: captureMsg
        });
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
        await sendInstagramTextAndRecord({
          ...recordCtx,
          conn,
          instagramUserId,
          content: captureMsg
        });
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
        await sendInstagramTextAndRecord({
          ...recordCtx,
          conn,
          instagramUserId,
          content: confirmMsg
        });
        state.stage = 'whatsapp_captured';
        state.whatsappNumber = phone;
        state.lastStageAt = new Date();
        await state.save();
        svcLogger.info('[salesConversation] WhatsApp number captured', { instagramUserId, phone });

        // IG→WA Bridge: create/update a unified Contact with the captured WA number
        // and pre-load the linked product as context so the WA inbox thread shows
        // "Came from IG Post" when the agent opens it.
        _bridgeToWhatsApp({
          phone,
          instagramUserId,
          organizationId,
          productOrderId: state.productOrderId,
          postId: state.instagramPostId
        }).catch((e) => svcLogger.warn('[salesConversation] WA bridge failed (non-fatal)', { error: e.message }));
      } else {
        const reprompt = 'Please share your WhatsApp number (e.g. +91 98765 43210) so we can reach you. 😊';
        await sendInstagramTextAndRecord({
          ...recordCtx,
          conn,
          instagramUserId,
          content: reprompt
        });
        svcLogger.info('[salesConversation] No phone found — re-prompted user', { instagramUserId });
      }
      return;
    }
  } catch (err) {
    // Non-fatal: never break the webhook pipeline
    svcLogger.error('[salesConversation] Unhandled error', { error: err.message, stack: err.stack });
  }
}

/**
 * IG→WA Bridge
 *
 * When a customer shares their WhatsApp number in the IG sales funnel,
 * create (or update) a unified Contact with their WA phone so agents can
 * continue the conversation in the WhatsApp inbox with full product context.
 *
 * @param {object} opts
 * @param {string} opts.phone            - Raw phone string from IG DM
 * @param {string} opts.instagramUserId  - IG platform user id
 * @param {string} opts.organizationId
 * @param {string} [opts.productOrderId] - ProductOrder._id if available
 * @param {string} [opts.postId]         - Instagram post id that triggered the funnel
 */
async function _bridgeToWhatsApp({ phone, instagramUserId, organizationId, productOrderId, postId }) {
  try {
    const Contact = require('../models/Contact');
    const { normalizePhoneE164 } = require('../utils/phoneNormalize');

    const normalized = normalizePhoneE164(phone, { defaultRegion: 'IN' });
    const waPhone = normalized.status !== 'invalid' ? normalized.phone : phone.replace(/\D/g, '');

    if (!waPhone) return;

    const update = {
      $set: {
        organization: organizationId,
        platform: 'whatsapp',
        platformId: waPhone,
        phone: waPhone,
        igBridgeSource: 'sales_funnel'
      },
      $setOnInsert: {
        createdAt: new Date()
      }
    };

    if (postId) {
      update.$set['metadata.sourceIgPostId'] = postId;
    }
    if (instagramUserId) {
      update.$set['metadata.sourceIgUserId'] = instagramUserId;
    }
    if (productOrderId) {
      update.$set['metadata.productOrderId'] = String(productOrderId);
    }

    await Contact.findOneAndUpdate(
      { organization: organizationId, phone: waPhone },
      update,
      { upsert: true, new: true }
    );

    svcLogger.info('[salesConversation] WA Contact created/updated from IG bridge', {
      waPhone, instagramUserId, organizationId
    });
  } catch (err) {
    svcLogger.warn('[salesConversation] _bridgeToWhatsApp error', { error: err.message });
  }
}

module.exports = {
  handleInboundDm,
  handlePostback,
  handleProductPickPostback,
  parsePickPayload,
  isHesitant,
  wantsDetails,
  wantsPayment,
  extractPhone
};
