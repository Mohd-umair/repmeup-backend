const mongoose = require('mongoose');

const stepSchema = new mongoose.Schema({
  order: { type: Number, required: true },
  type: { type: String, enum: ['message', 'wait', 'condition', 'action'], default: 'message' },
  channel: { type: String, enum: ['whatsapp', 'instagram', 'facebook', 'email', 'sms'] },
  content: { type: String },
  templateId: String,
  delaySec: { type: Number, default: 0 },
  condition: { type: mongoose.Schema.Types.Mixed }
}, { _id: false });

const retargetingFlowSchema = new mongoose.Schema({
  organization: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Organization',
    required: true,
    index: true
  },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  name: { type: String, required: true, trim: true },
  description: String,
  status: {
    type: String,
    enum: ['draft', 'active', 'paused', 'archived'],
    default: 'draft',
    index: true
  },
  audience: {
    type: {
      type: String,
      enum: ['ig_engagers', 'abandoned_cart', 'new_leads', 'customer_segment', 'all_contacts'],
      default: 'all_contacts'
    },
    filters: { type: mongoose.Schema.Types.Mixed },
    audienceWindowDays: { type: Number, default: 30 }
  },
  channels: { type: [String], default: ['whatsapp'] },
  steps: [stepSchema],
  settings: {
    frequencyCap: { type: Number, default: 1 },
    frequencyCapWindowDays: { type: Number, default: 30 },
    quietHoursStart: { type: String, default: '22:00' },
    quietHoursEnd: { type: String, default: '08:00' },
    utmSource: String,
    utmMedium: String,
    utmCampaign: String
  },
  stats: {
    enrolled: { type: Number, default: 0 },
    completed: { type: Number, default: 0 },
    converted: { type: Number, default: 0 },
    lastRunAt: Date
  },
  lastEditedAt: Date
}, { timestamps: true });

retargetingFlowSchema.index({ organization: 1, status: 1 });

module.exports = mongoose.model('RetargetingFlow', retargetingFlowSchema);
