const mongoose = require('mongoose');

/**
 * Subscription Model - Now uses database-driven Plan model
 * Plans are managed by super admin in the database
 */

const subscriptionSchema = new mongoose.Schema({
  organization: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Organization',
    required: true,
    unique: true
  },
  
  // Plan information (references Plan model)
  planId: {
    type: String,
    required: true,
    default: 'free'
  },
  planName: {
    type: String,
    default: 'Free'
  },
  tier: {
    type: Number,
    default: 0
  },
  
  // Plan limits
  limits: {
    maxAccounts: {
      type: Number,
      default: 1
    },
    maxUsers: {
      type: Number,
      default: 1
    },
    maxPostsPerMonth: {
      type: Number,
      default: 10
    },
    maxAutoRepliesPerMonth: {
      type: Number,
      default: 50
    },
    maxAICreditsPerMonth: {
      type: Number,
      default: 100
    }
  },
  
  // Usage tracking (legacy; new code reads usageBuckets via entitlementsService)
  usage: {
    connectedAccounts: {
      type: Number,
      default: 0
    },
    activeUsers: {
      type: Number,
      default: 1
    },
    postsThisMonth: {
      type: Number,
      default: 0
    },
    autoRepliesThisMonth: {
      type: Number,
      default: 0
    },
    aiCreditsThisMonth: {
      type: Number,
      default: 0
    },
    lastResetAt: {
      type: Date,
      default: Date.now
    }
  },

  /**
   * Generic per-feature usage buckets keyed by Feature.key.
   *
   * Each entry tracks consumption against a `limit` feature. The bucketService
   * is responsible for resetting `used` to 0 when the period rolls over.
   *
   *   usageBuckets: {
   *     'credits.autoReply.monthly': { used: 23,  periodStart: 2026-05-01 },
   *     'inbox.uniqueContacts.monthly': { used: 117, periodStart: 2026-05-01 }
   *   }
   *
   * NOTE: legacy `usage.aiCreditsThisMonth` etc. are kept in sync during the
   * migration window so older controllers still report correct numbers.
   */
  usageBuckets: {
    type: Map,
    of: new mongoose.Schema(
      {
        used: { type: Number, default: 0 },
        periodStart: { type: Date, default: () => new Date() }
      },
      { _id: false }
    ),
    default: undefined
  },
  
  // Billing status
  status: {
    type: String,
    enum: ['active', 'trialing', 'past_due', 'cancelled', 'paused', 'pending_payment'],
    default: 'active'
  },
  
  // Billing cycle
  billingCycle: {
    type: String,
    enum: ['monthly', 'yearly', 'custom'],
    default: 'monthly'
  },
  currentPeriodStart: Date,
  currentPeriodEnd: Date,
  trialEndsAt: Date,
  
  // Payment information
  stripeCustomerId: String,
  stripeSubscriptionId: String,

  // Razorpay integration
  razorpaySubscriptionId: String,
  razorpayCustomerId: String,
  razorpayNextBillingAt: Date,

  paymentMethod: {
    type: {
      type: String,
      enum: ['card', 'bank', 'paypal']
    },
    last4: String,
    brand: String,
    expiryMonth: Number,
    expiryYear: Number
  },
  
  // Features enabled
  features: [{
    type: String
  }],
  
  // Subscription history
  planHistory: [{
    planId: String,
    planName: String,
    changedAt: {
      type: Date,
      default: Date.now
    },
    changedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    },
    reason: String
  }],

  // Cancellation
  cancelledAt: Date,
  cancelledBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  cancellationReason: String,
  cancelAtPeriodEnd: {
    type: Boolean,
    default: false
  }
}, {
  timestamps: true
});

// Indexes (organization omitted - unique: true on field already creates index)
subscriptionSchema.index({ status: 1 });
subscriptionSchema.index({ currentPeriodEnd: 1 });

// Method to check if a limit is reached
subscriptionSchema.methods.isLimitReached = function(limitType) {
  if (this.limits[limitType] === -1) return false; // Unlimited
  return this.usage[limitType] >= this.limits[limitType];
};

// Method to get remaining quota
subscriptionSchema.methods.getRemainingQuota = function(limitType) {
  if (this.limits[limitType] === -1) return Infinity; // Unlimited
  return Math.max(0, this.limits[limitType] - this.usage[limitType]);
};

// Method to check if feature is enabled
subscriptionSchema.methods.hasFeature = function(featureName) {
  return this.features.includes(featureName);
};

// Method to reset monthly usage (legacy keys + new bucket map kept in sync).
subscriptionSchema.methods.resetMonthlyUsage = function() {
  this.usage.postsThisMonth = 0;
  this.usage.autoRepliesThisMonth = 0;
  this.usage.aiCreditsThisMonth = 0;
  this.usage.lastResetAt = new Date();

  if (this.usageBuckets && typeof this.usageBuckets.forEach === 'function') {
    const now = new Date();
    this.usageBuckets.forEach((bucket, key) => {
      this.usageBuckets.set(key, { used: 0, periodStart: now });
    });
    this.markModified('usageBuckets');
  }

  return this.save();
};

module.exports = mongoose.model('Subscription', subscriptionSchema);
