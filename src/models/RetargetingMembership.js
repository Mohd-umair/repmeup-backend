const mongoose = require('mongoose');

const membershipSchema = new mongoose.Schema({
  organization: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
  flow: { type: mongoose.Schema.Types.ObjectId, ref: 'RetargetingFlow', required: true, index: true },
  contact: { type: mongoose.Schema.Types.ObjectId, ref: 'Contact', required: true },
  currentStep: { type: Number, default: 0 },
  status: {
    type: String,
    enum: ['active', 'completed', 'unsubscribed', 'bounced'],
    default: 'active',
    index: true
  },
  enrolledAt: { type: Date, default: Date.now },
  nextActionAt: { type: Date, index: true },
  completedAt: Date,
  convertedAt: Date,
  lastMessageAt: Date
}, { timestamps: true });

membershipSchema.index({ flow: 1, contact: 1 }, { unique: true });
membershipSchema.index({ organization: 1, nextActionAt: 1, status: 1 });

module.exports = mongoose.model('RetargetingMembership', membershipSchema);
