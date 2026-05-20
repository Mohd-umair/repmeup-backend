const mongoose = require('mongoose');

/**
 * Individual recipient row for a WhatsApp campaign.
 *
 * Stored separately from the campaign document so that campaigns with
 * tens-of-thousands of recipients remain manageable.  The worker
 * processes recipients in batches, updating status and sentAt fields.
 */
const whatsappCampaignRecipientSchema = new mongoose.Schema(
  {
    campaign: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'WhatsAppCampaign',
      required: true
    },

    // Denormalised for isolated single-org queries without populating campaign
    organization: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Organization',
      required: true
    },

    // E.164 phone number (e.g. 919876543210)
    phone: {
      type: String,
      required: true,
      trim: true
    },

    // Optional display name parsed from CSV header column
    recipientName: { type: String, trim: true, maxlength: 100 },

    status: {
      type: String,
      enum: ['pending', 'sent', 'failed'],
      default: 'pending'
    },

    // Meta message ID returned on success
    messageId: { type: String },

    // WhatsApp error message on failure
    errorMessage: { type: String, maxlength: 500 },

    sentAt: { type: Date }
  },
  { timestamps: true }
);

// Efficient batch-fetch for the worker (fetch pending per campaign in order)
whatsappCampaignRecipientSchema.index({ campaign: 1, status: 1 });

// Prevent duplicate phone per campaign
whatsappCampaignRecipientSchema.index({ campaign: 1, phone: 1 }, { unique: true });

// Fast look-up for the recipient list page (org-scoped)
whatsappCampaignRecipientSchema.index({ organization: 1, campaign: 1 });

module.exports = mongoose.model('WhatsAppCampaignRecipient', whatsappCampaignRecipientSchema);
