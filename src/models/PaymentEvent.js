'use strict';

/**
 * PaymentEvent
 *
 * Append-only record of every provider webhook event processed for a Payment.
 * Unique index on {payment, providerEventId} makes at-least-once webhook delivery safe.
 *
 * Events are never updated — new events are always appended.
 * Used for audit, replay, and deduplication.
 */

const mongoose = require('mongoose');

const paymentEventSchema = new mongoose.Schema(
  {
    organization: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Organization',
      required: true,
      index: true
    },
    payment: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Payment',
      index: true
    },
    integration: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'PaymentIntegration'
    },

    // ── Provider event identity ─────────────────────────────────────────────
    provider: {
      type: String,
      enum: ['razorpay', 'cashfree', 'payu', 'phonepe', 'stripe'],
      required: true
    },
    /**
     * Provider's unique event ID (Razorpay: event.id, Cashfree: event header, etc.)
     * If provider doesn't supply one, we generate a deterministic hash from the payload.
     */
    providerEventId: { type: String, trim: true, required: true },
    providerEventType: { type: String, trim: true },

    // ── Internal mapping ────────────────────────────────────────────────────
    /** Normalized RepMeUp event name (e.g. payment.paid, payment.failed) */
    normalizedEvent: { type: String, trim: true },

    // ── Processing ──────────────────────────────────────────────────────────
    processed: { type: Boolean, default: false },
    processedAt: { type: Date },
    processingError: { type: String, trim: true },

    /** Raw non-sensitive fields (tokens, card data, and signatures are NOT stored) */
    safePayload: { type: mongoose.Schema.Types.Mixed },

    receivedAt: { type: Date, default: Date.now }
  },
  { timestamps: true }
);

// Idempotency: reject duplicate provider events
paymentEventSchema.index(
  { payment: 1, providerEventId: 1 },
  { unique: true, name: 'unique_provider_event_per_payment', sparse: true }
);

// Also deduplicate at integration level for events without a payment link yet
paymentEventSchema.index(
  { integration: 1, providerEventId: 1 },
  { unique: true, name: 'unique_provider_event_per_integration' }
);

paymentEventSchema.index({ organization: 1, createdAt: -1 });
paymentEventSchema.index({ normalized: 1, processedAt: 1 });

module.exports = mongoose.model('PaymentEvent', paymentEventSchema);
