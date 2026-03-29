const mongoose = require('mongoose');

/**
 * Lightweight job-status store for AI video generation.
 * Auto-expires after 2 hours via MongoDB TTL index.
 */
const videoJobSchema = new mongoose.Schema({
  jobId: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  status: {
    type: String,
    enum: ['pending', 'completed', 'failed'],
    default: 'pending'
  },
  videoUrl: {
    type: String,
    default: null
  },
  error: {
    code: { type: String, default: null },
    message: { type: String, default: null }
  },
  organizationId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Organization',
    index: true
  }
}, {
  timestamps: true
});

// Auto-delete documents 2 hours after creation
videoJobSchema.index({ createdAt: 1 }, { expireAfterSeconds: 7200 });

module.exports = mongoose.model('VideoJob', videoJobSchema);
