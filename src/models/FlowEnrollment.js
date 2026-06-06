const mongoose = require('mongoose');

const historyEntrySchema = new mongoose.Schema({
  nodeId: { type: String, required: true },
  event: { type: String, trim: true, default: '' },
  at: { type: Date, default: Date.now }
}, { _id: false });

const flowEnrollmentSchema = new mongoose.Schema({
  organization: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Organization',
    required: true,
    index: true
  },
  flow: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'AutomationFlow',
    required: true,
    index: true
  },
  flowVersion: { type: Number, default: 1 },
  platform: {
    type: String,
    enum: ['whatsapp', 'instagram', 'facebook'],
    required: true,
    index: true
  },
  platformUserId: { type: String, trim: true, index: true },
  contact: { type: mongoose.Schema.Types.ObjectId, ref: 'Contact' },
  interaction: { type: mongoose.Schema.Types.ObjectId, ref: 'Interaction' },
  currentNodeId: { type: String, trim: true, default: '' },
  variables: { type: mongoose.Schema.Types.Mixed, default: {} },
  status: {
    type: String,
    enum: ['active', 'waiting', 'completed', 'failed', 'dropped'],
    default: 'active',
    index: true
  },
  nextRunAt: { type: Date, index: true },
  lastError: { type: String, trim: true, default: '' },
  history: { type: [historyEntrySchema], default: [] }
}, { timestamps: true });

flowEnrollmentSchema.index({ organization: 1, status: 1, nextRunAt: 1 });
flowEnrollmentSchema.index({ flow: 1, platformUserId: 1, status: 1 });

module.exports = mongoose.model('FlowEnrollment', flowEnrollmentSchema);
