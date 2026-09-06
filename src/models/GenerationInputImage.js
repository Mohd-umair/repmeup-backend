const mongoose = require('mongoose');

/**
 * Ephemeral input image for the Content Studio "Product Shoot" flow.
 *
 * WHY a separate model from `BrandReferenceImage`:
 * `BrandReferenceImage` is a curated, org-wide, durable style library (max 20
 * images, drives every future `reference` generation, feeds the Vision style
 * cache and Design Memory). A one-off product photo uploaded for a single
 * shoot is a different concept — it should NOT consume the 20-slot cap or
 * silently change the org's global style. So uploads default to ephemeral
 * (`expiresAt` set, auto-cleaned) unless a user with Brand Hub write access
 * explicitly promotes it (`promotedReferenceImage` gets set, `expiresAt`
 * cleared so cleanup skips it going forward).
 *
 * Lifecycle: uploaded (`ready`) → used in 0+ generations → either expires
 * and gets purged by `processContentStudioInputCleanup`, or is promoted to a
 * permanent `BrandReferenceImage`.
 */
const generationInputImageSchema = new mongoose.Schema({
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
  purpose: {
    type: String,
    enum: ['product_shoot'],
    default: 'product_shoot'
  },
  imageUrl: { type: String, required: true },
  s3Key: { type: String, default: null },
  storageType: { type: String, enum: ['local', 's3'], default: 'local' },
  mimeType: { type: String, required: true },
  size: { type: Number, required: true },
  width: { type: Number, default: null },
  height: { type: Number, default: null },
  status: {
    type: String,
    enum: ['ready', 'failed'],
    default: 'ready'
  },
  // Idempotency: a client-supplied key (e.g. re-submitted upload after a
  // dropped response) maps to exactly one record per organization+user.
  idempotencyKey: { type: String, default: null },
  // Null once promoted — cleared so the cleanup job stops treating this
  // record (and its now-shared storage object) as expired/disposable.
  expiresAt: { type: Date, default: null, index: true },
  promotedReferenceImage: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'BrandReferenceImage',
    default: null
  },
  promotedAt: { type: Date, default: null },
  promotedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null
  }
}, {
  timestamps: true
});

generationInputImageSchema.index({ organization: 1, user: 1, createdAt: -1 });
generationInputImageSchema.index(
  { organization: 1, user: 1, idempotencyKey: 1 },
  { unique: true, partialFilterExpression: { idempotencyKey: { $type: 'string' } } }
);
// Safety-net DB-level TTL. Storage objects (S3/local) are NOT deleted by
// this — that requires the explicit cleanup job, since Mongo TTL only
// removes the document, never the underlying file/object.
generationInputImageSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('GenerationInputImage', generationInputImageSchema);
