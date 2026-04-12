const mongoose = require('mongoose');

const interactionSchema = new mongoose.Schema({
  organization: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Organization',
    required: true,
    index: true
  },
  
  // Platform information
  platform: {
    type: String,
    enum: ['instagram', 'facebook', 'whatsapp', 'youtube', 'google', 'website', 'linkedin'],
    required: true,
    index: true
  },
  platformConnection: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'PlatformConnection'
  },
  type: {
    type: String,
    enum: ['comment', 'dm', 'review', 'mention'],
    required: true,
    index: true
  },
  
  // Unique platform identifier
  platformId: {
    type: String,
    required: true,
    unique: true
  },
  platformUrl: String,
  
  // Content
  content: {
    type: String,
    required: true
  },
  contentType: {
    type: String,
    enum: ['text', 'image', 'video', 'audio'],
    default: 'text'
  },
  language: String,
  
  // Author information
  author: {
    platformId: String,
    name: String,
    username: String,
    email: String,
    profileUrl: String,
    avatarUrl: String,
    followerCount: Number,
    isVerified: Boolean
  },
  
  // Support desk ticket reference
  chatNumber: {
    type: Number,
    default: null,
    index: true
  },
  chatRef: {
    type: String,
    default: null,
    index: true
  },

  // Threading support
  parentId: String,
  threadId: String,
  hasReplies: {
    type: Boolean,
    default: false
  },
  replyCount: {
    type: Number,
    default: 0
  },
  
  // Status tracking
  status: {
    type: String,
    enum: ['unread', 'read', 'replied', 'assigned', 'resolved', 'spam', 'archived'],
    default: 'unread',
    index: true
  },
  isRead: {
    type: Boolean,
    default: false
  },
  readAt: Date,
  readBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },

  /** Agent-facing chat session: open (active) vs closed (hidden from default open list when filtered) */
  chatOpen: {
    type: Boolean,
    default: true,
    index: true
  },
  
  // AI & Sentiment Analysis
  sentiment: {
    type: String,
    enum: ['positive', 'negative', 'neutral'],
    index: true
  },
  sentimentScore: {
    type: Number,
    min: -1,
    max: 1
  },
  sentimentConfidence: {
    type: Number,
    min: 0,
    max: 1
  },
  topics: [String],
  intent: {
    type: String,
    enum: ['inquiry', 'complaint', 'praise', 'feedback', 'support', 'other']
  },
  urgency: {
    type: String,
    enum: ['low', 'medium', 'high', 'urgent'],
    default: 'medium'
  },
  
  // AI response
  aiSuggestion: {
    content: String,
    confidence: Number,
    generatedAt: Date,
    wasUsed: Boolean,
    feedback: {
      type: String,
      enum: ['accepted', 'modified', 'rejected']
    }
  },
  autoReplyEligible: {
    type: Boolean,
    default: false
  },
  autoReplied: {
    type: Boolean,
    default: false
  },
  
  // Escalation tracking
  autoReplyCount: {
    type: Number,
    default: 0,
    index: true
  },
  sentimentHistory: [{
    sentiment: {
      type: String,
      enum: ['positive', 'negative', 'neutral']
    },
    score: Number,
    recordedAt: {
      type: Date,
      default: Date.now
    }
  }],
  escalationScore: {
    type: Number,
    default: 0
  },
  escalationReasons: [String],
  requiresHumanResponse: {
    type: Boolean,
    default: false,
    index: true
  },
  escalatedAt: Date,
  escalationType: {
    type: String,
    enum: ['auto', 'manual', 'keyword', 'sentiment', 'reply_limit', 'ai_confidence', 'intent_routing', 'ai_unresolvable']
  },
  escalationMetadata: {
    triggerKeywords: [String],
    negativeCount: {
      type: Number,
      default: 0
    },
    lowConfidenceCount: {
      type: Number,
      default: 0
    },
    customerFrustrationIndicators: [String],
    // Layer 3: counts how many times customer returned after an AI reply without resolution
    sameTopicReplies: {
      type: Number,
      default: 0
    }
  },
  
  // Assignment
  assignedTo: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    index: true
  },
  assignedAt: Date,
  assignedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  assignmentReason: {
    type: String,
    enum: ['manual', 'auto_rule', 'escalation', 'ai_unable']
  },
  
  // Assignment History (tracks all assignments over time)
  assignmentHistory: [{
    assignedTo: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null  // Can be null for unassignment events
    },
    assignedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
      // optional: null when assigned by system/AI (e.g. processAI job)
    },
    assignedAt: {
      type: Date,
      default: Date.now
    },
    reason: {
      type: String,
      enum: ['manual', 'auto_rule', 'escalation', 'ai_unable', 'reassignment', 'unassignment']
    }
  }],
  
  // Intent bucket (kanban categorization)
  intentBucket: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'IntentBucket',
    index: true
  },
  bucketAssignedBy: {
    type: String,
    enum: ['keyword', 'ai', 'manual'],
    default: 'ai'
  },

  // Labels & categorization
  labels: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Label'
  }],
  priority: {
    type: String,
    enum: ['low', 'medium', 'high', 'urgent'],
    default: 'medium'
  },
  tags: [String],
  
  // Metadata
  metadata: {
    // For social posts
    postId: String,
    postUrl: String,
    postAuthor: String,
    // Post/video title and thumbnail (stored at interaction creation time)
    postTitle: String,        // Generic post title (Facebook, LinkedIn, Twitter/X)
    postThumbnailUrl: String, // Generic post thumbnail
    videoTitle: String,       // YouTube video title
    videoThumbnailUrl: String, // YouTube video thumbnail
    mediaCaption: String,     // Instagram/Facebook media caption (first 200 chars)
    
    // For Instagram/Facebook DM thread: history of incoming messages (chat-style)
    incomingMessages: [{
      mid: String,
      text: String,
      timestamp: Number,
      attachmentUrl: String,  // e.g. Facebook Messenger image payload URL
      attachmentType: String  // e.g. 'image', 'video'
    }],
    lastMid: String,
    instagramAccountId: String,

    // For Facebook Messenger DM thread
    facebookPageId: String,
    rating: {
      type: Number,
      min: 1,
      max: 5
    },
    reviewTitle: String,
    
    // Media attachments
    mediaUrls: [String],
    hasMedia: Boolean,
    
    // Location
    location: String,
    latitude: Number,
    longitude: Number,
    
    // Additional context
    deviceType: String,
    appVersion: String
  },
  
  // Response tracking
  replies: [{
    _id: {
      type: mongoose.Schema.Types.ObjectId,
      auto: true
    },
    content: String,
    sentBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    },
    sentAt: {
      type: Date,
      default: Date.now
    },
    platformResponseId: String,
    wasAutoGenerated: {
      type: Boolean,
      default: false
    },
    usedTemplate: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'ResponseTemplate'
    },
    status: {
      type: String,
      enum: ['sent', 'failed', 'deleted'],
      default: 'sent'
    },
    attachmentUrl: String,
    attachmentType: { type: String, enum: ['image', 'video', 'file', 'audio'] }
  }],
  
  responseCount: {
    type: Number,
    default: 0
  },
  firstResponseTime: Number, // in milliseconds
  averageResponseTime: Number,
  
  // Chat summary (manual or AI-generated)
  summary: {
    type: String,
    trim: true,
    default: null
  },
  summaryGeneratedAt: Date,
  summaryGeneratedBy: {
    type: String,
    enum: ['ai', 'manual'],
    default: null
  },

  // Internal collaboration
  internalNotes: [{
    _id: {
      type: mongoose.Schema.Types.ObjectId,
      auto: true
    },
    note: String,
    addedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    },
    addedAt: {
      type: Date,
      default: Date.now
    },
    isPrivate: {
      type: Boolean,
      default: false
    }
  }],
  
  // Engagement metrics
  engagement: {
    likes: {
      type: Number,
      default: 0
    },
    shares: {
      type: Number,
      default: 0
    },
    views: {
      type: Number,
      default: 0
    },
    replyCount: {
      type: Number,
      default: 0
    }
  },
  
  // Timestamps
  platformCreatedAt: Date,
  respondedAt: Date,
  resolvedAt: Date
}, {
  timestamps: true
});

// Indexes for performance
// Note: platformId index is automatically created by unique: true
interactionSchema.index({ organization: 1, createdAt: -1 });
interactionSchema.index({ organization: 1, status: 1 });
interactionSchema.index({ organization: 1, platform: 1, createdAt: -1 });
interactionSchema.index({ organization: 1, sentiment: 1 });
interactionSchema.index({ assignedTo: 1, status: 1 });
interactionSchema.index({ 'metadata.postId': 1 });
interactionSchema.index({ requiresHumanResponse: 1, assignedTo: 1 });
interactionSchema.index({ organization: 1, requiresHumanResponse: 1 });
interactionSchema.index({ organization: 1, intentBucket: 1, platformCreatedAt: -1 });

// Update response count when adding replies
interactionSchema.pre('save', function(next) {
  if (this.isModified('replies')) {
    this.responseCount = this.replies.length;
    
    if (this.replies.length > 0 && !this.respondedAt) {
      this.respondedAt = this.replies[0].sentAt;
      
      // Calculate first response time
      if (this.platformCreatedAt) {
        this.firstResponseTime = this.respondedAt - this.platformCreatedAt;
      }
    }
  }
  next();
});

// Method to add reply
interactionSchema.methods.addReply = function(content, userId, platformResponseId = null, wasAutoGenerated = false, attachmentUrl = null, attachmentType = null) {
  const reply = {
    content,
    sentBy: userId,
    sentAt: new Date(),
    platformResponseId,
    wasAutoGenerated
  };
  if (attachmentUrl) reply.attachmentUrl = attachmentUrl;
  if (attachmentType) reply.attachmentType = attachmentType;
  this.replies.push(reply);
  
  // Increment auto-reply count if this was auto-generated
  if (wasAutoGenerated) {
    this.autoReplyCount = (this.autoReplyCount || 0) + 1;
    console.log(`✅ [Interaction] Auto-reply count incremented to ${this.autoReplyCount} for interaction ${this._id}`);
  }
  
  this.status = 'replied';
  if (!this.respondedAt) {
    this.respondedAt = new Date();
  }
  return this.save();
};

// Method to assign to agent
interactionSchema.methods.assignTo = function(userId, assignedBy, reason = 'manual') {
  this.assignedTo = userId;
  this.assignedBy = assignedBy;
  this.assignedAt = new Date();
  this.assignmentReason = reason;
  // Preserve 'replied'/'resolved' status — a replied chat assigned for follow-up should
  // not lose its 'replied' status. Agents can still see assignedTo and act accordingly.
  if (this.status !== 'replied' && this.status !== 'resolved') {
    this.status = 'assigned';
  }
  
  // Add to assignment history
  if (!this.assignmentHistory) {
    this.assignmentHistory = [];
  }
  this.assignmentHistory.push({
    assignedTo: userId,
    assignedBy: assignedBy,
    assignedAt: new Date(),
    reason: reason
  });
  
  return this.save();
};

// Method to add internal note
interactionSchema.methods.addNote = function(note, userId, isPrivate = false) {
  this.internalNotes.push({
    note,
    addedBy: userId,
    addedAt: new Date(),
    isPrivate
  });
  return this.save();
};

// Method to escalate to human agent
interactionSchema.methods.escalateToHuman = function(reasons = [], escalationType = 'auto', metadata = {}) {
  this.requiresHumanResponse = true;
  this.escalatedAt = new Date();
  this.escalationReasons = reasons;
  this.escalationType = escalationType;
  this.escalationMetadata = {
    ...this.escalationMetadata,
    ...metadata
  };
  // Only change status when the conversation has NOT already been answered.
  // A conversation where AI/human already sent a reply (status = 'replied' or 'resolved')
  // should NOT be demoted back to 'assigned' — it was answered, just flagged for follow-up.
  if (this.status !== 'replied' && this.status !== 'resolved' && this.status !== 'assigned') {
    this.status = 'assigned';
  }
  return this.save();
};

// Method to track sentiment for escalation
interactionSchema.methods.trackSentiment = function(sentiment, score) {
  this.sentimentHistory.push({
    sentiment,
    score,
    recordedAt: new Date()
  });
  
  // Count negative sentiments
  const negativeCount = this.sentimentHistory.filter(s => s.sentiment === 'negative').length;
  if (this.escalationMetadata) {
    this.escalationMetadata.negativeCount = negativeCount;
  } else {
    this.escalationMetadata = { negativeCount };
  }
  
  return this.save();
};

module.exports = mongoose.model('Interaction', interactionSchema);

