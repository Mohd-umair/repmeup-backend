const mongoose = require('mongoose');

const platformConnectionSchema = new mongoose.Schema({
  organization: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Organization',
    required: true
  },
  
  platform: {
    type: String,
    enum: ['instagram', 'facebook', 'youtube', 'google', 'whatsapp', 'linkedin', 'email', 'shopify'],
    required: true
  },
  
  // Platform account info
  platformUserId: String,
  platformUsername: String,
  platformDisplayName: String,
  platformProfilePicture: String,
  platformEmail: String,
  platformPageId: String, // For Facebook Pages (required for fetching comments)
  
  // OAuth tokens (should be encrypted in production)
  accessToken: {
    type: String,
    required: true
  },
  refreshToken: String,
  tokenExpiry: Date,
  scope: [String],
  
  // Platform-specific data
  platformData: {
    // For Instagram/Facebook
    businessAccountId: String,
    pageId: String,
    pageName: String,
    
    // For YouTube
    channelId: String,
    channelName: String,
    
    // For Google Business
    locationIds: [String],
    accountId: String,
    
    // For WhatsApp
    phoneNumberId: String,
    phoneNumber: String,
    displayPhoneNumber: String,
    businessAccountId: String,
    catalogId: String,        // Meta Commerce Catalog ID linked to this WABA phone number

    // WABA identity written by the embedded-signup flow.
    //
    // These MUST stay declared. Mongoose runs in strict mode, so an undeclared
    // path is silently dropped on save — which is exactly what used to happen to
    // `wabaId`. Because whatsappService falls back
    // `wabaId || businessAccountId || process.env.WHATSAPP_BUSINESS_ACCOUNT_ID`,
    // every embedded-signup tenant silently resolved to the shared env WABA.
    wabaId: String,
    wabaName: String,
    businessId: String,
    verifiedName: String,
    qualityRating: String,
    codeVerificationStatus: String,

    /**
     * Which transport carries this connection's API calls.
     *   'meta'    — direct Meta Graph (graph.facebook.com)
     *   'interakt'— Interakt tech-partner proxy (amped-express.interakt.ai)
     * Absent means 'meta', which is correct for every pre-Interakt connection,
     * so no migration is required.
     */
    provider: {
      type: String,
      enum: ['meta', 'interakt'],
      default: 'meta'
    },
    interaktSolutionId: String,
    interaktRegisteredAt: Date,
    interaktWebhookConfiguredAt: Date,
    interaktLastError: String,

    /** Campaign governance — Meta tier / quality / pause state */
    wabaMessagingTier: String,
    wabaQualityRating: String,
    campaignPausedUntil: Date,
    campaignPauseReason: String,

    // For LinkedIn
    organizationId: String,
    organizationName: String,
    organizationUrn: String,
    personUrn: String,

    // For Shopify (Custom App)
    shopDomain: String,    // e.g. my-store.myshopify.com
    shopName: String,
    shopId: String,
    apiVersion: { type: String, default: '2024-10' },

    // For Email (Gmail / Outlook / IMAP)
    emailProvider: {
      type: String,
      enum: ['gmail', 'outlook', 'imap'],
      default: null
    },
    emailAddress: String,           // The connected inbox address
    watchHistoryId: String,         // Gmail: historyId for delta sync via Pub/Sub
    watchExpiry: Date,              // Gmail: watch() expires every 7 days — renewal required
    msSubscriptionId: String,       // Outlook: Microsoft Graph subscription ID
    msSubscriptionExpiry: Date,     // Outlook: Graph subscriptions expire every 3 days
    imapHost: String,
    imapPort: Number,
    imapSecure: { type: Boolean, default: true },
    smtpHost: String,
    smtpPort: Number,
    smtpSecure: { type: Boolean, default: true },
    lastPolledUid: Number           // IMAP: last seen UID for delta polling
  },
  
  // Metadata for connection relationships
  metadata: {
    type: {
      type: String,
      enum: ['user_token', 'account_token', 'page_token'],
      default: 'account_token'
    },
    purpose: {
      type: String,
      enum: ['page_management', 'publishing', 'analytics'],
      default: 'publishing'
    },
    // Link Instagram to parent Facebook Page
    parentConnection: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'PlatformConnection',
      default: null
    },
    accountType: {
      type: String,
      enum: ['business', 'personal', 'creator'],
      default: 'business'
    },
    profilePicture: String,
    followerCount: Number,
    isVerified: Boolean,
    // Instagram-specific: whether the account allows DM access via API
    instagramDmEnabled: {
      type: Boolean,
      default: null  // null = not yet determined
    },
    instagramDmDisabledReason: String,
    // Identifies the OAuth / connection flow used to create this record.
    //  - instagram_login           : Instagram API with Instagram Login (IGAA tokens)
    //  - facebook_login            : Instagram via Facebook Login / Page Manager (EAA tokens)
    //  - whatsapp_embedded_signup  : WhatsApp via Meta Embedded Signup OAuth (per-tenant)
    //  - whatsapp_direct_env       : WhatsApp using shared env-level credentials (dev/single-tenant)
    //  - whatsapp_interakt_signup  : WhatsApp via Embedded Signup with the Interakt solution ID,
    //                                registered with Interakt as tech partner (platformData.provider='interakt')
    connectionType: {
      type: String,
      enum: [
        'instagram_login',
        'facebook_login',
        'whatsapp_embedded_signup',
        'whatsapp_direct_env',
        'whatsapp_interakt_signup',
        null
      ],
      default: null
    },
    // Instagram Login flow: the app-scoped Instagram User ID (ISUID) returned by
    // graph.instagram.com/me. Webhooks use the global IG Business Account ID as
    // entry.id — storing the ISUID here lets the webhook handler self-heal the
    // platformUserId on the first delivery.
    igLoginScopedId: {
      type: String,
      default: null
    }
  },
  
  // Connection status
  isActive: {
    type: Boolean,
    default: true
  },
  status: {
    type: String,
    enum: ['available', 'connected', 'disconnected', 'error', 'token_expired'],
    default: 'available'
  },
  
  // Plan enforcement - does this connection count toward account limit?
  usesAccountSlot: {
    type: Boolean,
    default: true
  },
  
  // When the user explicitly connected this account
  connectedAt: Date,
  disconnectedAt: Date,
  lastSyncAt: Date,
  lastError: {
    message: String,
    code: String,
    timestamp: Date
  },
  
  // Sync settings
  settings: {
    autoSync: {
      type: Boolean,
      default: true
    },
    syncInterval: {
      type: Number,
      default: 5 // minutes
    },
    enableWebhooks: {
      type: Boolean,
      default: true
    },
    syncComments: {
      type: Boolean,
      default: true
    },
    syncDMs: {
      type: Boolean,
      default: true
    },
    syncReviews: {
      type: Boolean,
      default: true
    },
    syncMentions: {
      type: Boolean,
      default: true
    }
  },
  
  // Statistics
  stats: {
    totalInteractionsSynced: {
      type: Number,
      default: 0
    },
    lastSyncCount: {
      type: Number,
      default: 0
    },
    failedSyncAttempts: {
      type: Number,
      default: 0
    }
  },
  
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  /** True for the display-only demo connection seeded into a trial workspace. */
  seeded: { type: Boolean, default: false }
}, {
  timestamps: true
});

// Indexes
platformConnectionSchema.index({ organization: 1, platform: 1 });
platformConnectionSchema.index({ organization: 1, isActive: 1 });
platformConnectionSchema.index({ platformUserId: 1 });

// Compound unique index - one platform account per organization
platformConnectionSchema.index(
  { organization: 1, platform: 1, platformUserId: 1 },
  { unique: true }
);

// Method to update sync stats
platformConnectionSchema.methods.updateSyncStats = function(count, success = true) {
  this.lastSyncAt = new Date();
  this.stats.lastSyncCount = count;
  this.stats.totalInteractionsSynced += count;
  
  if (!success) {
    this.stats.failedSyncAttempts += 1;
    this.status = 'error';
  } else {
    this.stats.failedSyncAttempts = 0;
    this.status = 'connected';
  }
  
  return this.save();
};

// Method to log error
platformConnectionSchema.methods.logError = function(error) {
  this.lastError = {
    message: error.message,
    code: error.code || 'UNKNOWN',
    timestamp: new Date()
  };
  this.status = 'error';
  return this.save();
};

// Check if token is expired
platformConnectionSchema.methods.isTokenExpired = function() {
  if (!this.tokenExpiry) return false;
  return new Date() > this.tokenExpiry;
};

/**
 * Returns the conflicting active PlatformConnection if `platformUserId` is
 * already connected to a DIFFERENT organization on the same platform, or null
 * if it is safe to connect.
 *
 * User-level Facebook tokens (metadata.type === 'user_token') are intentionally
 * excluded — the same Facebook person may admin pages across multiple workspaces.
 *
 * Only active connections are considered; if the other org disconnected the
 * account (isActive: false) the slot is treated as free.
 */
platformConnectionSchema.statics.findCrossOrgConflict = async function(
  platform,
  platformUserId,
  currentOrgId
) {
  if (!platformUserId) return null;
  return this.findOne({
    platform,
    platformUserId,
    organization: { $ne: currentOrgId },
    isActive: true,
    'metadata.type': { $ne: 'user_token' }
  })
    .select('organization platform platformUsername platformDisplayName')
    .lean();
};

module.exports = mongoose.model('PlatformConnection', platformConnectionSchema);

