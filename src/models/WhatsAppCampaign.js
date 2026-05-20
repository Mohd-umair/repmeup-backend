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

    stats: { type: statsSchema, default: () => ({}) },

    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    }
  },
  { timestamps: true }
);

// Composite indexes for common queries
whatsappCampaignSchema.index({ organization: 1, status: 1 });
whatsappCampaignSchema.index({ organization: 1, createdAt: -1 });
whatsappCampaignSchema.index({ status: 1, scheduledAt: 1 }); // for schedule-poller

module.exports = mongoose.model('WhatsAppCampaign', whatsappCampaignSchema);
