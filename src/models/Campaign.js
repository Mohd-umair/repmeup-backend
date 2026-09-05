const mongoose = require('mongoose');

const campaignSchema = new mongoose.Schema({
  organization: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
  name: { type: String, required: true, trim: true, maxlength: 160 },
  channel: { type: String, enum: ['whatsapp', 'instagram', 'facebook'], required: true },
  status: {
    type: String,
    enum: ['draft', 'scheduled', 'queued', 'running', 'completed', 'paused', 'cancelled', 'failed'],
    default: 'draft',
    index: true
  },
  audienceSourceType: {
    type: String,
    enum: ['filter', 'saved_view', 'segment', 'manual', 'all'],
    default: 'filter'
  },
  audienceSourceRef: { type: mongoose.Schema.Types.ObjectId, default: null },
  audienceSnapshot: { type: mongoose.Schema.Types.ObjectId, ref: 'AudienceSnapshot', default: null },
  content: { type: mongoose.Schema.Types.Mixed, default: {} },
  connection: { type: mongoose.Schema.Types.ObjectId, ref: 'PlatformConnection', default: null },
  schedule: {
    sendAt: { type: Date, default: null },
    timezone: { type: String, default: 'Asia/Dubai' }
  },
  stats: {
    matched: { type: Number, default: 0 },
    eligible: { type: Number, default: 0 },
    sent: { type: Number, default: 0 },
    delivered: { type: Number, default: 0 },
    read: { type: Number, default: 0 },
    replied: { type: Number, default: 0 },
    failed: { type: Number, default: 0 },
    pending: { type: Number, default: 0 },
    positive: { type: Number, default: 0 },
    negative: { type: Number, default: 0 },
    intents: { type: mongoose.Schema.Types.Mixed, default: {} },
    revenue: { type: Number, default: 0 },
    attributedOrders: { type: Number, default: 0 }
  },
  parentCampaignId: { type: mongoose.Schema.Types.ObjectId, ref: 'Campaign', default: null },
  followUpCondition: { type: String, default: null },
  whatsAppCampaignRef: { type: mongoose.Schema.Types.ObjectId, ref: 'WhatsAppCampaign', default: null },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  startedAt: { type: Date, default: null },
  finishedAt: { type: Date, default: null }
}, { timestamps: true });

campaignSchema.index({ organization: 1, status: 1, createdAt: -1 });
campaignSchema.index({ organization: 1, parentCampaignId: 1 });

module.exports = mongoose.model('Campaign', campaignSchema);
