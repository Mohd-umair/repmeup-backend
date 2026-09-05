const mongoose = require('mongoose');

const mergeAuditLogSchema = new mongoose.Schema({
  organization: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
  primaryContact: { type: mongoose.Schema.Types.ObjectId, ref: 'Contact', required: true },
  secondaryContact: { type: mongoose.Schema.Types.ObjectId, ref: 'Contact', default: null },
  secondaryContactSnapshot: { type: mongoose.Schema.Types.Mixed, default: {} },
  fieldResolutions: { type: mongoose.Schema.Types.Mixed, default: {} },
  mergedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  mergedAt: { type: Date, default: Date.now }
}, { timestamps: true });

mergeAuditLogSchema.index({ organization: 1, primaryContact: 1, mergedAt: -1 });

module.exports = mongoose.model('MergeAuditLog', mergeAuditLogSchema);
