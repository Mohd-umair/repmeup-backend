const mongoose = require('mongoose');

const platformConnectionSchema = new mongoose.Schema({
  organization: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Organization',
    required: true
  },
  
  platform: {
    type: String,
    enum: ['instagram', 'facebook', 'youtube', 'google', 'whatsapp'],
    required: true
  },
  
  // Platform account info
  platformUserId: String,
  platformUsername: String,
  platformDisplayName: String,
  platformProfilePicture: String,
  platformEmail: String,
  
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
    businessAccountId: String
  },
  
  // Connection status
  isActive: {
    type: Boolean,
    default: true
  },
  status: {
    type: String,
    enum: ['connected', 'disconnected', 'error', 'token_expired'],
    default: 'connected'
  },
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
  }
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

module.exports = mongoose.model('PlatformConnection', platformConnectionSchema);

