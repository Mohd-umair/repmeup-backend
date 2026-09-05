const mongoose = require('mongoose');

const duplicateCandidateSchema = new mongoose.Schema({
  organization: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
  contactA: { type: mongoose.Schema.Types.ObjectId, ref: 'Contact', required: true },
  contactB: { type: mongoose.Schema.Types.ObjectId, ref: 'Contact', required: true },
  matchScore: { type: Number, required: true, min: 0, max: 100 },
  matchedOn: [{ type: String }],
  status: { type: String, enum: ['pending', 'merged', 'dismissed'], default: 'pending', index: true },
  detectedAt: { type: Date, default: Date.now },
  reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }
}, { timestamps: true });

duplicateCandidateSchema.index({ organization: 1, status: 1, matchScore: -1 });
duplicateCandidateSchema.index({ organization: 1, contactA: 1, contactB: 1 }, { unique: true });

module.exports = mongoose.model('DuplicateCandidate', duplicateCandidateSchema);
