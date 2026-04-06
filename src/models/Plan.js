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
  
  // Plan limits
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
  
  // Features (array of feature codes)
  features: [{
    type: String,
    trim: true,
    // e.g., 'basic_posting', 'ai_responses', 'analytics', etc.
  }],
  
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
