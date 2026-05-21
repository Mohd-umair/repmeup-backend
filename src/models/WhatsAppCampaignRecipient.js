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

    /**
     * Per-recipient parameter values used to build the Cloud-API `components`
     * array at send time. Keys are slot identifiers:
     *
     *   header.text.{idx|name}     header TEXT variables (positional/named)
     *   body.{idx|name}            body variables
     *   button.url.{i}.{idx}       URL button variables (button index i, var idx)
     *
     * Values are always strings; the campaign builder substitutes them
     * into the template at runtime.
     */
    templateParams: { type: mongoose.Schema.Types.Mixed, default: undefined },

    /** API send outcome: pending → sent | failed */
    status: {
      type: String,
      enum: ['pending', 'sent', 'failed'],
      default: 'pending'
    },

    /**
     * Meta delivery lifecycle from webhooks: sent → delivered → read | failed
     * (mirrors WhatsApp Cloud API status events)
     */
    deliveryStatus: {
      type: String,
      enum: ['pending', 'sent', 'delivered', 'read', 'failed'],
      default: 'pending'
    },

    deliveryStatusAt: { type: Date },

    /** Meta webhook failure detail (when deliveryStatus === 'failed') */
    deliveryError: { type: String, maxlength: 500 },

    // Meta message ID returned on success
    messageId: { type: String, index: true, sparse: true },

    // WhatsApp error message on API send failure
    errorMessage: { type: String, maxlength: 500 },

    sentAt: { type: Date },

    /** Set when the customer sends an inbound message after this campaign send */
    repliedAt: { type: Date }
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
