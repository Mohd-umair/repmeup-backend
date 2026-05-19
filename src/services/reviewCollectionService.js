/**
 * Review Collection Service
 * Enqueue and send review requests.
 */
const ReviewRequest = require('../models/ReviewRequest');
const ReviewRequestSettings = require('../models/ReviewRequestSettings');
const logger = require('../config/logger');

/**
 * Enqueue a review request for a given order or interaction.
 * Called from the ProductOrder 'delivered' event.
 */
exports.enqueueRequest = async ({ orgId, orderId, interactionId, contactId, channel }) => {
  try {
    const settings = await ReviewRequestSettings.findOne({ organization: orgId, enabled: true }).lean();
    if (!settings) return null;

    // Skip if a request was recently sent to this contact
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

    const delayMs = (settings.delayDays || 0) * 86400000;
    const sendAfter = new Date(Date.now() + delayMs);

    const request = await ReviewRequest.create({
      organization: orgId,
      contact: contactId,
      orderId,
      interactionId,
      channel: channel || settings.channels?.[0] || 'whatsapp',
      status: 'pending',
      nextReminderAt: sendAfter
    });

    logger.info('[reviewCollectionService] Enqueued review request', { requestId: request._id });
    return request;
  } catch (err) {
    logger.error('[reviewCollectionService] enqueueRequest error', { error: err.message });
    return null;
  }
};

/**
 * Send a pending review request.
 * Called by the BullMQ worker.
 */
exports.sendRequest = async (requestId) => {
  try {
    const request = await ReviewRequest.findById(requestId).lean();
    if (!request || request.status !== 'pending') return;

    const settings = await ReviewRequestSettings.findOne({ organization: request.organization, enabled: true }).lean();
    if (!settings) {
      await ReviewRequest.findByIdAndUpdate(requestId, { status: 'skipped' });
      return;
    }

    // Build message — replace template tokens
    let message = settings.message || 'Thanks for your purchase! Please leave us a review: {{review_link}}';
    const activePlatform = settings.platforms?.find(p => p.active);
    const reviewUrl = activePlatform?.url || '';
    message = message.replace(/{{review_link}}/g, reviewUrl);

    // Dispatch via channel
    if (request.channel === 'whatsapp') {
      // Placeholder: call whatsappService.sendTextMessage in full integration
      logger.info('[reviewCollectionService] Would send WhatsApp review request', { requestId });
    } else if (request.channel === 'email') {
      logger.info('[reviewCollectionService] Would send Email review request', { requestId });
    }

    await ReviewRequest.findByIdAndUpdate(requestId, {
      status: 'sent',
      sentAt: new Date(),
      messageSent: message
    });
  } catch (err) {
    logger.error('[reviewCollectionService] sendRequest error', { error: err.message, requestId });
    await ReviewRequest.findByIdAndUpdate(requestId, { status: 'failed', errorMessage: err.message }).catch(() => {});
  }
};
