const mongoose = require('mongoose');

/**
 * Scheduled Post Schema
 * Stores posts to be published later across different platforms
 */
const scheduledPostSchema = new mongoose.Schema({
  organization: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Organization',
    required: true,
    index: true
  },
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  platform: {
    type: String,
    required: true,
    enum: ['instagram', 'facebook', 'youtube', 'linkedin', 'google'],
    index: true
  },
  platformConnection: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'PlatformConnection',
    required: true
  },
  content: {
    type: String,
    required: true,
    trim: true
  },
  mediaUrl: {
    type: String,
    trim: true
  },
  mediaType: {
    type: String,
    enum: ['image', 'video', null]
  },
  mediaStoragePath: {
    type: String // Local storage path before upload
  },
  scheduledFor: {
    type: Date,
    index: true
  },
  status: {
    type: String,
    enum: ['draft', 'scheduled', 'publishing', 'published', 'failed'],
    default: 'draft',
    index: true
  },
  publishedAt: {
    type: Date
  },
  platformPostId: {
    type: String // ID from the platform after publishing
  },
  platformPostUrl: {
    type: String // URL to the published post
  },
  error: {
    type: String // Error message if failed
  },
  retryCount: {
    type: Number,
    default: 0
  },
  metadata: {
    type: mongoose.Schema.Types.Mixed // Additional platform-specific data
  }
}, {
  timestamps: true
});

// Index for querying scheduled posts
scheduledPostSchema.index({ scheduledFor: 1, status: 1 });
scheduledPostSchema.index({ organization: 1, status: 1 });

// Virtual for checking if post is ready to publish
scheduledPostSchema.virtual('isReadyToPublish').get(function() {
  return this.status === 'scheduled' && 
         this.scheduledFor && 
         new Date(this.scheduledFor) <= new Date();
});

module.exports = mongoose.model('ScheduledPost', scheduledPostSchema);
