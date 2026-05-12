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
  orgCode: {
    type: String,
    trim: true,
    maxlength: 6,
    uppercase: true,
    default: ''
  },
  chatCounter: {
    type: Number,
    default: 100
  },
  size: {
    type: String,
    enum: ['', '1-10', '11-50', '51-200', '201-500', '501-1000', '1000+', 'small', 'medium', 'large', 'enterprise'],
    default: ''
  },
  
  // ────────────────────────────────────────────────────────────────────────────
  // @deprecated Subscription details (legacy embedded copy).
  //
  // The authoritative subscription record is the Subscription model, and the
  // authoritative plan definition is the Plan model. Always read entitlements
  // via services/entitlementsService.js — never read these fields directly in
  // new code. Kept here so that orgs migrated before the Subscription model
  // existed still have resolvable defaults.
  // ────────────────────────────────────────────────────────────────────────────
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

  // ────────────────────────────────────────────────────────────────────────────
  // @deprecated Plan limits (legacy embedded copy).
  //
  // Read limits through services/entitlementsService.js — do NOT read these
  // fields in new code. They drift from Plan.limits whenever a plan definition
  // is updated and are only kept as a fallback for orgs without a Subscription.
  // ────────────────────────────────────────────────────────────────────────────
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
      // Include dm so Instagram/Facebook Messenger auto-reply works without extra setup
      default: ['comment', 'review', 'dm']
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
      default: 0.75, // Minimum AI *reply* confidence (0–1) from generateResponse — enforced in generateAutoReply; not sentiment score
      min: 0,
      max: 1
    },
    autoSend: {
      type: Boolean,
      default: true
    },
    requireApproval: {
      type: Boolean,
      default: false
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
    lastScheduledRun: Date, // Track last scheduled run time

    // Fallback settings — triggered when AI cannot respond for any reason
    fallbackSettings: {
      enabled: {
        type: Boolean,
        default: false
      },
      message: {
        type: String,
        default: 'Our Agent will contact you within 24 hours.'
      },
      assignToAgent: {
        type: Boolean,
        default: true
      },
      notifyByEmail: {
        type: Boolean,
        default: true
      }
    }
  },
  
  // Inbox UI settings
  inboxSettings: {
    autoSyncEnabled: {
      type: Boolean,
      default: true
    }
  },

  // Instagram Comment-to-DM selling automation
  commentToDmSettings: {
    enabled: {
      type: Boolean,
      default: false
    },
    /**
     * Keywords that signal purchase/buying intent in a comment.
     * Case-insensitive, partial-word match (contains).
     */
    triggerKeywords: {
      type: [String],
      default: ['price', 'buy', 'cost', 'order', 'purchase', 'how much', 'interested', 'want this', 'where to buy', 'link']
    },
    /**
     * Text posted publicly as a comment reply (safe stub — never contains payment link).
     * Supports: {{username}}
     */
    publicReplyTemplate: {
      type: String,
      default: 'Hi {{username}}! 👋 We\'ve sent you the details in DM. 😊'
    },
    /**
     * DM body template.
     * Supports: {{product_name}}, {{price}}, {{currency}}, {{sizes}}, {{colors}}, {{payment_url}}, {{description}}
     */
    dmTemplate: {
      type: String,
      default: 'Hi {{username}}! 👋 Thanks for your interest.\n\n🛍️ *{{product_name}}*\n💵 Price: {{currency}} {{price}}\n📦 Sizes: {{sizes}}\n\n👉 Order here: {{payment_url}}\n\nFeel free to DM us if you have questions! 😊'
    },
    /**
     * Confirmation DM sent after payment is received.
     * Supports: {{product_name}}, {{username}}
     */
    confirmationTemplate: {
      type: String,
      default: 'Hi {{username}}! 🎉 Your order for *{{product_name}}* has been confirmed! We\'ll be in touch with shipping details soon. Thank you! 🙏'
    },
    /**
     * Optional fallback product sent when a comment matches a keyword but the
     * post has no product explicitly linked via instagramPostIds.
     */
    defaultProductId: {
      type: require('mongoose').Schema.Types.ObjectId,
      ref: 'Product',
      default: null
    },

    /** Skip sending a DM if one was already sent to this user for this post */
    deduplicateDms: {
      type: Boolean,
      default: true
    },
    /** Maximum product DMs to send per day across the whole org */
    maxDmsPerDay: {
      type: Number,
      default: 200
    },
    dmsSentToday: {
      type: Number,
      default: 0
    },
    dmsSentResetDate: {
      type: Date
    }
  },

  // Instagram: top-level comment → private DM with Follow button (generic template)
  commentFollowInviteSettings: {
    enabled: { type: Boolean, default: false },
    /** Generic template element title (max 80 in API — trim server-side) */
    title: {
      type: String,
      default: 'Thanks for your comment!'
    },
    subtitle: {
      type: String,
      default: 'Tap below to follow us for more updates.'
    },
    imageUrl: { type: String, default: '' },
    buttonTitle: { type: String, default: 'Follow us' },
    /** Full URL; if empty, derived as https://www.instagram.com/{username}/ from connected IG account */
    buttonUrl: { type: String, default: '' },
    /** Optional public comment reply; supports {{username}} */
    publicReplyTemplate: {
      type: String,
      default: ''
    },
    postPublicReply: { type: Boolean, default: false },
    deduplicateDms: { type: Boolean, default: true },
    maxDmsPerDay: { type: Number, default: 50, min: 1, max: 10000 },
    dmsSentToday: { type: Number, default: 0 },
    dmsSentResetDate: { type: Date },
    /** If a product Comment-to-DM was sent for this comment, skip follow-invite */
    skipIfProductDmSent: { type: Boolean, default: true }
  },

  // Human agent escalation settings
  escalationSettings: {
    enabled: {
      type: Boolean,
      default: true
    },
    maxAutoReplies: {
      type: Number,
      default: 3, // Max auto-replies before escalation
      min: 1,
      max: 10
    },
    escalateOnNegative: {
      type: Boolean,
      default: true // Escalate when negative sentiment detected
    },
    negativeThreshold: {
      type: Number,
      default: 2, // Number of negative sentiments before escalation
      min: 1,
      max: 5
    },
    escalationKeywords: {
      type: [String],
      default: [
        'refund', 'complaint', 'lawyer', 'sue', 'legal', 
        'terrible', 'worst', 'horrible', 'unacceptable',
        'manager', 'supervisor', 'corporate', 'headquarters',
        'scam', 'fraud', 'cheat', 'lie', 'liar'
      ]
    },
    lowConfidenceThreshold: {
      type: Number,
      default: 0.7, // Escalate if AI confidence < 70%
      min: 0,
      max: 1
    },
    lowConfidenceCount: {
      type: Number,
      default: 2, // Number of low-confidence replies before escalation
      min: 1,
      max: 5
    },
    assignmentMethod: {
      type: String,
      enum: ['round_robin', 'least_busy', 'skill_based', 'manual'],
      default: 'round_robin'
    },
    autoAssign: {
      type: Boolean,
      default: true // Automatically assign to agent or wait for manual assignment
    },
    notifyAgents: {
      type: Boolean,
      default: true // Send notification to agents when assigned
    },
    notificationChannels: {
      type: [String],
      enum: ['email', 'push', 'sms', 'slack'],
      default: ['email']
    },
    priorityLevels: {
      urgent: {
        keywords: {
          type: [String],
          default: ['urgent', 'emergency', 'asap', 'immediately', 'critical']
        },
        assignTo: {
          type: mongoose.Schema.Types.ObjectId,
          ref: 'User' // Specific user for urgent cases
        }
      },
      high: {
        keywords: {
          type: [String],
          default: ['important', 'serious', 'problem', 'issue']
        }
      }
    },
    // Layer 1 — Intent-based hard routing: buckets that always skip AI and go straight to human
    alwaysHumanBuckets: [{
      type: mongoose.Schema.Types.ObjectId,
      ref: 'IntentBucket'
    }],

    // Handoff message sent to customer when AI routes to human (Layer 1 & 2)
    handoffMessageTemplate: {
      type: String,
      default: "Thank you for reaching out. I'm connecting you with a team member who can better assist you with this."
    },

    // Round-robin state
    lastAssignedAgentIndex: {
      type: Number,
      default: -1
    },
    availableAgents: [{
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    }],
    // Business hours (for escalation timing)
    businessHours: {
      enabled: {
        type: Boolean,
        default: false
      },
      timezone: {
        type: String,
        default: 'Asia/Kolkata'
      },
      schedule: {
        monday: {
          start: { type: String, default: '09:00' },
          end: { type: String, default: '18:00' },
          enabled: { type: Boolean, default: true }
        },
        tuesday: {
          start: { type: String, default: '09:00' },
          end: { type: String, default: '18:00' },
          enabled: { type: Boolean, default: true }
        },
        wednesday: {
          start: { type: String, default: '09:00' },
          end: { type: String, default: '18:00' },
          enabled: { type: Boolean, default: true }
        },
        thursday: {
          start: { type: String, default: '09:00' },
          end: { type: String, default: '18:00' },
          enabled: { type: Boolean, default: true }
        },
        friday: {
          start: { type: String, default: '09:00' },
          end: { type: String, default: '18:00' },
          enabled: { type: Boolean, default: true }
        },
        saturday: {
          start: { type: String, default: '10:00' },
          end: { type: String, default: '16:00' },
          enabled: { type: Boolean, default: false }
        },
        sunday: {
          start: { type: String, default: '10:00' },
          end: { type: String, default: '16:00' },
          enabled: { type: Boolean, default: false }
        }
      }
    }
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

