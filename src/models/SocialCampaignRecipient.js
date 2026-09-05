const mongoose = require('mongoose');

const socialCampaignRecipientSchema = new mongoose.Schema({
  organization: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
  campaign: { type: mongoose.Schema.Types.ObjectId, ref: 'Campaign', required: true, index: true },
  contact: { type: mongoose.Schema.Types.ObjectId, ref: 'Contact', required: true },
  platformUserId: { type: String, required: true },
  status: { type: String, enum: ['pending', 'processing', 'sent', 'failed', 'skipped'], default: 'pending' },
  claimedAt: { type: Date, default: null },
  errorMessage: { type: String, default: null },
  sentAt: { type: Date, default: null },
  repliedAt: { type: Date, default: null },
  messageId: { type: String, default: null }
}, { timestamps: true });

socialCampaignRecipientSchema.index({ campaign: 1, status: 1 });
socialCampaignRecipientSchema.index({ campaign: 1, contact: 1 }, { unique: true });
socialCampaignRecipientSchema.index({ organization: 1, platformUserId: 1, sentAt: -1 });

module.exports = mongoose.model('SocialCampaignRecipient', socialCampaignRecipientSchema);
