const mongoose = require('mongoose');

/**
 * Feature catalog — the SINGLE SOURCE OF TRUTH for every gateable behavior in the app.
 *
 * Each row declares one "thing a plan can turn on/off or set a numeric ceiling for".
 * Code that wants to gate behavior reads a key from here (via entitlementsService);
 * the admin UI auto-renders a control for every active row when editing a plan.
 *
 * Rules:
 *   - `key` is namespaced (`area.subject.action`) and used everywhere — never rename it.
 *   - `kind` is enforced by the engine: `boolean` ignores `limit`, `limit` ignores `enabled`.
 *   - `resetPeriod` only makes sense for `limit` features whose value is consumed over time
 *     (e.g. monthly auto-reply credits). The engine resets `Subscription.usageBuckets[key]`
 *     when the period rolls over.
 *   - The catalog is seeded from code (backend/scripts/seedFeatures.js) so devs can
 *     add an enforcement point in the same PR as the feature row, but admins still
 *     edit per-plan values through the UI without engineering involvement.
 */
const FEATURE_KINDS = ['boolean', 'limit', 'enum', 'list', 'json'];
const FEATURE_CATEGORIES = [
  'general',
  'limits',
  'inbox',
  'posts',
  'kb',
  'automation',
  'analytics',
  'commerce',
  'campaigns',
  'integrations'
];
const RESET_PERIODS = ['none', 'daily', 'monthly'];

const featureSchema = new mongoose.Schema(
  {
    key: {
      type: String,
      required: true,
      unique: true,
      trim: true
      // e.g. 'inbox.bucket.chat', 'commerce.whatsappCatalog.enabled'
      // NOTE: do NOT lowercase — catalog keys are case-sensitive identifiers.
    },
    label: {
      type: String,
      required: true,
      trim: true
    },
    description: {
      type: String,
      trim: true,
      default: ''
    },
    category: {
      type: String,
      enum: FEATURE_CATEGORIES,
      required: true,
      default: 'general'
    },
    kind: {
      type: String,
      enum: FEATURE_KINDS,
      required: true
    },
    /** Default applied when a plan doesn't specify a value for this key. */
    defaultValue: {
      type: mongoose.Schema.Types.Mixed
      // boolean: true|false; limit: -1|number; enum: stringValue; list: string[]; json: object
    },
    /** UI hint — `credits | contacts | count | gb | calls | percent | null`. */
    unit: {
      type: String,
      default: null,
      trim: true
    },
    /** For numeric `limit` features that get consumed over a window. */
    resetPeriod: {
      type: String,
      enum: RESET_PERIODS,
      default: 'none'
    },
    /** Allowed values for `enum` features (e.g. ['immediate','scheduled','hybrid']). */
    enumOptions: [{ type: String, trim: true }],
    sortOrder: {
      type: Number,
      default: 100
    },
    /** Inactive features are hidden from the admin form (without breaking enforcement). */
    active: {
      type: Boolean,
      default: true
    }
  },
  { timestamps: true }
);

featureSchema.index({ category: 1, sortOrder: 1 });
featureSchema.index({ active: 1 });

featureSchema.statics.KINDS = FEATURE_KINDS;
featureSchema.statics.CATEGORIES = FEATURE_CATEGORIES;
featureSchema.statics.RESET_PERIODS = RESET_PERIODS;

/** Active catalog ordered for admin display. */
featureSchema.statics.getCatalog = function getCatalog() {
  return this.find({ active: true })
    .sort({ category: 1, sortOrder: 1, key: 1 })
    .lean();
};

module.exports = mongoose.model('Feature', featureSchema);
