const mongoose = require('mongoose');

/**
 * Pre-aggregated daily voice IVR analytics.
 * Computed by the post-call worker so the dashboard avoids heavy ad-hoc aggregations.
 */
const voiceAnalyticsSummarySchema = new mongoose.Schema({
  organization: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Organization',
    required: true,
    index: true
  },
  /** UTC midnight of the day this summary represents */
  date: { type: Date, required: true, index: true },

  totalCalls: { type: Number, default: 0 },
  answeredCalls: { type: Number, default: 0 },
  failedCalls: { type: Number, default: 0 },
  totalDurationSeconds: { type: Number, default: 0 },
  avgDurationSeconds: { type: Number, default: 0 },

  byAgent: [{
    agentId: { type: mongoose.Schema.Types.ObjectId, ref: 'VoiceAgent' },
    agentName: String,
    count: Number,
    avgDurationSeconds: Number
  }],
  byIntent: [{ intent: String, count: Number }],
  bySentiment: [{ sentiment: String, count: Number }],

  humanHandoffs: { type: Number, default: 0 },
  followUpsSent: { type: Number, default: 0 }
}, { timestamps: true });

voiceAnalyticsSummarySchema.index({ organization: 1, date: 1 }, { unique: true });

module.exports = mongoose.model('VoiceAnalyticsSummary', voiceAnalyticsSummarySchema);
