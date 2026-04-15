const mongoose = require('mongoose');

const intentBucketSchema = new mongoose.Schema({
  organization: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Organization',
    required: true,
    index: true
  },
  name: {
    type: String,
    required: true,
    trim: true
  },
  color: {
    type: String,
    default: '#3B82F6',
    match: /^#[0-9A-Fa-f]{6}$/
  },
  icon: {
    type: String,
    default: 'fas fa-tag'
  },
  order: {
    type: Number,
    default: 0
  },
  keywords: [{
    type: String,
    trim: true,
    lowercase: true
  }],
  aiPromptHint: {
    type: String,
    trim: true
  },
  replyEnabled: {
    type: Boolean,
    default: true
  },
  replyTone: {
    type: String,
    enum: ['professional', 'casual', 'friendly', 'authoritative', 'playful', 'inspirational', 'neutral', null],
    default: null
  },
  replyLanguage: {
    type: String,
    enum: ['english', 'hindi', 'hinglish', 'auto'],
    default: 'auto'
  },
  replyPrompt: {
    type: String,
    trim: true,
    maxlength: 500
  },
  isDefault: {
    type: Boolean,
    default: false
  },
  /** Designated fallback bucket: interactions escalated by AI (no KB / unresolvable) land here */
  isFallback: {
    type: Boolean,
    default: false
  },
  isActive: {
    type: Boolean,
    default: true
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }
}, {
  timestamps: true
});

intentBucketSchema.index({ organization: 1, order: 1 });
intentBucketSchema.index({ organization: 1, name: 1 }, { unique: true });
intentBucketSchema.index({ organization: 1, isDefault: 1 });
intentBucketSchema.index({ organization: 1, isFallback: 1 });

module.exports = mongoose.model('IntentBucket', intentBucketSchema);
