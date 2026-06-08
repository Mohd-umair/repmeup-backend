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
  /** Inbox ops display refs: ORD-2847, CMP-0041, REV-0088 */
  orderCounter: { type: Number, default: 1000 },
  complaintCounter: { type: Number, default: 1000 },
  reviewCounter: { type: Number, default: 1000 },

  // ── Demo / Trial workspace ────────────────────────────────────────────────
  // A demo workspace is a REAL tenant put on a full-featured trial. On purchase
  // it becomes the production account with zero data migration (the same
  // Subscription doc is mutated by the normal upgrade/payment path).
  // The authoritative trial state lives on the Subscription model; these fields
  // are denormalized prospect/admin metadata for the super-admin demo console.
  demo: {
    isDemo: { type: Boolean, default: false, index: true },
    prospect: {
      name:    { type: String, trim: true, default: '' },
      email:   { type: String, trim: true, lowercase: true, default: '' },
      company: { type: String, trim: true, default: '' },
      phone:   { type: String, trim: true, default: '' }
    },
    createdViaSuperAdmin: { type: Boolean, default: false },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    seededAt:  { type: Date },
    lockedAt:  { type: Date },     // set when the trial expires and the workspace is locked
    convertedAt: { type: Date }    // set when the prospect purchases a paid plan
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
      enum: ['free', 'starter', 'professional', 'enterprise', 'demo'],
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
      default: ['youtube', 'instagram', 'facebook', 'google', 'linkedin', 'whatsapp']
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
      default: 60, // Fixed delay in SECONDS before sending webhook auto-reply (0 = immediate)
      min: 0,
      max: 7200
    },
    replyDelayMode: {
      type: String,
      enum: ['fixed', 'human'],
      default: 'fixed' // fixed = exact minutes; human = random range
    },
    humanDelayMinMinutes: {
      type: Number,
      default: 1,
      min: 0,
      max: 120
    },
    humanDelayMaxMinutes: {
      type: Number,
      default: 3,
      min: 0,
      max: 120
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

    // AI Reply style/tone
    tone: {
      type: String,
      enum: ['growth', 'balanced', 'safe', 'custom'],
      default: 'balanced'
    },
    /** When tone === 'custom', appended to auto-reply system prompts (max length enforced in app layer). */
    toneCustomText: {
      type: String,
      default: '',
      maxlength: 800
    },

    // Quiet hours — AI will not auto-reply during this window
    quietHours: {
      enabled: { type: Boolean, default: false },
      start: { type: String, default: '22:00' },
      end: { type: String, default: '08:00' },
      timezone: { type: String, default: 'Asia/Kolkata' }
    },

    // Keywords that suppress auto-reply (e.g. competitor names, blacklisted words)
    skipNegativeKeywords: { type: [String], default: [] },

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

  /**
   * @deprecated Use `automationModeByChannel` instead. Retained for back-compat:
   * replyEngineService falls back to this when a channel mode is unset
   * (legacy→ai_only, flows_only→workflow_only, hybrid→hybrid).
   */
  automationFlowMode: {
    type: String,
    enum: ['legacy', 'hybrid', 'flows_only'],
    default: 'hybrid'
  },

  /**
   * Per-channel automation mode. The Workflow (Flow) Builder is the core engine;
   * AI is subordinate (AI nodes inside flows + fallback when no flow matches).
   *   - workflow_only : only flows run; no AI fallback
   *   - ai_only       : flows skipped; AI auto-reply handles messages
   *   - hybrid        : flows run; AI fills the gap only when no flow took the conversation
   */
  automationModeByChannel: {
    whatsapp:  { type: String, enum: ['workflow_only', 'ai_only', 'hybrid'], default: 'hybrid' },
    instagram: { type: String, enum: ['workflow_only', 'ai_only', 'hybrid'], default: 'hybrid' },
    facebook:  { type: String, enum: ['workflow_only', 'ai_only', 'hybrid'], default: 'hybrid' }
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
    skipIfProductDmSent: { type: Boolean, default: true },
    filterNegativeSentiment: { type: Boolean, default: true },
    filterSalesIntent: { type: Boolean, default: true }
  },

  // Instagram: sales-intent comment → multi-turn DM with CTA buttons + WhatsApp retargeting
  salesFlowSettings: {
    /** Master toggle — off by default until CTA URLs are configured */
    enabled: { type: Boolean, default: false },

    // ── Generic Template card copy ─────────────────────────────────────────
    /** Card headline (max 80 chars per Meta limit) */
    ctaTitle: { type: String, default: 'Check this out! 🛍️' },
    /** Card subheading (max 80 chars per Meta limit) */
    ctaSubtitle: { type: String, default: 'Tap a button below for more details.' },
    /** Optional card image (must be https://) */
    ctaImageUrl: { type: String, default: '' },

    // ── CTA buttons array (web_url type, max 3 per Instagram Generic Template limit) ──
    /**
     * Each entry: { label: String (max 20), url: String (https://, supports {{orderToken}}) }
     * Max 3 items enforced in the controller and on the frontend.
     */
    ctaButtons: {
      type: [{
        label:   { type: String, trim: true, maxlength: 20 },
        /**
         * Button type:
         *  - 'postback' (default): tapping triggers a webhook; bot replies with a canned action
         *  - 'web_url': tapping opens the configured URL in a browser
         */
        type:    { type: String, enum: ['postback', 'web_url'], default: 'postback' },
        /**
         * Postback action when type === 'postback'.
         * Recognized values: 'details' | 'payment' | 'hesitant'
         * Free-form values are echoed back as text replies.
         */
        payload: { type: String, trim: true, maxlength: 64 },
        /** URL when type === 'web_url' (must be https://) */
        url:     { type: String, trim: true }
      }],
      default: [
        { label: 'Product Details', type: 'postback', payload: 'details' },
        { label: 'Pay Now',         type: 'postback', payload: 'payment' },
        { label: 'Maybe later',     type: 'postback', payload: 'hesitant' }
      ]
    },

    // ── Hesitancy detection ────────────────────────────────────────────────
    /** Case-insensitive keywords in a DM reply that signal purchase hesitancy */
    hesitancyKeywords: {
      type: [String],
      default: ['no', 'nahi', 'not interested', 'later', 'abhi nahi', 'nope', 'not now', 'maybe later']
    },

    // ── WhatsApp retargeting capture ────────────────────────────────────────
    /** DM message sent when hesitancy is detected, asking for WhatsApp number */
    whatsappCaptureMessage: {
      type: String,
      default: 'No problem! Would you like us to reach you on WhatsApp? Just share your number and we\'ll be in touch. 😊'
    },
    /** Confirmation DM sent after a phone number is captured */
    whatsappCaptureConfirmation: {
      type: String,
      default: 'Thank you! We\'ll contact you on WhatsApp soon. 🙏'
    }
  },

  // Instagram: story reply / @mention → automated product DM
  storyToDmSettings: {
    enabled: { type: Boolean, default: false },
    triggerOnReply: { type: Boolean, default: true },
    triggerOnMention: { type: Boolean, default: true },
    /** Optional keywords for story replies; empty = all replies qualify */
    triggerKeywords: {
      type: [String],
      default: []
    },
    defaultProductId: {
      type: require('mongoose').Schema.Types.ObjectId,
      ref: 'Product',
      default: null
    },
    deduplicateDms: { type: Boolean, default: true },
    maxDmsPerDay: { type: Number, default: 200, min: 1, max: 10000 },
    dmsSentToday: { type: Number, default: 0 },
    dmsSentResetDate: { type: Date },
    welcomeTitle: {
      type: String,
      default: ''
    },
    welcomeSubtitle: {
      type: String,
      default: ''
    },
    welcomeImageUrl: { type: String, default: '' }
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
    // Structured trigger, routing, notification settings (Automation Hub)
    triggers: {
      lowConfidence: { type: Boolean, default: true },
      negativeSentiment: { type: Boolean, default: true },
      complexRequests: { type: Boolean, default: false },
      repeatedMessages: { type: Boolean, default: false },
      keywords: { type: [String], default: [] },
      outsideBusinessHours: { type: Boolean, default: false }
    },
    routing: {
      strategy: {
        type: String,
        enum: ['round_robin', 'specific_team', 'skill_based', 'custom'],
        default: 'round_robin'
      },
      teamId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      fallbackOption: {
        type: String,
        enum: ['queue', 'auto_resolve', 'notify_email'],
        default: 'queue'
      },
      slaMinutes: { type: Number, default: 60 }
    },
    notifications: {
      notifyAgents: { type: Boolean, default: true },
      notifyCustomer: { type: Boolean, default: true },
      addInternalNote: { type: Boolean, default: false },
      slaBreachAlert: { type: Boolean, default: true }
    },
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
  },

  // ── WhatsApp Catalog Keyword Automation ──────────────────────────────────
  // When any of these keywords are received in a WA DM, the bot automatically
  // replies with a product list message — no LLM required for Phase 1.
  waKeywordAutomation: {
    enabled: { type: Boolean, default: false },
    keywords: {
      type: [String],
      default: ['catalog', 'price', 'menu', 'products', 'shop', 'buy', 'order']
    },
    /** Optional header text shown above the product list */
    headerText: { type: String, default: 'Our Products' },
    /** Optional body text */
    bodyText: { type: String, default: 'Here are our available products. Tap one to learn more!' },
    /** Max products to show per auto-response */
    maxProducts: { type: Number, default: 10, min: 1, max: 30 }
  },

  // ── Commerce Guardrails (Phase 2 groundwork) ─────────────────────────────
  autonomousCommerceEnabled: { type: Boolean, default: false },
  autonomousCommerceMaxSendsPerUserPerDay: { type: Number, default: 3 }
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

