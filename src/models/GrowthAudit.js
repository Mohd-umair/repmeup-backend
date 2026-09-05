const mongoose = require('mongoose');

/**
 * GrowthAudit — public lead-magnet audit document.
 *
 * Lifecycle: queued → processing → done | partial | failed
 *
 * Pre-lead: only score, grade, revenueLeak.number, and blurred module
 * summaries are exposed via GET /:id.
 * Post-lead (after POST /:id/lead): all modules + shareToken returned.
 *
 * Auto-deleted after 30 days via the expiresAt TTL index.
 */
const growthAuditSchema = new mongoose.Schema({
  // ── Inputs ─────────────────────────────────────────────────────────────────
  igHandle:     { type: String, trim: true },
  fbPageUrl:    { type: String, trim: true },
  googleQuery:  { type: String, trim: true }, // business name + city
  businessName: { type: String, trim: true },
  industry:     { type: String, trim: true, default: 'general' },
  avgOrderValue:{ type: Number, default: 0 }, // INR

  // ── Job lifecycle ───────────────────────────────────────────────────────────
  status: {
    type: String,
    enum: ['queued', 'processing', 'done', 'partial', 'failed'],
    default: 'queued',
    index: true
  },
  startedAt:   { type: Date },
  completedAt: { type: Date },
  errorMessage:{ type: String, default: '' },

  // Abuse tracking — SHA-256 of originating IP (never store raw IP)
  ipHash: { type: String },

  // ── Module results ──────────────────────────────────────────────────────────
  // All computation happens on the backend. Frontend receives the processed DTO.
  modules: {
    // M1 — Social Presence Audit
    socialPresence: {
      // Instagram
      igFollowers: Number,
      igPosts: Number,
      igComments: Number,
      igReplies: Number,
      igReplyRate: Number,           // 0–100 %
      igBuyingIntentCount: Number,   // comments that contain buying-intent keywords
      igUnansweredBuying: Number,
      igPostingGaps: Boolean,        // true if ≥7 day gap in last 30 days
      igAvgEngagement: Number,       // engagement rate %
      // Facebook
      fbPosts: Number,
      fbComments: Number,
      fbReplies: Number,
      fbReplyRate: Number
    },
    // M2 — Reputation Audit
    reputation: {
      google: {
        rating: Number,
        totalReviews: Number,
        ownerReplyRate: Number,    // 0–100 %
        unansweredNegative: Number
      },
      facebook: {
        rating: Number,
        commentReplyRate: Number
      }
    },
    // M4 — Revenue Leak
    revenueLeak: {
      number: Number,              // INR/month (the WOW number)
      unansweredBuying: Number,    // count driving the number
      estimatedConversion: Number, // fraction e.g. 0.08
      avgOrderValue: Number,       // AOV used in formula
      formula: String              // human-readable formula explanation
    },
    // M8 — AI Recommendations (GPT-written)
    aiRecommendations: [{
      _id: false,
      rank: Number,
      title: String,
      explanation: String,
      expectedImpact: String,      // e.g. "+42 Leads/month"
      feature: String              // RepMeUp feature that fixes this
    }],
    // M9 — Opportunity Calculator
    opportunityCalc: [{
      _id: false,
      metric: String,              // e.g. "Comment Reply Rate"
      currentValue: Number,        // e.g. 18
      improvedValue: Number,       // e.g. 80
      unit: String,                // e.g. "%"
      upliftLabel: String,         // e.g. "+38% Conversions"
      upliftFraction: Number       // e.g. 0.38
    }]
  },

  // Industry benchmarks snapshot at scoring time
  benchmarks: { type: mongoose.Schema.Types.Mixed, default: {} },

  // ── Scoring ─────────────────────────────────────────────────────────────────
  score: { type: Number, min: 0, max: 100 }, // 0–100 Conversation Score
  grade: { type: String, enum: ['A', 'B', 'C', 'D', 'F'] },

  // ── Lead gate ───────────────────────────────────────────────────────────────
  leadCaptured: { type: Boolean, default: false },
  lead: {
    name:     { type: String, trim: true },
    email:    { type: String, trim: true, lowercase: true },
    phone:    { type: String, trim: true },
    business: { type: String, trim: true }
  },

  // ── Sharing ─────────────────────────────────────────────────────────────────
  shareToken: { type: String }, // UUID — indexed below (sparse unique)

  // ── TTL — auto-delete 30 days after creation ─────────────────────────────
  expiresAt: { type: Date, index: { expireAfterSeconds: 0 } }
}, {
  timestamps: true
});

// Index for deduplication by handle + industry
growthAuditSchema.index({ igHandle: 1, industry: 1, createdAt: -1 });
growthAuditSchema.index({ shareToken: 1 }, { sparse: true });
growthAuditSchema.index({ 'lead.email': 1 }, { sparse: true });

module.exports = mongoose.model('GrowthAudit', growthAuditSchema);
