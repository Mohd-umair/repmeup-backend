const mongoose = require('mongoose');

/**
 * SubscriptionAddOn — a recurring add-on an organization currently pays for
 * (extra user seats, Flow Builder).
 *
 * Its own collection rather than a field on Subscription, for two reasons:
 *   1. `Subscription.razorpaySubscriptionId` is already taken by the plan
 *      subscription, and each recurring add-on needs its own Razorpay subscription.
 *   2. Plan upgrades cancel and recreate the plan subscription; add-ons living in a
 *      separate record survive that untouched.
 */
const subscriptionAddOnSchema = new mongoose.Schema(
  {
    organization: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Organization',
      required: true
    },
    addOnId: { type: String, required: true, lowercase: true, trim: true },

    /** Units purchased (e.g. 3 extra seats). */
    quantity: { type: Number, required: true, min: 1, default: 1 },
    /** Price per unit at purchase time, in paise — snapshotted so later price changes
     *  don't rewrite history. */
    unitPriceInr: { type: Number, required: true, min: 0 },

    status: {
      type: String,
      enum: ['pending', 'active', 'past_due', 'cancelled'],
      default: 'pending'
    },

    razorpaySubscriptionId: { type: String, trim: true },
    currentPeriodStart: { type: Date },
    currentPeriodEnd: { type: Date },
    cancelAtPeriodEnd: { type: Boolean, default: false },
    cancelledAt: { type: Date },

    /**
     * What this purchase grants, captured at purchase time:
     * { featureKey, mode, amountPerUnit }. Snapshotting means recomputeOverrides
     * never has to guess what an old purchase was worth if the SKU changes later.
     */
    grantSnapshot: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }
  },
  { timestamps: true }
);

/** Rebuilding an org's overrides reads exactly this. */
subscriptionAddOnSchema.index({ organization: 1, status: 1 });
/** Webhooks arrive keyed by the Razorpay subscription. */
subscriptionAddOnSchema.index(
  { razorpaySubscriptionId: 1 },
  { unique: true, sparse: true }
);

module.exports = mongoose.model('SubscriptionAddOn', subscriptionAddOnSchema);
