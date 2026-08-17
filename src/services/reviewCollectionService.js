/**
 * Review Collection Service
 * Enqueue and send WhatsApp review request flows.
 */
const crypto = require('crypto');
const ReviewRequest = require('../models/ReviewRequest');
const ReviewRequestSettings = require('../models/ReviewRequestSettings');
const WhatsAppFormFlow = require('../models/WhatsAppFormFlow');
const PlatformConnection = require('../models/PlatformConnection');
const Interaction = require('../models/Interaction');
const entitlementsService = require('./entitlementsService');
const whatsappService = require('../integrations/whatsapp/whatsappService');
const escalationService = require('./escalationService');
const logger = require('../config/logger');

/**
 * Enqueue a review request via BullMQ.
 * Called from order-delivered hooks.
 * Non-blocking and non-throwing — failures are logged but don't wedge the order.
 */
exports.enqueueRequest = async (queue, { orgId, orderId, interactionId, contactId, channel = 'whatsapp' }) => {
  try {
    const settings = await ReviewRequestSettings.findOne({ organization: orgId, enabled: true }).lean();
    if (!settings) {
      logger.info('[reviewCollectionService] Review requests disabled for org', { orgId });
      return null;
    }

    const entitled = await entitlementsService.can(orgId.toString(), 'whatsapp.flows.enabled');
    if (!entitled) {
      logger.info('[reviewCollectionService] Org not entitled to WhatsApp flows', { orgId });
      return null;
    }

    if (settings.excludeRecentReviewers && contactId) {
      const recentWindowMs = (settings.recentReviewerDays || 90) * 86400000;
      const recent = await ReviewRequest.findOne({
        organization: orgId,
        contact: contactId,
        sentAt: { $gte: new Date(Date.now() - recentWindowMs) }
      }).lean();
      if (recent) {
        logger.info('[reviewCollectionService] Skipping recent reviewer', { contactId });
        return null;
      }
    }

    const request = await ReviewRequest.create({
      organization: orgId,
      contact: contactId,
      orderId,
      interactionId,
      channel,
      status: 'pending'
    });

    const delayMs = (settings.delayDays || 0) * 86400000;
    await queue.add('send-review', { requestId: request._id.toString() }, {
      delay: delayMs,
      attempts: 2,
      backoff: { type: 'exponential', delay: 2000 }
    });

    logger.info('[reviewCollectionService] Enqueued review request', { requestId: request._id, delayDays: settings.delayDays });
    return request;
  } catch (err) {
    logger.error('[reviewCollectionService] enqueueRequest error', { error: err.message, orgId });
    return null;
  }
};

/**
 * Send a pending review request flow.
 * Called by BullMQ reviewRequestQueue processor.
 */
exports.sendRequest = async (requestId) => {
  try {
    const request = await ReviewRequest.findById(requestId)
      .populate('organization')
      .populate('contact')
      .populate('interactionId');

    if (!request || request.status !== 'pending') {
      logger.info('[reviewCollectionService] Request not pending', { requestId, status: request?.status });
      return;
    }

    const orgId = request.organization._id;
    const settings = await ReviewRequestSettings.findOne({ organization: orgId, enabled: true })
      .populate('whatsappFormFlow');

    if (!settings || !settings.whatsappFormFlow) {
      logger.info('[reviewCollectionService] No active flow configured', { requestId, orgId });
      await ReviewRequest.findByIdAndUpdate(requestId, { status: 'skipped', errorMessage: 'No flow configured' });
      return;
    }

    if (request.channel === 'whatsapp') {
      await sendWhatsAppFlow(request, settings);
    } else {
      logger.warn('[reviewCollectionService] Unsupported channel for flow sends', { channel: request.channel });
      await ReviewRequest.findByIdAndUpdate(requestId, { status: 'skipped', errorMessage: `Unsupported channel: ${request.channel}` });
    }
  } catch (err) {
    logger.error('[reviewCollectionService] sendRequest error', { error: err.message, requestId });
    await ReviewRequest.findByIdAndUpdate(requestId, {
      status: 'failed',
      errorMessage: err.message
    }).catch(() => {});
  }
};

/**
 * Send a WhatsApp review flow to a contact.
 * Chooses session vs template mode based on message recency.
 */
async function sendWhatsAppFlow(request, settings) {
  const { organization, contact, interactionId } = request;
  const flow = settings.whatsappFormFlow;

  if (!flow.metaFlowId || flow.status !== 'published') {
    throw new Error('Flow not published or missing Meta ID');
  }

  const connection = await PlatformConnection.findOne({
    organization: organization._id,
    platform: 'whatsapp',
    isActive: true
  }).lean();

  if (!connection) {
    throw new Error('WhatsApp connection not configured');
  }

  if (!contact.platformUserId) {
    throw new Error('Contact missing WhatsApp phone number');
  }

  const flowToken = crypto.randomUUID();
  const phoneNumber = contact.platformUserId;

  let sendMode = 'template';
  if (interactionId) {
    const interaction = await Interaction.findById(interactionId).lean();
    if (interaction && interaction.createdAt) {
      const hoursSinceLastMessage = (Date.now() - interaction.createdAt.getTime()) / (1000 * 3600);
      if (hoursSinceLastMessage < 24) {
        sendMode = 'session';
      }
    }
  }

  const sendOpts = {
    flowId: flow.metaFlowId,
    flowToken,
    flowCta: 'Share Feedback',
    mode: sendMode,
    templateId: flow.messageTemplateId
  };

  const result = await whatsappService.sendFlowMessage(connection, phoneNumber, sendOpts);

  await ReviewRequest.findByIdAndUpdate(request._id, {
    status: 'sent',
    sentAt: new Date(),
    whatsappFlowToken: flowToken,
    messageSent: `Flow ${flow.name} (mode: ${sendMode})`
  });

  logger.info('[reviewCollectionService] Sent review flow', {
    requestId: request._id,
    mode: sendMode,
    messageId: result.messageId
  });
}

/**
 * Manually trigger a review request send (e.g. from support dashboard).
 */
exports.sendNow = async (requestId) => {
  try {
    await ReviewRequest.findByIdAndUpdate(requestId, { status: 'pending' });
    await exports.sendRequest(requestId);
    return true;
  } catch (err) {
    logger.error('[reviewCollectionService] sendNow error', { error: err.message, requestId });
    throw err;
  }
};

/**
 * Process a flow response (nfm_reply webhook payload).
 * Updates the ReviewRequest with rating/comment and escalates if needed.
 */
exports.processFlowResponse = async (orgId, flowToken, flowResponse) => {
  try {
    const request = await ReviewRequest.findOne({
      organization: orgId,
      whatsappFlowToken: flowToken,
      status: 'sent'
    }).populate('interactionId');

    if (!request) {
      logger.warn('[reviewCollectionService] No request matched flow token', { flowToken });
      return null;
    }

    const rating = parseInt(flowResponse?.rating) || 0;
    const comment = flowResponse?.comment || '';

    await ReviewRequest.findByIdAndUpdate(request._id, {
      rating,
      comment,
      status: 'reviewed',
      reviewSubmittedAt: new Date()
    });

    // rating is 0 when the payload is malformed — escalating on that would raise
    // a false alarm, so only a genuine low score counts.
    if (rating > 0 && rating <= 2 && request.interactionId) {
      const interaction = await Interaction.findById(request.interactionId);
      if (interaction) {
        try {
          await escalationService.escalateInteraction(
            interaction,
            request.organization,
            ['low_rating_review'],
            'review_negative',
            { rating, comment }
          );
          logger.info('[reviewCollectionService] Escalated low rating', { requestId: request._id, rating });
        } catch (escErr) {
          logger.warn('[reviewCollectionService] Escalation failed (non-fatal)', { error: escErr.message });
        }
      }
    }

    return request;
  } catch (err) {
    logger.error('[reviewCollectionService] processFlowResponse error', { error: err.message });
    return null;
  }
};
