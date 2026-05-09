const mongoose = require('mongoose');

/**
 * Plan Model - Database-driven subscription plans
 * Allows super admin to create and manage plans dynamically
 */
const planSchema = new mongoose.Schema({
  // Plan identification
  planId: {
    type: String,
    required: true,
    unique: true,
    lowercase: true,
    trim: true,
    // e.g., 'free', 'starter', 'pro', 'business', 'enterprise'
  },
  name: {
    type: String,
    required: true,
    trim: true,
    // e.g., 'Free', 'Starter', 'Pro', 'Business', 'Enterprise'
  },
  description: {
    type: String,
    trim: true,
  },
  
  // Plan tier (ordering for upgrades; lower tiers are not self-serve)
  tier: {
    type: Number,
    required: true,
    min: 0,
    // 0 = Free, 1 = Starter, 2 = Pro, etc.
  },
  
  // Pricing
  price: {
    type: mongoose.Schema.Types.Mixed, // Can be Number or String ('custom')
    required: true,
    // 0 for free, number for paid, 'custom' for enterprise
  },
  billingCycle: {
    type: String,
    enum: ['monthly', 'yearly', 'custom', 'lifetime'],
    default: 'monthly'
  },
  
  // ── DEPRECATED: legacy fixed-shape limits map ────────────────────────────
  // Retained for backwards compatibility with older callers that read
  // `subscription.limits.maxAccounts` directly. The entitlements engine
  // prefers `entitlements` (catalog-keyed) and synthesizes this shape
  // on read for legacy consumers. New plan keys should be added to the
  // Feature Catalog, NOT to this sub-schema.
  // Slated for removal one full billing cycle after the entitlements
  // engine ships.
  limits: {
    maxAccounts: {
      type: Number,
      required: true,
      // -1 = unlimited
    },
    maxUsers: {
      type: Number,
      required: true,
      // -1 = unlimited
    },
    maxPostsPerMonth: {
      type: Number,
      required: true,
      // -1 = unlimited
    },
    maxAutoRepliesPerMonth: {
      type: Number,
      required: true,
      // -1 = unlimited
    },
    maxAICreditsPerMonth: {
      type: Number,
      required: true,
      default: 500,
      // -1 = unlimited
    },
    maxStorageGB: {
      type: Number,
      default: 5,
      // -1 = unlimited
    },
    maxAPICallsPerDay: {
      type: Number,
      default: 1000,
      // -1 = unlimited
    }
  },
  
  // ── DEPRECATED: legacy free-form feature codes ───────────────────────────
  // Kept for backwards compatibility (older clients still read this field).
  // New code MUST read `entitlements` and use entitlementsService instead.
  features: [{
    type: String,
    trim: true
  }],

  /**
   * Canonical entitlements keyed by Feature.key (e.g. users.max).
   *
   * Stored as a plain Object (Mixed), NOT Mongoose Map — Map keys cannot contain "."
   * and our catalog uses dotted keys exclusively.
   *
   * Each value:
   *   - boolean feature: { enabled: true|false }
   *   - limit feature:   { limit: -1|number }
   *   - enum feature:    { value: 'someEnumValue' }
   *   - list feature:    { value: ['a','b'] }
   *   - json feature:    { value: { ... } }
   */
  entitlements: {
    type: mongoose.Schema.Types.Mixed,
    default: () => ({})
  },
  
  // Visual & Marketing
  badge: {
    type: String,
    trim: true,
    // e.g., 'MOST POPULAR', 'BEST VALUE', 'RECOMMENDED'
  },
  badgeColor: {
    type: String,
    default: 'blue',
    // e.g., 'blue', 'purple', 'green', 'red'
  },
  highlightColor: {
    type: String,
    default: '#4F46E5',
    // Hex color for highlighting this plan
  },
  
  // Display settings
  isActive: {
    type: Boolean,
    default: true,
    // Only active plans are shown to users
  },
  isPublic: {
    type: Boolean,
    default: true,
    // Public plans shown on pricing page, private for custom deals
  },
  displayOrder: {
    type: Number,
    default: 0,
    // Order in which plans appear (lower = first)
  },
  
  // Stripe integration (for future payment processing)
  stripePriceId: {
    type: String,
    trim: true,
  },
  stripeProductId: {
    type: String,
    trim: true,
  },

  // Razorpay integration
  razorpayPlanId: {
    type: String,
    trim: true,
    // Razorpay Plan ID (e.g. plan_xxx) — created in Razorpay dashboard by super admin
  },
  priceInr: {
    type: Number,
    // Monthly price in INR paise (e.g. 199900 = ₹1999/mo); required for Razorpay subscriptions
    default: 0,
  },
  
  // Trial settings
  trialDays: {
    type: Number,
    default: 0,
    // Number of trial days (0 = no trial)
  },
  
  // Plan metadata
  metadata: {
    type: Map,
    of: mongoose.Schema.Types.Mixed,
    // Additional flexible data
  },
  
  // Audit fields
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
  },
  updatedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
  }
}, {
  timestamps: true
});

// Indexes (planId omitted - unique: true on field already creates index)
planSchema.index({ tier: 1 });
planSchema.index({ isActive: 1, isPublic: 1 });
planSchema.index({ displayOrder: 1 });

// Virtual for formatted price
planSchema.virtual('formattedPrice').get(function() {
  if (this.price === 0) return 'Free';
  if (this.price === 'custom') return 'Custom';
  return `$${this.price}/${this.billingCycle === 'monthly' ? 'mo' : this.billingCycle === 'yearly' ? 'yr' : 'period'}`;
});

// Method to check if feature is included
planSchema.methods.hasFeature = function(featureCode) {
  return this.features.includes(featureCode);
};

// Method to check if unlimited for a limit
planSchema.methods.isUnlimited = function(limitType) {
  return this.limits[limitType] === -1;
};

/**
 * Read a single entitlement entry by feature key, normalized.
 * Returns `undefined` when the plan does not specify a value for that key —
 * callers should fall back to the catalog default.
 */
planSchema.methods.getEntitlement = function(featureKey) {
  if (!this.entitlements) return undefined;
  if (typeof this.entitlements.get === 'function') {
    const v = this.entitlements.get(featureKey);
    if (v !== undefined && v !== null) return v;
  }
  return this.entitlements[featureKey];
};

/**
 * Bulk read entitlements as a plain object — convenient for service code that
 * resolves the full plan once and then queries many keys.
 */
planSchema.methods.getEntitlementsObject = function() {
  if (!this.entitlements) return {};
  if (typeof this.entitlements.toObject === 'function') {
    try {
      return this.entitlements.toObject();
    } catch (_) {
      // fall through
    }
  }
  if (this.entitlements instanceof Map) {
    return Object.fromEntries(this.entitlements);
  }
  return { ...this.entitlements };
};

// Static method to get active public plans
planSchema.statics.getPublicPlans = function() {
  return this.find({ isActive: true, isPublic: true })
    .sort({ displayOrder: 1, tier: 1 })
    .select('-stripePriceId -stripeProductId -metadata -createdBy -updatedBy');
};

// Static method to get plan by planId
planSchema.statics.getByPlanId = function(planId) {
  return this.findOne({ planId, isActive: true });
};

// Static method to get next tier plan
planSchema.statics.getNextTierPlan = async function(currentTier) {
  return this.findOne({ 
    tier: { $gt: currentTier }, 
    isActive: true,
    isPublic: true 
  }).sort({ tier: 1 });
};

module.exports = mongoose.model('Plan', planSchema);
