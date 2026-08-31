'use strict';

/**
 * Refund
 *
 * Append-only refund ledger. Each partial or full refund has its own record.
 * Sum of all completed refund amounts for a Payment must not exceed the original amount.
 *
 * Unique index on {payment, providerRefundId} prevents duplicate webhook grants.
 */

const mongoose = require('mongoose');

const refundSchema = new mongoose.Schema(
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

    // ── Amount ──────────────────────────────────────────────────────────────
    /** Refund amount in minor units */
    amount: { type: Number, required: true, min: 1 },
    currency: { type: String, default: 'INR', trim: true, uppercase: true },

    // ── Provider reference ───────────────────────────────────────────────────
    providerRefundId: { type: String, trim: true },
    /** Idempotency key sent to provider (prevents duplicate refund requests) */
    providerIdempotencyKey: { type: String, trim: true },

    // ── Status ──────────────────────────────────────────────────────────────
    status: {
      type: String,
      enum: ['pending', 'processing', 'completed', 'failed'],
      default: 'pending'
    },

    // ── Reason ──────────────────────────────────────────────────────────────
    reason: {
      type: String,
      enum: ['customer_request', 'duplicate', 'fraud', 'order_change', 'other'],
      default: 'customer_request'
    },
    notes: { type: String, trim: true },

    // ── Attribution ──────────────────────────────────────────────────────────
    initiatedBy: {
      type: String,
      enum: ['agent', 'system', 'api'],
      default: 'agent'
    },
    agentUser: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    },

    // ── Timestamps ────────────────────────────────────────────────────────────
    completedAt: { type: Date },
    failedAt: { type: Date },
    failureReason: { type: String, trim: true }
  },
  { timestamps: true }
);

refundSchema.index({ payment: 1, createdAt: 1 });
refundSchema.index(
  { payment: 1, providerRefundId: 1 },
  { unique: true, sparse: true, name: 'unique_provider_refund_id' }
);

module.exports = mongoose.model('Refund', refundSchema);
