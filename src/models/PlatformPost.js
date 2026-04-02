const mongoose = require('mongoose');

/**
 * Platform Post Schema
 * Stores posts fetched from connected platforms (Facebook, Instagram, etc.) for the Content page.
 * Synced via "Sync" button; read from DB instead of calling Meta on every load.
 */
const platformPostSchema = new mongoose.Schema({
  organization: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Organization',
    required: true,
    index: true
  },
  platform: {
    type: String,
    required: true,
    enum: ['facebook', 'instagram'],
    index: true
  },
  platformConnection: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'PlatformConnection',
    required: true,
    index: true
  },
  externalId: {
    type: String,
    required: true,
    index: true
  },
  connectionName: {
    type: String,
    default: ''
  },
  text: {
    type: String,
    default: ''
  },
  /** When the post was published on the platform (not when we synced it) */
  postedAt: {
    type: Date,
    required: true,
    index: true
  },
  permalink: {
    type: String,
    default: null
  },
  mediaUrl: {
    type: String,
    default: null
  },
  mediaType: {
    type: String,
    enum: ['image', 'video', 'carousel', null],
    default: null
  },
  contentType: {
    type: String,
    enum: ['post', 'reel', 'video', 'carousel', 'story'],
    default: 'post',
    index: true
  },
  likeCount: {
    type: Number,
    default: 0
  },
  shareCount: {
    type: Number,
    default: 0
  },
  syncedAt: {
    type: Date,
    default: Date.now
  }
}, {
  timestamps: true
});

platformPostSchema.index({ organization: 1, platform: 1, externalId: 1 }, { unique: true });
platformPostSchema.index({ organization: 1, platform: 1, postedAt: -1 });

module.exports = mongoose.model('PlatformPost', platformPostSchema);
