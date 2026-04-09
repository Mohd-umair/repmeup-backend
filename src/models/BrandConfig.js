const mongoose = require('mongoose');

const hashtagStrategySchema = new mongoose.Schema({
  avgCount: { type: Number, default: 0 },
  branded: [{ type: String, trim: true }],
  generic: [{ type: String, trim: true }]
}, { _id: false });

const brandProfileSchema = new mongoose.Schema({
  writingStyle: { type: String, trim: true, default: '' },
  emojiUsage: {
    type: String,
    enum: ['heavy', 'moderate', 'minimal', 'none'],
    default: 'moderate'
  },
  recurringEmojis: [{ type: String, trim: true }],
  hashtagStrategy: { type: hashtagStrategySchema, default: () => ({}) },
  ctaStyle: [{ type: String, trim: true }],
  personalityDescriptors: [{ type: String, trim: true }],

  colorPalette: [{ type: String, trim: true }],
  visualComposition: { type: String, trim: true, default: '' },
  typographyStyle: { type: String, trim: true, default: '' },
  logoPlacement: { type: String, trim: true, default: '' },
  imageMood: { type: String, trim: true, default: '' },

  analyzedPostCount: { type: Number, default: 0 },
  analyzedAt: { type: Date, default: null },
  confidence: {
    type: String,
    enum: ['high', 'medium', 'low'],
    default: 'low'
  }
}, { _id: false });

/**
 * Brand configuration for Social Media Autopilot.
 * One per organization. Used for AI generation and compliance.
 */
const brandConfigSchema = new mongoose.Schema({
  organization: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Organization',
    required: true,
    unique: true
  },
  toneOfVoice: {
    type: String,
    enum: ['professional', 'casual', 'friendly', 'authoritative', 'playful', 'inspirational', 'neutral'],
    default: 'professional'
  },
  personalityTags: [{
    type: String,
    trim: true
  }],
  bannedWords: [{
    type: String,
    trim: true
  }],
  approvedHashtags: [{
    type: String,
    trim: true
  }],
  legalDisclaimers: {
    type: String,
    trim: true,
    default: ''
  },
  voiceLastTrainedAt: {
    type: Date,
    default: null
  },

  brandProfile: { type: brandProfileSchema, default: () => ({}) },

  brandProfileOverrides: {
    type: mongoose.Schema.Types.Mixed,
    default: null
  }
}, {
  timestamps: true
});

module.exports = mongoose.model('BrandConfig', brandConfigSchema);
