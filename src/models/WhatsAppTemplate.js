const mongoose = require('mongoose');

/**
 * WhatsApp Message Template
 *
 * Mirrors Meta's template schema:
 * https://developers.facebook.com/docs/whatsapp/business-management-api/message-templates
 *
 * Each row is one template per WABA (identified by the PlatformConnection that
 * holds the WABA's access token).  Meta is the source of truth for status; we
 * sync status back through webhooks or on-demand fetches.
 */

// ── Button sub-schema ────────────────────────────────────────────────────────
const buttonSchema = new mongoose.Schema(
  {
    type: {
      type: String,
      enum: ['QUICK_REPLY', 'URL', 'PHONE_NUMBER', 'COPY_CODE', 'OTP', 'FLOW', 'CATALOG'],
      required: true
    },
    text: { type: String, maxlength: 25 },
    url: { type: String, maxlength: 2000 },
    phone_number: { type: String },
    // OTP button subtype
    otp_type: { type: String, enum: ['COPY_CODE', 'ONE_TAP', 'ZERO_TAP'] },
    // URL button: example URL for variables
    example: [String]
  },
  { _id: false }
);

// ── Component sub-schema ─────────────────────────────────────────────────────
const componentSchema = new mongoose.Schema(
  {
    type: {
      type: String,
      enum: ['HEADER', 'BODY', 'FOOTER', 'BUTTONS'],
      required: true
    },
    // Text / body / footer
    text: { type: String, maxlength: 1024 },

    // HEADER format
    format: {
      type: String,
      enum: ['TEXT', 'IMAGE', 'VIDEO', 'DOCUMENT', 'LOCATION']
    },

    // Example values for variable placeholders
    example: {
      header_text: [String],
      body_text: [[String]],
      header_handle: [String],   // resumable-upload handle for media headers
      // Named params example
      header_text_named_params: [{ param_name: String, example: String }],
      body_text_named_params: [{ param_name: String, example: String }]
    },

    // BUTTONS component
    buttons: [buttonSchema],

    // Authentication-specific
    add_security_recommendation: Boolean,
    code_expiration_minutes: Number
  },
  { _id: false }
);

// ── Main template schema ─────────────────────────────────────────────────────
const whatsappTemplateSchema = new mongoose.Schema(
  {
    organization: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Organization',
      required: true
    },

    // The PlatformConnection (WhatsApp WABA) this template belongs to
    connection: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'PlatformConnection',
      required: true
    },

    // Meta-assigned ID (only present after creation)
    metaTemplateId: { type: String, index: true },

    // Meta WABA ID
    wabaId: { type: String },

    // ── Template fields sent to / received from Meta ────────────────────────
    name: {
      type: String,
      required: true,
      maxlength: 512,
      lowercase: true,
      trim: true,
      match: [/^[a-z0-9_]+$/, 'Name must be lowercase alphanumeric with underscores only']
    },

    category: {
      type: String,
      enum: ['AUTHENTICATION', 'MARKETING', 'UTILITY'],
      required: true,
      uppercase: true
    },

    language: {
      type: String,
      required: true,
      default: 'en_US'
    },

    parameter_format: {
      type: String,
      enum: ['POSITIONAL', 'NAMED'],
      default: 'POSITIONAL'
    },

    components: [componentSchema],

    // ── Meta review / quality state ─────────────────────────────────────────
    status: {
      type: String,
      enum: [
        'PENDING',           // created locally, not yet submitted
        'APPROVED',
        'IN_REVIEW',
        'REJECTED',
        'PAUSED',
        'DISABLED',
        'APPEAL_REQUESTED',
        'DELETED'
      ],
      default: 'PENDING'
    },

    qualityScore: {
      type: String,
      enum: ['HIGH', 'MEDIUM', 'LOW', 'UNKNOWN'],
      default: 'UNKNOWN'
    },

    rejectedReason: { type: String },

    // Allow us to know when Meta last set the status
    metaStatusUpdatedAt: { type: Date },

    // ── Housekeeping ─────────────────────────────────────────────────────────
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true
    },

    // Soft delete (archival)
    isArchived: { type: Boolean, default: false }
  },
  { timestamps: true }
);

// Indexes
whatsappTemplateSchema.index({ organization: 1, status: 1 });
whatsappTemplateSchema.index({ organization: 1, category: 1 });
whatsappTemplateSchema.index({ organization: 1, connection: 1 });
whatsappTemplateSchema.index({ metaTemplateId: 1 }, { sparse: true });

module.exports = mongoose.model('WhatsAppTemplate', whatsappTemplateSchema);
