'use strict';

/**
 * processPaymentWebhook job
 *
 * Handles async work that should not block the webhook ACK:
 *   - product_payment_confirmation  → send Instagram DM to buyer after legacy payment
 *
 * Future job types (Phase 2+):
 *   - payment_webhook_event → verify + deduplicate provider events, run fulfilment
 */

const logger = require('../config/logger');

async function processPaymentWebhook(job) {
  const { type } = job.data || {};

  if (type === 'product_payment_confirmation') {
    return _sendProductPaymentConfirmationDm(job);
  }

  if (type === 'provider_webhook_event') {
    return _processProviderWebhookEvent(job);
  }

  if (type === 'payment_paid_channel_confirmation') {
    return _sendPaidChannelConfirmation(job);
  }

  logger.warn('[processPaymentWebhook] unknown job type', { type, jobId: job.id });
}

// ── Product payment confirmation DM ──────────────────────────────────────────

async function _sendProductPaymentConfirmationDm(job) {
  const { productOrderId, organizationId, instagramUserId, productName } = job.data || {};

  if (!instagramUserId) {
    logger.warn('[ProductPaymentDM] No instagramUserId — skipping DM', { productOrderId });
    return;
  }

  const PlatformConnection = require('../models/PlatformConnection');
  const Organization = require('../models/Organization');
  const commentToDmService = require('../services/commentToDmService');

  const org = await Organization.findById(organizationId).select('commentToDmSettings').lean();
  const template =
    org?.commentToDmSettings?.confirmationTemplate ||
    "Hi! \uD83C\uDF89 Your order for *{{product_name}}* has been confirmed! We\u2019ll be in touch with shipping details soon. Thank you! \uD83D\uDE4F";

  const dmText = commentToDmService.buildTemplate(template, {
    product_name: productName || 'your order',
    username: 'there'
  });

  const conn = await PlatformConnection.findOne({
    organization: organizationId,
    platform: 'instagram',
    isActive: true
  })
    .select('accessToken platformData platformPageId platformUserId metadata')
    .lean();

  if (!conn) {
    logger.warn('[ProductPaymentDM] No Instagram connection for org', { organizationId });
    return;
  }

  const accessToken = conn.accessToken;
  const connType =
    conn.metadata?.connectionType ||
    (typeof conn.accessToken === 'string' && conn.accessToken.startsWith('IGAA') ? 'instagram_login' : null);
  const pageId =
    connType === 'instagram_login'
      ? conn.metadata?.igLoginScopedId || conn.platformUserId
      : conn.platformData?.pageId || conn.platformPageId || conn.platformUserId;

  try {
    await require('../integrations/meta/instagramService').sendMessage(
      instagramUserId,
      dmText,
      accessToken,
      pageId,
      false,
      connType
    );
    logger.info('[ProductPaymentDM] Confirmation DM sent', { instagramUserId, organizationId });
  } catch (err) {
    logger.error('[ProductPaymentDM] Failed to send DM', { instagramUserId, error: err.message });
    throw err;
  }
}

module.exports = processPaymentWebhook;

// ── Provider webhook event fulfilment ────────────────────────────────────────

async function _processProviderWebhookEvent(job) {
  const { integrationId, organizationId, mappedEvent } = job.data || {};
  const paymentFulfilmentService = require('../services/payments/paymentFulfilmentService');
  const result = await paymentFulfilmentService.processEvent({
    integrationId,
    organizationId,
    mappedEvent
  });
  logger.info('[processPaymentWebhook] Provider event processed', {
    paymentId: result.payment ? String(result.payment._id) : null,
    alreadyProcessed: result.alreadyProcessed
  });
}

// ── Paid channel confirmation ─────────────────────────────────────────────────

async function _sendPaidChannelConfirmation(job) {
  const { paymentId, organizationId, orderId, channel, interactionId, amount, currency } = job.data || {};
  logger.info('[processPaymentWebhook] Payment paid — channel confirmation queued', {
    paymentId,
    channel,
    organizationId
  });
}
