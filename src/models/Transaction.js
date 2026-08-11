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
    /** Unique so a replayed webhook can never create a second completed transaction. */
    razorpayPaymentId: { type: String, index: { unique: true, sparse: true } },
    /** Set for one-time purchases (Razorpay Orders API), which subscriptions don't use. */
    razorpayOrderId: { type: String, index: true },

    /**
     * What was bought. Populated for add-on purchases; empty for plan billing, where
     * planId/planName already say everything.
     */
    lineItems: [{
      _id: false,
      addOnId: { type: String, trim: true },
      name: { type: String, trim: true },
      quantity: { type: Number, default: 1 },
      unitAmountInr: { type: Number, default: 0 },   // paise
      amountInr: { type: Number, default: 0 },       // paise
      grantFeatureKey: { type: String, trim: true },
      grantAmount: { type: Number, default: 0 }
    }],

    /**
     * When entitlement was actually granted. The fulfilment guard is a conditional
     * update on `fulfilledAt: null`, so a duplicate webhook loses the race and stops.
     */
    fulfilledAt: { type: Date, default: null },

    type: {
      type: String,
      enum: [
        'order', 'payment', 'renewal', 'failed',
        // Add-on commerce
        'topup', 'addon_subscription', 'addon_renewal', 'refund'
      ],
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
