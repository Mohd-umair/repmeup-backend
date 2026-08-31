'use strict';

/**
 * Payment
 *
 * Customer-facing payment request. Created once per payable event (order + amount).
 * Duplicate-protected by a partial unique index on {organization, order, amount, currency, status: created/pending}.
 *
 * States:
 *   created → pending → authorized → paid (terminal)
 *                     ↘ failed     (terminal)
 *                     ↘ expired    (terminal)
 *                     ↘ cancelled  (terminal)
 *   paid → partially_refunded → refunded (terminal)
 *
 * Terminal states: paid, failed, expired, cancelled, refunded.
 * The state machine in paymentStateMachine.js enforces valid transitions.
 */

const mongoose = require('mongoose');

const PAYMENT_STATUSES = [
  'created',
  'pending',
  'authorized',
  'paid',
  'failed',
  'expired',
  'cancelled',
  'partially_refunded',
  'refunded'
];

const TERMINAL_STATUSES = new Set(['paid', 'failed', 'expired', 'cancelled', 'refunded']);

const paymentSchema = new mongoose.Schema(
  {
    // ── Tenant + context ────────────────────────────────────────────────────
    organization: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Organization',
      required: true,
      index: true
    },
    contact: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Contact'
    },
    /** The inbox Interaction thread this payment was initiated from */
    interaction: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Interaction'
    },
    /** Conversation ID (for channel dispatch) */
    conversation: { type: String, trim: true },
    /** Channel the payment link was sent on */
    channel: {
      type: String,
      enum: ['instagram', 'whatsapp', 'manual', 'api'],
      default: 'manual'
    },

    // ── Canonical order reference ───────────────────────────────────────────
    order: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'CommerceOrder',
      required: true
    },

    // ── Gateway ─────────────────────────────────────────────────────────────
    integration: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'PaymentIntegration',
      required: true
    },
    provider: {
      type: String,
      enum: ['razorpay', 'cashfree', 'payu', 'phonepe', 'stripe'],
      required: true
    },

    // ── Status ──────────────────────────────────────────────────────────────
    status: {
      type: String,
      enum: PAYMENT_STATUSES,
      default: 'created',
      index: true
    },

    // ── Amount (always minor units, e.g. paise for INR) ─────────────────────
    /** Amount in minor units (paise for INR, cents for USD, etc.) */
    amount: { type: Number, required: true, min: 1 },
    currency: { type: String, default: 'INR', trim: true, uppercase: true },

    /**
     * Deterministic idempotency key for this payment request.
     * Format: `{orgId}-{orderId}-{amount}-{currency}-{counter}`
     * Unique index prevents concurrent duplicates at the DB level.
     */
    idempotencyKey: { type: String, trim: true, index: true, sparse: true },

    // ── Provider IDs ─────────────────────────────────────────────────────────
    providerOrderId: { type: String, trim: true },
    providerPaymentId: { type: String, trim: true },
    providerSignature: { type: String, trim: true },

    // ── Payment link ─────────────────────────────────────────────────────────
    paymentUrl: { type: String, trim: true },
    shortUrl: { type: String, trim: true },
    expiresAt: { type: Date },

    // ── Lifecycle timestamps ─────────────────────────────────────────────────
    sentAt: { type: Date },
    authorizedAt: { type: Date },
    paidAt: { type: Date },
    failedAt: { type: Date },
    expiredAt: { type: Date },
    cancelledAt: { type: Date },

    // ── Refund totals ─────────────────────────────────────────────────────────
    /** Total refunded amount in minor units */
    refundedAmount: { type: Number, default: 0, min: 0 },

    // ── Agent / AI attribution ────────────────────────────────────────────────
    createdBy: {
      type: String,
      enum: ['agent', 'ai', 'api', 'system'],
      default: 'agent'
    },
    agentUser: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    },

    // ── Non-sensitive provider metadata ──────────────────────────────────────
    providerMeta: { type: mongoose.Schema.Types.Mixed },

    // ── Channel message tracking ──────────────────────────────────────────────
    /** Message ID of the payment link sent on the channel */
    channelMessageId: { type: String, trim: true },
    channelDeliveredAt: { type: Date },

    // ── Description / notes ──────────────────────────────────────────────────
    description: { type: String, trim: true },
    internalNote: { type: String, trim: true }
  },
  { timestamps: true }
);

// ── Indexes ────────────────────────────────────────────────────────────────────

paymentSchema.index({ organization: 1, status: 1, createdAt: -1 });
paymentSchema.index({ organization: 1, order: 1 });
paymentSchema.index({ organization: 1, contact: 1, createdAt: -1 });
paymentSchema.index({ organization: 1, integration: 1, createdAt: -1 });
paymentSchema.index({ providerOrderId: 1, provider: 1 }, { sparse: true });
paymentSchema.index({ providerPaymentId: 1, provider: 1 }, { sparse: true });

/**
 * Duplicate protection:
 * One active (non-terminal, non-cancelled) unpaid payment per {org, order, amount, currency}.
 * Concurrent requests that lose the race load and return the winner.
 */
paymentSchema.index(
  { organization: 1, order: 1, amount: 1, currency: 1 },
  {
    unique: true,
    partialFilterExpression: {
      status: { $in: ['created', 'pending', 'authorized'] }
    },
    name: 'unique_active_payment_per_order'
  }
);

module.exports = mongoose.model('Payment', paymentSchema);
module.exports.PAYMENT_STATUSES = PAYMENT_STATUSES;
module.exports.TERMINAL_STATUSES = TERMINAL_STATUSES;
