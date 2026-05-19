const mongoose = require('mongoose');

const stepSchema = new mongoose.Schema({
  order: { type: Number, required: true },
  label: { type: String },
  templateId: { type: mongoose.Schema.Types.ObjectId, ref: 'WhatsAppTemplate' },
  messageText: String,
  delaySec: { type: Number, default: 0 },
  branchOn: {
    type: String,
    enum: ['reply_contains', 'button_clicked', 'no_reply', null],
    default: null
  },
  branches: [{
    match: String,
    nextStep: Number
  }]
}, { _id: false });

const whatsAppFlowSchema = new mongoose.Schema({
  organization: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Organization',
    required: true,
    index: true
  },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  name: { type: String, required: true, trim: true },
  description: String,
  isBlueprint: { type: Boolean, default: false },
  trigger: {
    type: {
      type: String,
      enum: ['keyword', 'new_lead', 'first_message', 'manual', 'webhook', 'appointment', 'order'],
      default: 'keyword'
    },
    value: String
  },
  status: {
    type: String,
    enum: ['draft', 'active', 'paused', 'archived'],
    default: 'draft',
    index: true
  },
  steps: [stepSchema],
  stats: {
    triggered: { type: Number, default: 0 },
    completed: { type: Number, default: 0 },
    converted: { type: Number, default: 0 }
  }
}, { timestamps: true });

whatsAppFlowSchema.index({ organization: 1, status: 1 });

module.exports = mongoose.model('WhatsAppFlow', whatsAppFlowSchema);
