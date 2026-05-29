/**
 * Instagram Story-to-DM Selling Orchestrator
 *
 * Triggers on story replies and story @mentions (Messaging webhook).
 * Passive story viewers are not available via Meta API.
 */

const Organization = require('../models/Organization');
const Product = require('../models/Product');
const ProductOrder = require('../models/ProductOrder');
const SalesConversationState = require('../models/SalesConversationState');
const StoryEngagementLog = require('../models/StoryEngagementLog');
const PlatformConnection = require('../models/PlatformConnection');
const instagramService = require('../integrations/meta/instagramService');
const logger = require('../config/logger');
const { nanoid } = require('nanoid');
const {
  sortProductsForPost,
  matchProductByCommentText,
  buildProductPickerElements,
  buildNumberedPickerText,
  filterProductsByPerProductKeywords,
  MAX_PICKER_ELEMENTS
} = require('./commentToDmProductHelpers');
const { sendProductCtaDm, createPickerPendingOrders, cancelSiblingPickerPendingOrders } = require('./commentToDmService');

const svcLogger = logger.createChild({ module: 'storyToDmService' });

/**
 * @returns {Promise<{ sent: boolean, reason?: string }>}
 */
async function processStoryEngagement(interaction, organizationId) {
  try {
    if (!interaction || interaction.platform !== 'instagram' || interaction.type !== 'dm') {
      return { sent: false, reason: 'not_dm' };
    }

    const meta = interaction.metadata || {};
    if (!meta.isStoryEngagement || !meta.storyMediaId) {
      return { sent: false, reason: 'not_story_engagement' };
    }

    const storyMediaId = String(meta.storyMediaId);
    const triggerType = meta.storyTriggerType;
    const replyText = (meta.storyReplyText || interaction.content || '').trim();

    const interactionId = interaction._id?.toString?.() || 'unknown';
    const org = await Organization.findById(organizationId)
      .select('storyToDmSettings salesFlowSettings')
      .lean();

    if (!org?.storyToDmSettings?.enabled) {
      svcLogger.info('[storyToDm] Skipping — automation disabled', { organizationId });
      return { sent: false, reason: 'disabled' };
    }

    const settings = org.storyToDmSettings;

    if (triggerType === 'story_reply' && settings.triggerOnReply === false) {
      return { sent: false, reason: 'reply_trigger_off' };
    }
    if (triggerType === 'story_mention' && settings.triggerOnMention === false) {
      return { sent: false, reason: 'mention_trigger_off' };
    }

    if (triggerType === 'story_reply') {
      const keywords = (settings.triggerKeywords || []).map(k => k.toLowerCase().trim()).filter(Boolean);
      if (keywords.length) {
        const lower = replyText.toLowerCase();
        const matched = keywords.some(kw => lower.includes(kw));
        if (!matched) {
          svcLogger.info('[storyToDm] Skipping — no keyword match on reply', { replyText: replyText.substring(0, 60) });
          return { sent: false, reason: 'no_keyword' };
        }
      }
    }

    let products = await resolveProductsForStory(organizationId, storyMediaId, settings);
    if (!products.length) {
      svcLogger.info('[storyToDm] Skipping — no product linked to story', { storyMediaId });
      return { sent: false, reason: 'no_product' };
    }

    products = sortProductsForPost(products, storyMediaId);
    if (triggerType === 'story_reply' && replyText) {
      products = filterProductsByPerProductKeywords(products, replyText.toLowerCase());
      if (!products.length) {
        svcLogger.info('[storyToDm] Skipping — per-product keyword filter', { storyMediaId });
        return { sent: false, reason: 'product_keyword_filter' };
      }
    }

    const instagramUserId = interaction.author?.platformId;
    if (!instagramUserId) {
      svcLogger.warn('[storyToDm] Skipping — no author.platformId', { interactionId });
      return { sent: false, reason: 'no_user' };
    }

    const uniqueMatch = triggerType === 'story_reply' && replyText
      ? matchProductByCommentText(products, replyText.toLowerCase())
      : null;
    const usePicker = !uniqueMatch && products.length > 1;
    const product = uniqueMatch || (products.length === 1 ? products[0] : null);

    if (!usePicker && !product) {
      return { sent: false, reason: 'ambiguous_products' };
    }

    if (settings.deduplicateDms !== false) {
      const skip = await shouldSkipDedup(organizationId, instagramUserId, storyMediaId, triggerType);
      if (skip) return { sent: false, reason: 'dedup' };
    }

    const orgDoc = await Organization.findById(organizationId).select('storyToDmSettings salesFlowSettings');
    await resetDailyCounterIfNeeded(orgDoc);

    const maxDms = orgDoc.storyToDmSettings.maxDmsPerDay || 200;
    if (orgDoc.storyToDmSettings.dmsSentToday >= maxDms) {
      svcLogger.warn('[storyToDm] Skipping — daily limit', { limit: maxDms });
      return { sent: false, reason: 'daily_limit' };
    }

    const connection = await resolveConnection(interaction, organizationId);
    if (!connection) {
      svcLogger.warn('[storyToDm] Skipping — no Instagram connection', { organizationId });
      return { sent: false, reason: 'no_connection' };
    }

    const { accessToken, pageId, connType } = connectionContext(connection);
    const username = interaction.author?.username || '';

    await sendWelcomeIfConfigured(settings, instagramUserId, username, accessToken, pageId, connType);

    if (usePicker) {
      await sendStoryProductPickerFlow({
        interaction,
        organizationId,
        products,
        storyMediaId,
        instagramUserId,
        username,
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
        storyMediaId,
        instagramUserId,
        username,
        accessToken,
        pageId,
        connType,
        orgDoc,
        triggerType
      });
    }

    orgDoc.storyToDmSettings.dmsSentToday += 1;
    await orgDoc.save();

    try {
      await StoryEngagementLog.create({
        organization: organizationId,
        instagramUserId: String(instagramUserId),
        storyMediaId,
        triggerType,
        dmInteractionId: interaction._id,
        productId: product?._id || null
      });
    } catch (logErr) {
      if (logErr.code !== 11000) {
        svcLogger.warn('[storyToDm] Log create failed', { error: logErr.message });
      }
    }

    svcLogger.info('[storyToDm] Flow completed', {
      instagramUserId,
      storyMediaId,
      mode: usePicker ? 'product_picker' : 'single_product',
      triggerType
    });

    return { sent: true };
  } catch (err) {
    svcLogger.error('[storyToDm] Unhandled error', { error: err.message, stack: err.stack });
    return { sent: false, reason: 'error' };
  }
}

async function resolveProductsForStory(organizationId, storyMediaId, settings) {
  let products = await Product.find({
    organization: organizationId,
    isActive: true,
    $or: [
      { instagramStoryIds: String(storyMediaId) },
      { instagramPostIds: String(storyMediaId) }
    ]
  }).lean();

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

async function shouldSkipDedup(organizationId, instagramUserId, storyMediaId, triggerType) {
  const logged = await StoryEngagementLog.exists({
    organization: organizationId,
    instagramUserId: String(instagramUserId),
    storyMediaId: String(storyMediaId),
    triggerType
  });
  if (logged) {
    svcLogger.info('[storyToDm] Skipping — StoryEngagementLog dedup', { instagramUserId, storyMediaId });
    return true;
  }

  const alreadySent = await ProductOrder.exists({
    organization: organizationId,
    instagramUserId: String(instagramUserId),
    instagramPostId: String(storyMediaId),
    status: { $nin: ['picker_pending', 'cancelled'] }
  });
  if (alreadySent) {
    svcLogger.info('[storyToDm] Skipping — ProductOrder dedup', { instagramUserId, storyMediaId });
    return true;
  }

  const pending = await SalesConversationState.exists({
    organization: organizationId,
    instagramUserId: String(instagramUserId),
    postId: String(storyMediaId),
    stage: { $in: ['awaiting_product_selection', 'initial_cta_sent', 'details_sent', 'payment_link_sent'] }
  });
  if (pending) {
    svcLogger.info('[storyToDm] Skipping — active sales state', { instagramUserId, storyMediaId });
    return true;
  }

  return false;
}

async function resetDailyCounterIfNeeded(orgDoc) {
  const today = new Date().toDateString();
  const resetDate = orgDoc.storyToDmSettings?.dmsSentResetDate
    ? new Date(orgDoc.storyToDmSettings.dmsSentResetDate).toDateString()
    : null;
  if (resetDate !== today) {
    orgDoc.storyToDmSettings.dmsSentToday = 0;
    orgDoc.storyToDmSettings.dmsSentResetDate = new Date();
  }
}

async function resolveConnection(interaction, organizationId) {
  return interaction.platformConnection
    ? PlatformConnection.findById(interaction.platformConnection)
        .select('accessToken platformData platformPageId platformUserId metadata').lean()
    : PlatformConnection.findOne({
        organization: organizationId,
        platform: 'instagram',
        isActive: true,
        status: { $in: ['connected', 'available'] }
      }).sort({ updatedAt: -1 }).select('accessToken platformData platformPageId platformUserId metadata').lean();
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

async function sendWelcomeIfConfigured(settings, instagramUserId, username, accessToken, pageId, connType) {
  const title = (settings.welcomeTitle || '').trim();
  const subtitle = (settings.welcomeSubtitle || '').trim();
  const imageUrl = (settings.welcomeImageUrl || '').trim();
  if (!title && !subtitle) return;

  const element = {
    title: title.slice(0, 80) || 'Hello!',
    subtitle: subtitle.slice(0, 80),
    buttons: []
  };
  if (imageUrl.startsWith('https://')) {
    element.image_url = imageUrl;
  }

  try {
    await instagramService.sendGenericTemplateMessage(
      instagramUserId,
      element,
      accessToken,
      pageId,
      connType
    );
  } catch (err) {
    const text = `Hi${username ? ' @' + username : ''}! ${title} ${subtitle}`.trim();
    try {
      await instagramService.sendMessage(instagramUserId, text, accessToken, pageId, false, connType);
    } catch (fallbackErr) {
      svcLogger.warn('[storyToDm] Welcome message failed', { error: fallbackErr.message });
    }
  }
}

async function sendStoryProductPickerFlow(ctx) {
  const {
    interaction, organizationId, products, storyMediaId, instagramUserId, username,
    accessToken, pageId, connType, orgDoc
  } = ctx;
  const sfSettings = orgDoc?.salesFlowSettings || {};
  const selectionToken = nanoid(24);
  const candidateProductIds = products.map(p => p._id);

  let orderTokensByProductId = {};
  if (products.length <= MAX_PICKER_ELEMENTS) {
    orderTokensByProductId = await createPickerPendingOrders({
      organizationId,
      products,
      postId: storyMediaId,
      commenterId: instagramUserId,
      commentInteractionId: interaction._id
    });
  }

  try {
    if (products.length > MAX_PICKER_ELEMENTS) {
      const text = buildNumberedPickerText(products, username);
      await instagramService.sendMessage(instagramUserId, text, accessToken, pageId, false, connType);
    } else {
      const elements = buildProductPickerElements(
        products,
        selectionToken,
        sfSettings,
        orderTokensByProductId
      );
      await instagramService.sendGenericTemplateMessage(instagramUserId, elements, accessToken, pageId, connType);
    }
  } catch (pickerErr) {
    svcLogger.warn('[storyToDm] Picker failed — text fallback', { error: pickerErr.message });
    await cancelSiblingPickerPendingOrders({
      organizationId,
      instagramUserId,
      instagramPostId: storyMediaId
    });
    const text = buildNumberedPickerText(products, username);
    await instagramService.sendMessage(instagramUserId, text, accessToken, pageId, false, connType);
  }

  await SalesConversationState.findOneAndUpdate(
    { organization: organizationId, instagramUserId: String(instagramUserId), postId: String(storyMediaId) },
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
  const {
    interaction, organizationId, product, storyMediaId, instagramUserId, username,
    accessToken, pageId, connType, orgDoc
  } = ctx;
  const sfSettings = orgDoc.salesFlowSettings || {};
  const orderToken = nanoid(24);

  await sendProductCtaDm({
    recipientMode: 'user',
    instagramUserId: String(instagramUserId),
    commenterUsername: username,
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
    instagramUserId: String(instagramUserId),
    instagramPostId: String(storyMediaId),
    commentInteractionId: interaction._id,
    orderToken,
    status: 'dm_sent'
  });

  await SalesConversationState.findOneAndUpdate(
    { organization: organizationId, instagramUserId: String(instagramUserId), postId: String(storyMediaId) },
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

module.exports = {
  processStoryEngagement,
  resolveProductsForStory
};
