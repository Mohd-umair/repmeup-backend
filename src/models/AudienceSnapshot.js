const mongoose = require('mongoose');

const eligibilityBucketSchema = new mongoose.Schema({
  eligible: { type: Number, default: 0 },
  ineligible: { type: Number, default: 0 }
}, { _id: false });

const audienceSnapshotSchema = new mongoose.Schema({
  organization: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
  sourceType: { type: String, enum: ['filter', 'saved_view', 'segment', 'manual', 'all'], required: true },
  sourceRef: { type: mongoose.Schema.Types.ObjectId, default: null },
  filterQuery: { type: mongoose.Schema.Types.Mixed, default: { logic: 'AND', conditions: [] } },
  totalMatched: { type: Number, default: 0 },
  channelEligibility: {
    whatsapp: { type: eligibilityBucketSchema, default: () => ({}) },
    instagram: { type: eligibilityBucketSchema, default: () => ({}) },
    facebook: { type: eligibilityBucketSchema, default: () => ({}) }
  },
  materializationStatus: {
    type: String,
    enum: ['pending', 'ready', 'failed'],
    default: 'pending'
  },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }
}, { timestamps: true });

audienceSnapshotSchema.index({ organization: 1, createdAt: -1 });

module.exports = mongoose.model('AudienceSnapshot', audienceSnapshotSchema);
