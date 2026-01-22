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
  
  // Auto-reply settings
  autoReplySettings: {
    enabled: {
      type: Boolean,
      default: false
    },
    enabledPlatforms: {
      type: [String],
      default: ['youtube', 'instagram', 'facebook', 'google']
    },
    enabledTypes: {
      type: [String],
      default: ['comment', 'review']
    },
    // Sentiment filter: control which sentiments to auto-reply to
    sentimentFilter: {
      type: String,
      enum: ['all', 'negative_only', 'positive_only', 'neutral_only', 'positive_neutral'],
      default: 'all' // Reply to all sentiments by default
    },
    replyToNegative: {
      type: Boolean,
      default: false // Don't auto-reply to negative sentiment by default (kept for backward compatibility)
    },
    replyToComplaints: {
      type: Boolean,
      default: false // Don't auto-reply to complaints by default
    },
    minConfidence: {
      type: Number,
      default: 0.75, // Minimum AI confidence to auto-reply
      min: 0,
      max: 1
    },
    autoSend: {
      type: Boolean,
      default: false // If true, automatically send; if false, save as draft
    },
    requireApproval: {
      type: Boolean,
      default: true // Require human approval before sending
    },
    maxRepliesPerDay: {
      type: Number,
      default: 50 // Limit auto-replies per day
    },
    repliesCountToday: {
      type: Number,
      default: 0
    },
    lastReplyResetDate: Date,
    
    // Scheduling settings
    triggerMode: {
      type: String,
      enum: ['webhook', 'scheduled', 'manual', 'hybrid'],
      default: 'hybrid' // Hybrid: webhook + scheduled fallback
    },
    webhookImmediate: {
      type: Boolean,
      default: true // Process webhook-triggered auto-replies immediately
    },
    webhookDelay: {
      type: Number,
      default: 5 // Delay in minutes before processing webhook auto-reply
    },
    scheduleInterval: {
      type: String,
      enum: ['15min', '30min', '1hour', '6hours', '12hours', '24hours'],
      default: '24hours' // Default: check every 24 hours
    },
    scheduleEnabled: {
      type: Boolean,
      default: true // Enable scheduled processing
    },
    lastScheduledRun: Date // Track last scheduled run time
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
// Note: slug index is automatically created by unique: true
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

