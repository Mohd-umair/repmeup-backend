/**
 * Instagram Comment-to-DM Selling Orchestrator
 *
 * Flow:
 *  1. Comment arrives on an Instagram post.
 *  2. Org commentToDmSettings + trigger keyword match.
 *  3. Resolve product(s) linked to post media ID.
 *  4. Single product → CTA DM. Multiple products → product-picker DM.
 *  5. Deduplication, rate limits, public stub, record ProductOrder / SalesConversationState.
 */

const axios = require('axios');
const Organization = require('../models/Organization');
const Product = require('../models/Product');
const ProductOrder = require('../models/ProductOrder');
const SalesConversationState = require('../models/SalesConversationState');
const PlatformConnection = require('../models/PlatformConnection');
const instagramService = require('../integrations/meta/instagramService');
const logger = require('../config/logger');
const { nanoid } = require('nanoid');
const {
  sortProductsForPost,
  matchProductByCommentText,
  buildProductPickerElements,
  buildNumberedPickerText,
  buildEffectiveDmConfig,
  buildProductCtaElement,
  filterProductsByPerProductKeywords,
  buildPostLinkedProductQuery,
  mergeProductsById,
  MAX_PICKER_ELEMENTS
} = require('./commentToDmProductHelpers');

const svcLogger = logger.createChild({ module: 'commentToDmService' });

async function processCommentForProduct(interaction, organizationId) {
  try {
    if (!interaction || interaction.platform !== 'instagram' || interaction.type !== 'comment') {
      return;
    }

    const interactionId = interaction._id?.toString?.() || 'unknown';
    const org = await Organization.findById(organizationId)
      .select('commentToDmSettings')
      .lean();

    svcLogger.info('[commentToDm] Evaluating comment', {
      interactionId,
      commentPreview: (interaction.content || '').substring(0, 80),
      enabled: org?.commentToDmSettings?.enabled ?? false,
      postId: interaction.metadata?.postId ?? null
    });

    if (!org?.commentToDmSettings?.enabled) {
      svcLogger.info('[commentToDm] Skipping — automation is disabled for this org', { organizationId });
      return;
    }

    const settings = org.commentToDmSettings;
    const commentText = (interaction.content || '').toLowerCase();
    const keywords = (settings.triggerKeywords || []).map(k => k.toLowerCase().trim()).filter(Boolean);
    const matched = keywords.some(kw => commentText.includes(kw));

    if (!matched) {
      svcLogger.info('[commentToDm] Skipping — no trigger keyword matched', { commentText: commentText.substring(0, 60) });
      return;
    }

    const postId = interaction.metadata?.postId;
    if (!postId) {
      svcLogger.info('[commentToDm] Skipping — no metadata.postId', { interactionId });
      return;
    }

    let products = await resolveProductsForPost(interaction, organizationId, postId, settings);

    if (!products.length) {
      svcLogger.info('[commentToDm] Skipping — no product linked to post', { postId, organizationId });
      return;
    }

    products = sortProductsForPost(products, postId);

    // Unique text match (name/sku) on all linked products — skips picker when unambiguous.
    const uniqueMatch = matchProductByCommentText(products, commentText);
    const usePicker = !uniqueMatch && products.length > 1;

    // Per-product keywords apply only to single-product path (not carousel picker).
    const productsForSingle = filterProductsByPerProductKeywords(products, commentText);
    const product = uniqueMatch || (productsForSingle.length === 1 ? productsForSingle[0] : null);

    if (!usePicker && !product) {
      svcLogger.info('[commentToDm] Skipping — no product matched after keyword filter', {
        postId,
        linkedCount: products.length
      });
      return;
    }

    svcLogger.info('[commentToDm] Product resolution', {
      postId,
      linkedCount: products.length,
      usePicker,
      uniqueMatchId: uniqueMatch?._id?.toString?.() || null,
      productIds: products.map(p => String(p._id))
    });

    const commenterId = interaction.author?.platformId;
    if (!commenterId) {
      svcLogger.warn('[commentToDm] Skipping — no author.platformId', { interactionId });
      return;
    }

    if (settings.deduplicateDms !== false) {
      const skip = await shouldSkipDedup(organizationId, commenterId, postId);
      if (skip) return;
    }

    const orgDoc = await Organization.findById(organizationId).select('commentToDmSettings salesFlowSettings');
    await resetDailyCounterIfNeeded(orgDoc);

    const maxDms = orgDoc.commentToDmSettings.maxDmsPerDay || 200;
    if (orgDoc.commentToDmSettings.dmsSentToday >= maxDms) {
      svcLogger.warn('[commentToDm] Skipping — daily DM limit reached', { limit: maxDms });
      return;
    }

    const connection = await resolveConnection(interaction, organizationId);
    if (!connection) {
      svcLogger.warn('[commentToDm] Skipping — no active Instagram connection', { organizationId });
      return;
    }

    const { accessToken, pageId, connType } = connectionContext(connection);
    const commenterUsername = interaction.author?.username || '';

    await postPublicStub(interaction, settings, commenterUsername, accessToken, connType);

    if (usePicker) {
      await sendProductPickerFlow({
        interaction,
        organizationId,
        products,
        postId,
        commenterId,
        commenterUsername,
        accessToken,
        pageId,
        connType,
        orgDoc
      });
    } else {
      await sendSingleProductFlow({
        interaction,
        organizationId,
        product,
        postId,
        commenterId,
        commenterUsername,
        accessToken,
        pageId,
        connType,
        orgDoc
      });
    }

    orgDoc.commentToDmSettings.dmsSentToday += 1;
    await orgDoc.save();

    svcLogger.info('[commentToDm] Flow completed successfully', {
      commenterId,
      postId,
      mode: usePicker ? 'product_picker' : 'single_product',
      productId: product?._id,
      dmsSentToday: orgDoc.commentToDmSettings.dmsSentToday
    });
  } catch (err) {
    svcLogger.error('[commentToDm] Unhandled error', { error: err.message, stack: err.stack });
  }
}

async function resolveProductsForPost(interaction, organizationId, postId, settings) {
  const pid = String(postId);
  let products = await Product.find(buildPostLinkedProductQuery(organizationId, pid)).lean();

  // Always merge shortcode-linked products when webhook sends numeric media id.
  // Without this, one product with numeric id blocks fallback and hides other carousel links.
  if (/^\d+$/.test(pid)) {
    products = await enrichProductsWithShortcodeLookup(interaction, organizationId, pid, products);
  }

  if (!products.length && settings.defaultProductId) {
    const defaultProduct = await Product.findOne({
      _id: settings.defaultProductId,
      organization: organizationId,
      isActive: true
    }).lean();
    if (defaultProduct) products = [defaultProduct];
  }

  return products;
}

async function enrichProductsWithShortcodeLookup(interaction, organizationId, numericPostId, existingProducts = []) {
  const shortcodeProducts = await shortcodeFallbackLookup(interaction, organizationId, numericPostId);
  return mergeProductsById(existingProducts, shortcodeProducts);
}

async function shortcodeFallbackLookup(interaction, organizationId, postId) {
  try {
    let conn = interaction.platformConnection
      ? await PlatformConnection.findById(interaction.platformConnection).select('accessToken metadata').lean()
      : null;

    if (!conn?.accessToken) {
      conn = await PlatformConnection.findOne({
        organization: organizationId,
        platform: 'instagram',
        isActive: true,
        status: { $in: ['connected', 'available'] }
      }).sort({ updatedAt: -1 }).select('accessToken metadata').lean();
    }

    if (!conn?.accessToken) return [];

    const resp = await axios.get(`https://graph.facebook.com/v18.0/${postId}`, {
      params: { fields: 'shortcode', access_token: conn.accessToken },
      timeout: 5000
    });
    const shortcode = resp.data?.shortcode;
    if (!shortcode) return [];

    const products = await Product.find({
      organization: organizationId,
      isActive: true,
      $or: [
        { instagramPostIds: shortcode },
        { 'instagramPostLinks.postId': shortcode }
      ]
    }).lean();

    if (products.length) {
      await Product.updateMany(
        { _id: { $in: products.map(p => p._id) } },
        { $addToSet: { instagramPostIds: { $each: [String(postId), shortcode] } } }
      );
    }
    return products;
  } catch (resolveErr) {
    svcLogger.warn('[commentToDm] Shortcode fallback failed', { postId, err: resolveErr.message });
    return [];
  }
}

async function shouldSkipDedup(organizationId, commenterId, postId) {
  const alreadySent = await ProductOrder.exists({
    organization: organizationId,
    instagramUserId: String(commenterId),
    instagramPostId: String(postId)
  });
  if (alreadySent) {
    svcLogger.info('[commentToDm] Skipping — ProductOrder dedup', { commenterId, postId });
    return true;
  }

  const pendingPicker = await SalesConversationState.exists({
    organization: organizationId,
    instagramUserId: String(commenterId),
    postId: String(postId),
    stage: { $in: ['awaiting_product_selection', 'initial_cta_sent', 'details_sent', 'payment_link_sent'] }
  });
  if (pendingPicker) {
    svcLogger.info('[commentToDm] Skipping — active sales state exists', { commenterId, postId });
    return true;
  }

  return false;
}

async function resetDailyCounterIfNeeded(orgDoc) {
  const today = new Date().toDateString();
  const resetDate = orgDoc.commentToDmSettings.dmsSentResetDate
    ? new Date(orgDoc.commentToDmSettings.dmsSentResetDate).toDateString()
    : null;
  if (resetDate !== today) {
    orgDoc.commentToDmSettings.dmsSentToday = 0;
    orgDoc.commentToDmSettings.dmsSentResetDate = new Date();
  }
}

async function resolveConnection(interaction, organizationId) {
  return interaction.platformConnection
    ? PlatformConnection.findById(interaction.platformConnection)
        .select('accessToken platformData platformPageId platformUserId metadata').lean()
    : PlatformConnection.findOne({
        organization: organizationId,
        platform: 'instagram',
        isActive: true
      }).select('accessToken platformData platformPageId platformUserId metadata').lean();
}

function connectionContext(connection) {
  const accessToken = connection.accessToken;
  const connType = connection.metadata?.connectionType
    || (typeof connection.accessToken === 'string' && connection.accessToken.startsWith('IGAA') ? 'instagram_login' : null);
  const pageId = connType === 'instagram_login'
    ? (connection.metadata?.igLoginScopedId || connection.platformUserId)
    : (connection.platformData?.pageId || connection.platformPageId || connection.platformUserId);
  return { accessToken, pageId, connType };
}

async function postPublicStub(interaction, settings, commenterUsername, accessToken, connType) {
  const safePublicTemplate = (settings.publicReplyTemplate || "Hi {{username}}! 👋 We've sent you the details in DM. 😊")
    .replace(/\{\{payment_url\}\}/gi, '')
    .replace(/\{\{paymentUrl\}\}/gi, '');

  const publicStub = buildTemplate(safePublicTemplate, {
    username: commenterUsername ? `@${commenterUsername}` : 'there'
  });

  try {
    await instagramService.replyToComment(interaction.platformId, publicStub, accessToken, connType);
  } catch (stubErr) {
    svcLogger.warn('[commentToDm] Public stub failed — continuing', { error: stubErr.message });
  }
}

async function sendProductPickerFlow(ctx) {
  const { interaction, organizationId, products, postId, commenterId, commenterUsername, accessToken, pageId, connType } = ctx;
  const selectionToken = nanoid(24);
  const candidateProductIds = products.map(p => p._id);

  svcLogger.info('[commentToDm] Sending product picker DM', {
    postId,
    productCount: products.length,
    selectionToken
  });

  try {
    if (products.length > MAX_PICKER_ELEMENTS) {
      const text = buildNumberedPickerText(products, commenterUsername);
      await instagramService.sendPrivateReply(interaction.platformId, text, accessToken, pageId, connType);
    } else {
      const elements = buildProductPickerElements(products, selectionToken);
      await instagramService.sendPrivateReplyGenericTemplate(
        interaction.platformId,
        elements,
        accessToken,
        pageId,
        connType
      );
    }
  } catch (pickerErr) {
    svcLogger.warn('[commentToDm] Product picker DM failed — numbered text fallback', { error: pickerErr.message });
    const text = buildNumberedPickerText(products, commenterUsername);
    try {
      await instagramService.sendPrivateReply(interaction.platformId, text, accessToken, pageId, connType);
    } catch (prErr) {
      await instagramService.sendMessage(String(commenterId), text, accessToken, pageId, false, connType);
    }
  }

  await SalesConversationState.findOneAndUpdate(
    { organization: organizationId, instagramUserId: String(commenterId), postId: String(postId) },
    {
      $set: {
        stage: 'awaiting_product_selection',
        selectionToken,
        candidateProductIds,
        commentInteractionId: interaction._id,
        productOrderId: null,
        lastStageAt: new Date(),
        whatsappNumber: null
      }
    },
    { upsert: true, new: true }
  );
}

async function sendSingleProductFlow(ctx) {
  const { interaction, organizationId, product, postId, commenterId, commenterUsername, accessToken, pageId, connType, orgDoc } = ctx;
  const sfSettings = orgDoc.salesFlowSettings || {};
  const orderToken = nanoid(24);

  await sendProductCtaDm({
    recipientMode: 'comment',
    commentId: interaction.platformId,
    instagramUserId: String(commenterId),
    commenterUsername,
    product,
    sfSettings,
    orderToken,
    accessToken,
    pageId,
    connType
  });

  const productOrder = await ProductOrder.create({
    organization: organizationId,
    product: product._id,
    instagramUserId: String(commenterId),
    instagramPostId: String(postId),
    commentInteractionId: interaction._id,
    orderToken,
    status: 'dm_sent'
  });

  await SalesConversationState.findOneAndUpdate(
    { organization: organizationId, instagramUserId: String(commenterId), postId: String(postId) },
    {
      $set: {
        productOrderId: productOrder._id,
        stage: 'initial_cta_sent',
        selectionToken: null,
        candidateProductIds: [],
        commentInteractionId: interaction._id,
        lastStageAt: new Date(),
        whatsappNumber: null
      }
    },
    { upsert: true, new: true }
  );
}

/**
 * Send product CTA after user picks from multi-product carousel picker.
 * Called from salesConversationService.
 */
async function completeProductSelection({
  organizationId,
  instagramUserId,
  postId,
  productId,
  selectionToken,
  platformConnectionId
}) {
  const state = await SalesConversationState.findOne({
    organization: organizationId,
    instagramUserId: String(instagramUserId),
    postId: String(postId),
    stage: 'awaiting_product_selection',
    selectionToken: String(selectionToken)
  });

  if (!state) {
    svcLogger.warn('[commentToDm] completeProductSelection — state not found', { instagramUserId, postId });
    return { ok: false, reason: 'invalid_state' };
  }

  const allowed = (state.candidateProductIds || []).map(id => String(id));
  if (!allowed.includes(String(productId))) {
    svcLogger.warn('[commentToDm] completeProductSelection — product not in candidates', { productId });
    return { ok: false, reason: 'invalid_product' };
  }

  const product = await Product.findOne({
    _id: productId,
    organization: organizationId,
    isActive: true
  }).lean();

  if (!product) {
    return { ok: false, reason: 'product_not_found' };
  }

  const orgDoc = await Organization.findById(organizationId).select('salesFlowSettings');
  const conn = await resolveConnection({ platformConnection: platformConnectionId }, organizationId);
  if (!conn) return { ok: false, reason: 'no_connection' };

  const { accessToken, pageId, connType } = connectionContext(conn);
  const orderToken = nanoid(24);

  const productOrder = await ProductOrder.create({
    organization: organizationId,
    product: product._id,
    instagramUserId: String(instagramUserId),
    instagramPostId: String(postId),
    commentInteractionId: state.commentInteractionId,
    orderToken,
    status: 'dm_sent'
  });

  await sendProductCtaDm({
    recipientMode: 'user',
    instagramUserId: String(instagramUserId),
    product,
    sfSettings: orgDoc?.salesFlowSettings || {},
    orderToken,
    accessToken,
    pageId,
    connType
  });

  state.productOrderId = productOrder._id;
  state.stage = 'initial_cta_sent';
  state.selectionToken = null;
  state.candidateProductIds = [];
  state.lastStageAt = new Date();
  await state.save();

  svcLogger.info('[commentToDm] Product selection completed', { instagramUserId, productId: product._id, postId });
  return { ok: true, productOrderId: productOrder._id };
}

/**
 * @returns {{ productOrder: object }}
 */
async function sendProductCtaDm({
  recipientMode,
  commentId,
  instagramUserId,
  commenterUsername = '',
  product,
  sfSettings,
  orderToken,
  accessToken,
  pageId,
  connType
}) {
  const effectiveDmConfig = buildEffectiveDmConfig(product, sfSettings);
  const paymentUrlWithToken = product.paymentUrl
    ? `${product.paymentUrl}${product.paymentUrl.includes('?') ? '&' : '?'}ref=${orderToken}`
    : '';

  const element = buildProductCtaElement(product, effectiveDmConfig, orderToken, paymentUrlWithToken);
  const teaser = `Hi${commenterUsername ? ' @' + commenterUsername : ''}! 👋 Thanks for your interest.\n\nReply with "details" for more info, or "buy" to order. 🛍️`;

  if (element) {
    try {
      if (recipientMode === 'comment' && commentId) {
        await instagramService.sendPrivateReplyGenericTemplate(commentId, element, accessToken, pageId, connType);
      } else {
        await instagramService.sendGenericTemplateMessage(instagramUserId, element, accessToken, pageId, connType);
      }
    } catch (gtErr) {
      svcLogger.warn('[commentToDm] CTA template failed — teaser fallback', { error: gtErr.message });
      if (recipientMode === 'comment' && commentId) {
        try {
          await instagramService.sendPrivateReply(commentId, teaser, accessToken, pageId, connType);
        } catch {
          await instagramService.sendMessage(instagramUserId, teaser, accessToken, pageId, false, connType);
        }
      } else {
        await instagramService.sendMessage(instagramUserId, teaser, accessToken, pageId, false, connType);
      }
    }
  } else {
    if (recipientMode === 'comment' && commentId) {
      try {
        await instagramService.sendPrivateReply(commentId, teaser, accessToken, pageId, connType);
      } catch {
        await instagramService.sendMessage(instagramUserId, teaser, accessToken, pageId, false, connType);
      }
    } else {
      await instagramService.sendMessage(instagramUserId, teaser, accessToken, pageId, false, connType);
    }
  }

  return { productOrder: { orderToken } };
}

function buildTemplate(template, vars) {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key] ?? '') : `{{${key}}}`
  );
}

module.exports = {
  processCommentForProduct,
  completeProductSelection,
  buildTemplate,
  sendProductCtaDm
};
