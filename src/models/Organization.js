const mongoose = require('mongoose');

const organizationSchema = new mongoose.Schema({
  name: {
    type: String,
    required: [true, 'Organization name is required'],
    trim: true
  },
  slug: {
    type: String,
    unique: true,
    lowercase: true,
    trim: true
  },
  logo: String,
  website: String,
  industry: String,
  size: {
    type: String,
    enum: ['small', 'medium', 'large', 'enterprise'],
    default: 'small'
  },
  
  // Subscription details
  subscription: {
    plan: {
      type: String,
      enum: ['free', 'starter', 'professional', 'enterprise'],
      default: 'free'
    },
    status: {
      type: String,
      enum: ['active', 'cancelled', 'expired', 'trial'],
      default: 'trial'
    },
    startDate: Date,
    endDate: Date,
    billingEmail: String
  },
  
  // Plan limits
  limits: {
    maxUsers: {
      type: Number,
      default: 3
    },
    maxPlatformConnections: {
      type: Number,
      default: 3
    },
    maxInteractionsPerMonth: {
      type: Number,
      default: 1000
    },
    maxAICreditsPerMonth: {
      type: Number,
      default: 500
    }
  },
  
  // Current usage
  usage: {
    currentUsers: {
      type: Number,
      default: 0
    },
    currentPlatformConnections: {
      type: Number,
      default: 0
    },
    interactionsThisMonth: {
      type: Number,
      default: 0
    },
    aiCreditsUsedThisMonth: {
      type: Number,
      default: 0
    },
    lastResetDate: Date
  },
  
  // White label settings
  whiteLabel: {
    enabled: {
      type: Boolean,
      default: false
    },
    customDomain: String,
    primaryColor: {
      type: String,
      default: '#3B82F6'
    },
    secondaryColor: {
      type: String,
      default: '#10B981'
    },
    customLogo: String
  },
  
  owner: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  
  isActive: {
    type: Boolean,
    default: true
  }
}, {
  timestamps: true
});

// Indexes
organizationSchema.index({ slug: 1 });
organizationSchema.index({ owner: 1 });

// Generate slug from name before saving
organizationSchema.pre('save', async function(next) {
  if (!this.isModified('name') || this.slug) {
    return next();
  }
  
  try {
    const baseSlug = this.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
    
    let slug = baseSlug;
    let counter = 1;
    
    // Ensure slug is unique
    while (await this.constructor.findOne({ slug })) {
      slug = `${baseSlug}-${counter}`;
      counter++;
    }
    
    this.slug = slug;
    next();
  } catch (error) {
    next(error);
  }
});

// Reset monthly usage
organizationSchema.methods.resetMonthlyUsage = function() {
  this.usage.interactionsThisMonth = 0;
  this.usage.aiCreditsUsedThisMonth = 0;
  this.usage.lastResetDate = new Date();
  return this.save();
};

// Check if limit exceeded
organizationSchema.methods.checkLimit = function(limitType) {
  switch(limitType) {
    case 'users':
      return this.usage.currentUsers >= this.limits.maxUsers;
    case 'platforms':
      return this.usage.currentPlatformConnections >= this.limits.maxPlatformConnections;
    case 'interactions':
      return this.usage.interactionsThisMonth >= this.limits.maxInteractionsPerMonth;
    case 'ai':
      return this.usage.aiCreditsUsedThisMonth >= this.limits.maxAICreditsPerMonth;
    default:
      return false;
  }
};

module.exports = mongoose.model('Organization', organizationSchema);

