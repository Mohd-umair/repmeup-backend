const mongoose = require('mongoose');

/**
 * GrowthSnapshot — daily persisted Conversation Score for an organization.
 *
 * One document per org per calendar day (UTC).  Used to build 30/60/90-day
 * trend charts in the Phase 2 Growth Intelligence dashboard.
 *
 * Populated either:
 *   • By the nightly cron job (dailyGrowthSnapshot.js)
 *   • On-demand when a user first opens the dashboard (upsert)
 */
const growthSnapshotSchema = new mongoose.Schema({
  organization: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },

  // Calendar day this snapshot represents (midnight UTC)
  date: { type: Date, required: true },

  // ── Conversation Score ──────────────────────────────────────────────────────
  conversationScore: { type: Number, default: 0, min: 0, max: 100 },
  grade:             { type: String, enum: ['A', 'B', 'C', 'D', 'F'], default: 'F' },

  // ── Core metrics ────────────────────────────────────────────────────────────
  responseRate:           { type: Number, default: 0 },  // 0–100 %
  avgResponseTimeMinutes: { type: Number, default: 0 },  // minutes
  unansweredCount:        { type: Number, default: 0 },  // absolute count
  unansweredRate:         { type: Number, default: 0 },  // 0–100 %
  totalInteractions:      { type: Number, default: 0 },

  // ── Revenue ─────────────────────────────────────────────────────────────────
  revenueLeakEstimate:    { type: Number, default: 0 },  // INR per month estimate

  // ── Platform breakdown ───────────────────────────────────────────────────────
  platforms: [{
    platform:     { type: String },
    total:        { type: Number, default: 0 },
    responded:    { type: Number, default: 0 },
    pending:      { type: Number, default: 0 },
    responseRate: { type: Number, default: 0 },
    avgResponseTimeMinutes: { type: Number, default: 0 }
  }],

  // ── Sentiment ───────────────────────────────────────────────────────────────
  sentimentScore: { type: Number, default: 0 },    // 0–100
  positive:       { type: Number, default: 0 },
  negative:       { type: Number, default: 0 },
  neutral:        { type: Number, default: 0 },

}, {
  timestamps: true
});

// Compound unique: one snapshot per org per day
growthSnapshotSchema.index({ organization: 1, date: 1 }, { unique: true });

// Auto-delete after 365 days
growthSnapshotSchema.index({ date: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 365 });

module.exports = mongoose.model('GrowthSnapshot', growthSnapshotSchema);
