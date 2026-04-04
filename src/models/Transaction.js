const mongoose = require('mongoose');

/**
 * Transaction Model
 * Tracks every Razorpay billing event:
 *   - order      : subscription checkout initiated
 *   - payment    : first payment verified (plan activated)
 *   - renewal    : recurring charge via webhook
 *   - failed     : payment failure via webhook
 */
const transactionSchema = new mongoose.Schema(
  {
    organization: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Organization',
      required: true,
      index: true
    },
    organizationName: {
      type: String,
      default: ''
    },
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    },
    userEmail: {
      type: String,
      default: ''
    },

    planId: { type: String, default: '' },
    planName: { type: String, default: '' },
    amountInr: { type: Number, default: 0 }, // stored in paise

    currency: { type: String, default: 'INR' },

    razorpaySubscriptionId: { type: String, index: true },
    razorpayPaymentId: { type: String },

    type: {
      type: String,
      enum: ['order', 'payment', 'renewal', 'failed'],
      required: true,
      index: true
    },

    status: {
      type: String,
      enum: ['pending', 'completed', 'failed'],
      required: true,
      default: 'pending',
      index: true
    },

    metadata: { type: mongoose.Schema.Types.Mixed }
  },
  { timestamps: true }
);

transactionSchema.index({ createdAt: -1 });
transactionSchema.index({ type: 1, status: 1 });

module.exports = mongoose.model('Transaction', transactionSchema);
