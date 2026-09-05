const mongoose = require('mongoose');

/**
 * WhatsApp Broadcast Campaign
 *
 * Represents a one-time message blast to a list of phone numbers using
 * an approved WhatsApp Message Template.  Recipients are stored separately
 * in WhatsAppCampaignRecipient so campaigns can scale to 50k+ contacts
 * without hitting MongoDB's 16 MB document limit.
 */

const templateSnapshotSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    languageCode: { type: String, default: 'en' },
    // Frozen full template definition (uppercase Meta shape) so the worker
    // can build per-recipient Cloud-API components without re-fetching the template.
    definition: { type: mongoose.Schema.Types.Mixed },
    parameterFormat: {
      type: String,
      enum: ['POSITIONAL', 'NAMED'],
      default: 'POSITIONAL'
    },
    // Deprecated single-shot Cloud-API components.
    // Retained for older campaigns; new campaigns build per-recipient at send time.
    components: { type: mongoose.Schema.Types.Mixed, default: [] }
  },
  { _id: false }
);

const statsSchema = new mongoose.Schema(
  {
    total:   { type: Number, default: 0 },
    sent:    { type: Number, default: 0 },
    failed:  { type: Number, default: 0 },
    pending: { type: Number, default: 0 }
  },
  { _id: false }
);

/**
 * Campaign-level header media for IMAGE / VIDEO / DOCUMENT templates.
 * The same media is sent to every recipient; per-recipient media via CSV
 * column mapping is a possible future extension.
 */
const headerMediaSchema = new mongoose.Schema(
  {
    kind: { type: String, enum: ['IMAGE', 'VIDEO', 'DOCUMENT'] },
    url:  { type: String, maxlength: 2048 },
    filename: { type: String, maxlength: 256 },
    mediaLibraryId: { type: mongoose.Schema.Types.ObjectId, ref: 'Media' }
  },
  { _id: false }
);

/** Campaign-level header location (sent to all recipients) for LOCATION templates. */
const headerLocationSchema = new mongoose.Schema(
  {
    latitude:  { type: Number },
    longitude: { type: Number },
    name:    { type: String, maxlength: 200 },
    address: { type: String, maxlength: 500 }
  },
  { _id: false }
);

/** One dynamic URL button: {index, value} maps to button at that position. */
const urlButtonParamSchema = new mongoose.Schema(
  {
    index: { type: Number, required: true, min: 0, max: 9 },
    value: { type: String, default: '', maxlength: 500 }
  },
  { _id: false }
);

const whatsappCampaignSchema = new mongoose.Schema(
  {
    organization: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Organization',
      required: true,
      index: true
    },

    // WhatsApp PlatformConnection (determines phoneNumberId + accessToken)
    connection: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'PlatformConnection',
      required: true
    },

    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 200
    },

    // Reference to the WhatsAppTemplate document
    templateRef: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'WhatsAppTemplate'
    },

    // Snapshot of the template fields used at launch time — immutable after send
    templateSnapshot: templateSnapshotSchema,

    // ── Campaign-level Cloud-API parameter sources ─────────────────────────
    // Media header (one file for the whole campaign)
    headerMedia: { type: headerMediaSchema, default: undefined },

    // Location header (one location for the whole campaign)
    headerLocation: { type: headerLocationSchema, default: undefined },

    // Dynamic URL button values (positional, by button index)
    urlButtonParams: { type: [urlButtonParamSchema], default: [] },

    /**
     * Saved CSV → template-variable mapping for the most recent recipient import.
     * Example:
     *   {
     *     phoneColumn: 'phone',
     *     nameColumn: 'first_name',
     *     slots: { 'body.1': 'first_name', 'header.1': 'salutation' }
     *   }
     * Useful for reproducing or re-importing recipients.
     */
    variableMapping: { type: mongoose.Schema.Types.Mixed, default: undefined },

    /** Audience import settings — default country for local numbers, optional CSV country column. */
    audienceSettings: {
      defaultCountry: { type: String, maxlength: 2, uppercase: true },
      countryCodeColumn: { type: String, maxlength: 100 }
    },

    status: {
      type: String,
      enum: ['draft', 'scheduled', 'running', 'paused', 'completed', 'cancelled', 'failed'],
      default: 'draft',
      index: true
    },

    // null = send immediately on launch; future date = scheduled send
    scheduledAt: { type: Date, default: null },

    // Set when the campaign actually starts sending
    startedAt: { type: Date },

    // Set when the campaign finishes (completed / failed / cancelled)
    finishedAt: { type: Date },

    /** Set when auto-paused by Meta rate-limit governance */
    pauseReason: { type: String, maxlength: 200 },

    stats: { type: statsSchema, default: () => ({}) },

    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    },

    /** True for the demo/sample campaign seeded into a trial workspace (display-only). */
    seeded: { type: Boolean, default: false }
  },
  { timestamps: true }
);

// Composite indexes for common queries
whatsappCampaignSchema.index({ organization: 1, status: 1 });
whatsappCampaignSchema.index({ organization: 1, createdAt: -1 });
whatsappCampaignSchema.index({ status: 1, scheduledAt: 1 }); // for schedule-poller

module.exports = mongoose.model('WhatsAppCampaign', whatsappCampaignSchema);
