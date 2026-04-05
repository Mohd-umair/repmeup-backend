const mongoose = require('mongoose');

/**
 * AI Credit Usage Model - Single Responsibility Principle
 * Tracks individual AI credit usage events for audit and analytics
 */
const aiCreditUsageSchema = new mongoose.Schema({
  organization: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Organization',
    required: true,
    index: true
  },
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  operation: {
    type: String,
    required: true,
    enum: [
      'unknown',
      'post_generation',
      'post_variants',
      'post_variants_image',
      'post_variants_video',
      'content_analysis',
      'sentiment_analysis',
      'knowledge_base_analysis',
      'knowledge_base_from_url',
      'ai_response',
      'ai_assist',
      'ai_assist_regenerate',
      'auto_reply',
      'rollback',
      'rollback_ai_response',
      'rollback_ai_assist',
      'rollback_ai_assist_regenerate',
      'rollback_post_generation',
      'rollback_post_variants',
      'rollback_post_variants_image',
      'rollback_post_variants_video',
      'rollback_knowledge_base_from_url',
      'rollback_ai_response_auto_reply',
      'rollback_ai_response_test'
    ],
    index: true
  },
  creditsUsed: {
    type: Number,
    required: true
  },
  metadata: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  }
}, {
  timestamps: true
});

// Index for efficient queries
aiCreditUsageSchema.index({ organization: 1, createdAt: -1 });
aiCreditUsageSchema.index({ user: 1, createdAt: -1 });

module.exports = mongoose.model('AICreditUsage', aiCreditUsageSchema);
