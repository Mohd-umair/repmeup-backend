const mongoose = require('mongoose');

/**
 * InteraktLog — one row per interaction with Interakt, in either direction.
 *
 * Two directions are recorded:
 *   outbound  — an API call WE made to Interakt (tp-signup, webhook config, unsubscribe)
 *   inbound   — an event INTERAKT sent us (WABA_ONBOARDED, WABA_ONBOARDING_FAILED)
 *
 * The point of this collection is answering "why did this number not connect?"
 * without reading pm2 logs, so the failure reason is a first-class field rather
 * than something buried in a payload blob.
 *
 * Retention: 180 days via TTL. These are operational breadcrumbs, not billing
 * records — nothing downstream reads them, so they can expire safely.
 */
const interaktLogSchema = new mongoose.Schema({
  /** Tenant this event belongs to. Null for inbound events we could not attribute. */
  organization: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Organization',
    default: null,
    index: true
  },
  platformConnection: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'PlatformConnection',
    default: null
  },

  direction: {
    type: String,
    enum: ['outbound', 'inbound'],
    required: true,
    index: true
  },

  /**
   * What happened, in our own vocabulary — stable regardless of Interakt renaming
   * their events. Outbound uses the operation name; inbound uses the event name.
   */
  action: {
    type: String,
    required: true,
    index: true
  },

  status: {
    type: String,
    enum: ['success', 'failed'],
    required: true,
    index: true
  },

  /** Human-readable reason. Populated on failure; the whole reason this model exists. */
  reason: { type: String, default: null },

  // ── Correlation ────────────────────────────────────────────────────────────
  wabaId: { type: String, default: null, index: true },
  phoneNumberId: { type: String, default: null, index: true },
  solutionId: { type: String, default: null },

  // ── Transport detail (outbound only) ───────────────────────────────────────
  endpoint: { type: String, default: null },
  httpStatus: { type: Number, default: null },
  durationMs: { type: Number, default: null },

  /** Meta/Interakt error codes, when the response carried them. */
  errorCode: { type: String, default: null },

  /**
   * Request/response bodies, secrets stripped. Mixed because Interakt's shapes vary
   * between the partner API and the Graph proxy.
   */
  request: { type: mongoose.Schema.Types.Mixed, default: null },
  response: { type: mongoose.Schema.Types.Mixed, default: null }
}, { timestamps: true });

// Super-admin list view: newest first, filtered by any of these.
interaktLogSchema.index({ createdAt: -1 });
interaktLogSchema.index({ organization: 1, createdAt: -1 });
interaktLogSchema.index({ status: 1, createdAt: -1 });
interaktLogSchema.index({ action: 1, createdAt: -1 });
interaktLogSchema.index({ wabaId: 1, createdAt: -1 });

// 180-day retention.
interaktLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: 180 * 24 * 60 * 60 });

module.exports = mongoose.model('InteraktLog', interaktLogSchema);
