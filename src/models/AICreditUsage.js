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
      'post_generation', 
      'content_analysis', 
      'sentiment_analysis', 
      'knowledge_base_analysis', 
      'knowledge_base_from_url',
      'ai_response',
      'auto_reply'
    ],
    index: true
  },
  creditsUsed: {
    type: Number,
    required: true,
    min: 1
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
