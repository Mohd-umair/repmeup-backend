const mongoose = require('mongoose');

/**
 * Vendor-side OpenAI usage (tokens / estimated USD), separate from product AI credits.
 */
const aiApiUsageSchema = new mongoose.Schema(
  {
    organization: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Organization',
      default: null,
      index: true
    },
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null
    },
    feature: {
      type: String,
      required: true,
      index: true
    },
    apiKind: {
      type: String,
      enum: ['chat', 'image', 'video'],
      default: 'chat',
      index: true
    },
    model: {
      type: String,
      default: ''
    },
    promptTokens: { type: Number, default: 0 },
    completionTokens: { type: Number, default: 0 },
    totalTokens: { type: Number, default: 0 },
    estimatedUsd: { type: Number, default: 0 },
    /** Chat session messages sent to OpenAI (system/user/assistant roles). Omitted for image/video. */
    promptMessages: { type: mongoose.Schema.Types.Mixed, default: undefined },
    /** Primary assistant text from the completion (chat only). */
    completionText: { type: String, default: '' },
    /** Product AI credits deducted for this call (linked in `deductCredits` when inside same AI context). */
    applicationCreditsUsed: { type: Number, default: undefined },
    /** Mirrors AICreditUsage.operation when credits were linked. */
    creditOperation: { type: String, default: '' },
    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: {}
    }
  },
  { timestamps: true }
);

aiApiUsageSchema.index({ organization: 1, createdAt: -1 });
aiApiUsageSchema.index({ feature: 1, createdAt: -1 });

module.exports = mongoose.model('AiApiUsage', aiApiUsageSchema);
