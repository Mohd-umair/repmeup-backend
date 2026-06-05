const mongoose = require('mongoose');

const flowNodeSchema = new mongoose.Schema({
  id: { type: String, required: true },
  type: { type: String, required: true, trim: true },
  label: { type: String, trim: true, default: '' },
  position: {
    x: { type: Number, default: 0 },
    y: { type: Number, default: 0 }
  },
  config: { type: mongoose.Schema.Types.Mixed, default: {} },
  supportedChannels: { type: [String], default: [] }
}, { _id: false });

const flowEdgeSchema = new mongoose.Schema({
  id: { type: String, required: true },
  source: { type: String, required: true },
  target: { type: String, required: true },
  label: { type: String, trim: true, default: '' },
  condition: { type: mongoose.Schema.Types.Mixed, default: null }
}, { _id: false });

const automationFlowSchema = new mongoose.Schema({
  organization: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Organization',
    index: true,
    default: null
  },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  name: { type: String, required: true, trim: true, maxlength: 200 },
  description: { type: String, trim: true, maxlength: 2000, default: '' },
  channels: {
    type: [String],
    enum: ['whatsapp', 'instagram', 'facebook'],
    default: ['whatsapp']
  },
  status: {
    type: String,
    enum: ['draft', 'active', 'paused', 'archived'],
    default: 'draft',
    index: true
  },
  version: { type: Number, default: 1 },
  entryNodeId: { type: String, trim: true, default: '' },
  nodes: { type: [flowNodeSchema], default: [] },
  edges: { type: [flowEdgeSchema], default: [] },
  settings: {
    quietHoursStart: { type: String, default: '22:00' },
    quietHoursEnd: { type: String, default: '08:00' },
    frequencyCap: { type: Number, default: 0 },
    frequencyCapWindowDays: { type: Number, default: 30 },
    timezone: { type: String, default: 'Asia/Kolkata' }
  },
  stats: {
    triggered: { type: Number, default: 0 },
    completed: { type: Number, default: 0 },
    converted: { type: Number, default: 0 },
    failed: { type: Number, default: 0 }
  },
  isBlueprint: { type: Boolean, default: false, index: true }
}, { timestamps: true });

automationFlowSchema.index({ organization: 1, status: 1 });
automationFlowSchema.index({ organization: 1, isBlueprint: 1 });

module.exports = mongoose.model('AutomationFlow', automationFlowSchema);
