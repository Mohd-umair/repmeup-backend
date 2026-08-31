'use strict';

/**
 * PaymentFulfilmentService
 *
 * Atomically processes verified provider webhook events:
 *   1. Deduplicate (PaymentEvent unique index)
 *   2. Resolve Payment by provider IDs
 *   3. Apply state machine transition
 *   4. Update CommerceOrder status
 *   5. Append order timeline
 *   6. Emit socket notification to org
 *   7. Queue channel confirmation message
 *
 * All DB mutations are idempotent — running the same event twice is safe.
 */

const mongoose = require('mongoose');

const Payment = require('../../models/Payment');
const PaymentEvent = require('../../models/PaymentEvent');
const PaymentAttempt = require('../../models/PaymentAttempt');
const Refund = require('../../models/Refund');
const CommerceOrder = require('../../models/CommerceOrder');
const stateMachine = require('./paymentStateMachine');
const logger = require('../../config/logger');

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Process a verified, parsed webhook event.
 *
 * @param {object} params
 * @param {string} params.integrationId    - PaymentIntegration._id
 * @param {string} params.organizationId   - tenant id
 * @param {object} params.mappedEvent      - MappedEventDTO from adapter.mapWebhookEvent
 * @returns {Promise<{ payment: object|null, alreadyProcessed: boolean }>}
 */
async function processEvent({ integrationId, organizationId, mappedEvent }) {
  const {
    providerEventId,
    providerEventType,
    normalizedEvent,
    providerPaymentId,
    providerOrderId,
    amount,
    currency,
    errorCode,
    errorDescription,
    safePayload
  } = mappedEvent;

  // ── Step 1: Deduplicate event ─────────────────────────────────────────────
  // Find or create the PaymentEvent. findOne first to avoid throwing on 11000.
  const existingEvent = await PaymentEvent.findOne({
    integration: integrationId,
    providerEventId
  }).lean();

  if (existingEvent?.processed) {
    logger.info('[Fulfilment] Duplicate event already processed — skipping', {
      providerEventId,
      normalizedEvent
    });
    return { payment: null, alreadyProcessed: true };
  }

  // ── Step 2: Resolve Payment ───────────────────────────────────────────────
  let payment = null;

  if (providerOrderId) {
    payment = await Payment.findOne({
      organization: organizationId,
      providerOrderId,
      integration: integrationId
    });
  }

  if (!payment && providerPaymentId) {
    payment = await Payment.findOne({
      organization: organizationId,
      providerPaymentId,
      integration: integrationId
    });
  }

  // Persist event record (upsert — idempotent)
  let eventDoc;
  try {
    eventDoc = await PaymentEvent.findOneAndUpdate(
      { integration: integrationId, providerEventId },
      {
        $setOnInsert: {
          organization: organizationId,
          payment: payment?._id || null,
          integration: integrationId,
          provider: payment?.provider || (await _providerFromIntegration(integrationId)),
          providerEventId,
          providerEventType,
          normalizedEvent,
          safePayload,
          receivedAt: new Date()
        }
      },
      { upsert: true, new: true }
    );
  } catch (err) {
    if (err.code === 11000) {
      logger.info('[Fulfilment] Event record exists (race) — skipping', { providerEventId });
      return { payment: null, alreadyProcessed: true };
    }
    throw err;
  }

  if (!payment) {
    logger.warn('[Fulfilment] No Payment found for event — orphan event persisted', {
      providerEventId,
      providerOrderId,
      providerPaymentId,
      organizationId
    });
    // Mark event as processed (with error note) so we don't reprocess
    await PaymentEvent.updateOne(
      { _id: eventDoc._id },
      { $set: { processed: true, processedAt: new Date(), processingError: 'orphan_no_payment_found' } }
    );
    return { payment: null, alreadyProcessed: false };
  }

  // ── Step 3: Determine target status ──────────────────────────────────────
  const targetStatus = _normalizedEventToStatus(normalizedEvent);
  if (!targetStatus) {
    logger.info('[Fulfilment] Unactionable event type — marking processed without status change', {
      normalizedEvent,
      paymentId: String(payment._id)
    });
    await PaymentEvent.updateOne(
      { _id: eventDoc._id },
      { $set: { payment: payment._id, processed: true, processedAt: new Date() } }
    );
    return { payment: payment.toObject(), alreadyProcessed: false };
  }

  if (!stateMachine.canTransition(payment.status, targetStatus)) {
    logger.info('[Fulfilment] Transition not allowed — idempotent skip', {
      from: payment.status,
      to: targetStatus,
      paymentId: String(payment._id)
    });
    await PaymentEvent.updateOne(
      { _id: eventDoc._id },
      { $set: { payment: payment._id, processed: true, processedAt: new Date() } }
    );
    return { payment: payment.toObject(), alreadyProcessed: true };
  }

  // ── Step 4: Atomic payment status update ─────────────────────────────────
  const tsField = stateMachine.timestampFieldFor(targetStatus);
  const paymentUpdate = {
    $set: {
      status: targetStatus,
      ...(providerPaymentId ? { providerPaymentId } : {}),
      ...(tsField ? { [tsField]: new Date() } : {})
    }
  };

  // Append attempt record for paid/failed/authorized
  if (['paid', 'failed', 'authorized'].includes(targetStatus)) {
    PaymentAttempt.create({
      organization: organizationId,
      payment: payment._id,
      providerPaymentId,
      providerOrderId,
      status: targetStatus === 'paid' ? 'paid' : targetStatus === 'authorized' ? 'authorized' : 'failed',
      amount: amount || payment.amount,
      currency: currency || payment.currency,
      errorCode: errorCode || null,
      errorDescription: errorDescription || null,
      completedAt: new Date()
    }).catch(err => logger.warn('[Fulfilment] PaymentAttempt create failed', { error: err.message }));
  }

  const updatedPayment = await Payment.findOneAndUpdate(
    { _id: payment._id, organization: organizationId, status: payment.status },
    paymentUpdate,
    { new: true }
  );

  if (!updatedPayment) {
    logger.info('[Fulfilment] Payment status already moved (concurrent) — skipping', {
      paymentId: String(payment._id)
    });
    await PaymentEvent.updateOne(
      { _id: eventDoc._id },
      { $set: { payment: payment._id, processed: true, processedAt: new Date() } }
    );
    return { payment: payment.toObject(), alreadyProcessed: true };
  }

  logger.info('[Fulfilment] Payment status updated', {
    paymentId: String(updatedPayment._id),
    from: payment.status,
    to: targetStatus,
    organizationId
  });

  // ── Step 5: Update CommerceOrder ──────────────────────────────────────────
  if (updatedPayment.order) {
    await _updateCommerceOrder(updatedPayment, targetStatus, providerPaymentId);
  }

  // ── Step 6: Mark event processed ─────────────────────────────────────────
  await PaymentEvent.updateOne(
    { _id: eventDoc._id },
    { $set: { payment: updatedPayment._id, processed: true, processedAt: new Date() } }
  );

  // ── Step 7: Realtime notification (non-blocking) ──────────────────────────
  _emitRealtimeUpdate(organizationId, updatedPayment, targetStatus).catch(err =>
    logger.warn('[Fulfilment] Socket emit failed', { error: err.message })
  );

  // ── Step 8: Queue channel confirmation (non-blocking) ────────────────────
  if (targetStatus === 'paid') {
    _queueChannelConfirmation(updatedPayment).catch(err =>
      logger.warn('[Fulfilment] Channel confirmation queue failed', { error: err.message })
    );
  }

  return { payment: updatedPayment.toObject(), alreadyProcessed: false };
}

// ── Private helpers ───────────────────────────────────────────────────────────

function _normalizedEventToStatus(normalizedEvent) {
  const map = {
    'payment.authorized': 'authorized',
    'payment.paid': 'paid',
    'payment.captured': 'paid',
    'payment.failed': 'failed',
    'payment.expired': 'expired',
    'payment.cancelled': 'cancelled',
    'refund.processed': null,
    'refund.failed': null
  };
  return map[normalizedEvent] || null;
}

async function _providerFromIntegration(integrationId) {
  try {
    const PaymentIntegration = require('../../models/PaymentIntegration');
    const intg = await PaymentIntegration.findById(integrationId).select('provider').lean();
    return intg?.provider || 'unknown';
  } catch {
    return 'unknown';
  }
}

async function _updateCommerceOrder(payment, targetStatus, providerPaymentId) {
  try {
    let orderStatus = null;
    if (targetStatus === 'paid') orderStatus = 'paid';
    else if (targetStatus === 'failed' || targetStatus === 'expired' || targetStatus === 'cancelled') {
      orderStatus = 'payment_pending';
    }

    if (!orderStatus) return;

    const historyEntry = {
      status: orderStatus,
      at: new Date(),
      note: `Payment ${targetStatus} (ref: ${providerPaymentId || payment.providerOrderId || 'unknown'})`
    };

    const update = {
      $push: { statusHistory: historyEntry }
    };

    if (targetStatus === 'paid') {
      update.$set = {
        status: 'paid',
        paymentRef: providerPaymentId || payment.providerOrderId,
        paymentMethod: payment.provider,
        paidAt: new Date()
      };
    }

    await CommerceOrder.findOneAndUpdate(
      { _id: payment.order, organization: payment.organization },
      update
    );
  } catch (err) {
    logger.error('[Fulfilment] CommerceOrder update failed', { error: err.message, orderId: String(payment.order) });
  }
}

async function _emitRealtimeUpdate(organizationId, payment, status) {
  const socketEmitter = require('../../utils/socketEmitter');
  socketEmitter.emitToOrg(String(organizationId), 'payment:status_update', {
    paymentId: String(payment._id),
    orderId: String(payment.order),
    status,
    amount: payment.amount,
    currency: payment.currency
  });
}

async function _queueChannelConfirmation(payment) {
  const { paymentWebhookQueue } = require('../../config/queue');
  await paymentWebhookQueue.add(
    'payment-confirmation-channel',
    {
      type: 'payment_paid_channel_confirmation',
      paymentId: String(payment._id),
      organizationId: String(payment.organization),
      orderId: String(payment.order),
      contactId: payment.contact ? String(payment.contact) : null,
      channel: payment.channel,
      interactionId: payment.interaction ? String(payment.interaction) : null,
      amount: payment.amount,
      currency: payment.currency,
      provider: payment.provider
    },
    { attempts: 3, backoff: { type: 'exponential', delay: 3000 }, removeOnComplete: 50, removeOnFail: 100 }
  );
}

module.exports = { processEvent };
