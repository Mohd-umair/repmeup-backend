'use strict';

/**
 * PaymentAttempt
 *
 * Append-only ledger of individual payment attempts for a Payment.
 * Each time a customer clicks pay, a new attempt is recorded.
 * Multiple attempts may exist for one Payment (link resent, payment failed and retried).
 *
 * These are never deleted or updated — status always moves forward.
 */

const mongoose = require('mongoose');

const paymentAttemptSchema = new mongoose.Schema(
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
      required: true,
      index: true
    },

    // ── Provider identifiers ────────────────────────────────────────────────
    /** Provider-assigned payment/transaction ID for this specific attempt */
    providerPaymentId: { type: String, trim: true },
    /** Provider-assigned order ID (Razorpay: order_id, Cashfree: order_id) */
    providerOrderId: { type: String, trim: true },

    // ── Status ──────────────────────────────────────────────────────────────
    status: {
      type: String,
      enum: ['pending', 'authorized', 'paid', 'failed', 'cancelled'],
      default: 'pending'
    },

    // ── Amount ──────────────────────────────────────────────────────────────
    amount: { type: Number, min: 1 },
    currency: { type: String, default: 'INR', trim: true, uppercase: true },

    // ── Payment method detail (non-sensitive, from provider) ─────────────────
    paymentMethod: { type: String, trim: true },
    paymentMethodDetail: { type: String, trim: true },

    // ── Error detail for failed attempts ─────────────────────────────────────
    errorCode: { type: String, trim: true },
    errorDescription: { type: String, trim: true },

    // ── Timestamps ────────────────────────────────────────────────────────────
    initiatedAt: { type: Date, default: Date.now },
    completedAt: { type: Date },

    // ── Non-sensitive provider metadata ──────────────────────────────────────
    providerMeta: { type: mongoose.Schema.Types.Mixed }
  },
  { timestamps: true }
);

paymentAttemptSchema.index({ payment: 1, createdAt: 1 });
paymentAttemptSchema.index({ providerPaymentId: 1 }, { sparse: true });

module.exports = mongoose.model('PaymentAttempt', paymentAttemptSchema);
