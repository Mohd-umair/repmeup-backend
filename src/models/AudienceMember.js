const mongoose = require('mongoose');

const audienceMemberSchema = new mongoose.Schema({
  organization: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
  audienceSnapshot: { type: mongoose.Schema.Types.ObjectId, ref: 'AudienceSnapshot', required: true, index: true },
  contact: { type: mongoose.Schema.Types.ObjectId, ref: 'Contact', required: true },
  channel: { type: String, enum: ['whatsapp', 'instagram', 'facebook'], required: true },
  eligible: { type: Boolean, default: false },
  exclusionReason: { type: String, default: null },
  platformUserId: { type: String, default: null }
}, { timestamps: { createdAt: true, updatedAt: false } });

audienceMemberSchema.index({ audienceSnapshot: 1, channel: 1, eligible: 1 });
audienceMemberSchema.index({ audienceSnapshot: 1, contact: 1, channel: 1 }, { unique: true });

module.exports = mongoose.model('AudienceMember', audienceMemberSchema);
