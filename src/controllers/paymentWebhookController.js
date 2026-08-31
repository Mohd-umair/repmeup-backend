'use strict';

/**
 * Payment Webhook Controller
 *
 * Handles incoming provider webhook events.
 * Pattern: verify signature → deduplicate → ACK → queue fulfilment
 *
 * Never returns tenant information on verification failure.
 */

const logger = require('../config/logger');

// ── Razorpay ──────────────────────────────────────────────────────────────────

/**
 * POST /api/webhooks/payments/razorpay/:endpointToken
 * Raw body must be Buffer at this point (mounted before express.json in app.js).
 */
exports.handleRazorpayWebhook = async (req, res) => {
  // ACK immediately — Razorpay retries within seconds if we don't respond fast
  res.sendStatus(200);

  const { endpointToken } = req.params;
  if (!endpointToken) return;

  try {
    const PaymentIntegration = require('../models/PaymentIntegration');
    const { paymentWebhookQueue } = require('../config/queue');

    // Resolve integration by opaque endpoint token
    const integration = await PaymentIntegration.findOne({
      webhookEndpointToken: endpointToken,
      provider: 'razorpay',
      status: 'connected'
    }).lean();

    if (!integration) {
      logger.warn('[PaymentWebhook:razorpay] Unknown endpoint token — rejected silently');
      return;
    }

    // Verify signature before touching any business state
    const { decryptFields } = require('../utils/paymentSecretCipher');
    const envelopeRaw = integration.credentialEnvelope || {};
    const envelope = typeof envelopeRaw.toObject === 'function' ? envelopeRaw.toObject() : { ...envelopeRaw };
    const credentials = decryptFields(envelope);

    const razorpayAdapter = require('../services/payments/adapters/razorpayAdapter');
    const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || '');

    const signatureValid = razorpayAdapter.verifyWebhookSignature({
      rawBody,
      headers: req.headers,
      credentials
    });

    if (!signatureValid) {
      logger.warn('[PaymentWebhook:razorpay] Signature verification failed', {
        integrationId: String(integration._id),
        organizationId: String(integration.organization)
      });
      return;
    }

    // Parse event
    let rawEvent;
    try {
      rawEvent = JSON.parse(rawBody.toString('utf8'));
    } catch {
      logger.warn('[PaymentWebhook:razorpay] Could not parse JSON body');
      return;
    }

    const eventType = rawEvent?.event;
    if (!eventType) {
      logger.warn('[PaymentWebhook:razorpay] Missing event type in payload');
      return;
    }

    // Map to normalized DTO — sanitized, no tokens/secrets in queue payload
    const mappedEvent = razorpayAdapter.mapWebhookEvent(rawEvent, eventType);

    logger.info('[PaymentWebhook:razorpay] Verified event queued for fulfilment', {
      eventType,
      normalizedEvent: mappedEvent.normalizedEvent,
      providerEventId: mappedEvent.providerEventId,
      organizationId: String(integration.organization)
    });

    // Queue fulfilment — fast async, does not block ACK
    await paymentWebhookQueue.add(
      'payment-webhook-event',
      {
        type: 'provider_webhook_event',
        provider: 'razorpay',
        integrationId: String(integration._id),
        organizationId: String(integration.organization),
        mappedEvent
      },
      { attempts: 5, backoff: { type: 'exponential', delay: 2000 }, removeOnComplete: 100, removeOnFail: 200 }
    );

    // Update webhook health stats (non-blocking)
    PaymentIntegration.updateOne(
      { _id: integration._id },
      { $set: { lastWebhookReceivedAt: new Date() }, $inc: { webhookFailureCount: 0 } }
    ).catch(() => {});
  } catch (err) {
    logger.error('[PaymentWebhook:razorpay] Handler error', { error: err.message });
  }
};
