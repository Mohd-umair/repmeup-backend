const mongoose = require('mongoose');

/**
 * Generic idempotency guard for mutating endpoints that can be double-fired
 * by a client (double-click, retry-on-timeout, flaky network) where a repeat
 * call must NOT repeat side effects — most importantly duplicate AI-credit
 * deduction or duplicate generated assets.
 *
 * Usage: see `utils/idempotency.js#runIdempotent`. One record is created
 * per (organization, scope, key) via the unique index below; a second
 * concurrent/retried call with the same key hits the duplicate-key error and
 * is treated as "already in flight / already done" instead of re-running.
 *
 * `result` intentionally stores only small JSON-safe response payloads
 * (never raw image buffers) — see callers.
 */
const idempotencyRecordSchema = new mongoose.Schema({
  organization: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Organization',
    required: true
  },
  scope: { type: String, required: true }, // e.g. 'content-studio.upload', 'posts.generate-variant-image'
  key: { type: String, required: true },
  status: { type: String, enum: ['pending', 'done'], default: 'pending' },
  result: { type: mongoose.Schema.Types.Mixed, default: null },
  createdAt: { type: Date, default: Date.now }
});

idempotencyRecordSchema.index({ organization: 1, scope: 1, key: 1 }, { unique: true });
// Safety-net TTL — even if a caller never re-checks, stale claims self-clean.
idempotencyRecordSchema.index({ createdAt: 1 }, { expireAfterSeconds: 24 * 60 * 60 });

module.exports = mongoose.model('IdempotencyRecord', idempotencyRecordSchema);
