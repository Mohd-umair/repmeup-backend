const mongoose = require('mongoose');

/**
 * Brand configuration for Social Media Autopilot.
 * One per organization. Used for AI generation and compliance.
 */
const brandConfigSchema = new mongoose.Schema({
  organization: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Organization',
    required: true,
    unique: true,
    index: true
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
  }
}, {
  timestamps: true
});

brandConfigSchema.index({ organization: 1 });

module.exports = mongoose.model('BrandConfig', brandConfigSchema);
