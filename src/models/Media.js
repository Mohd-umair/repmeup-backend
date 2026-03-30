const mongoose = require('mongoose');

/**
 * Media Library Model
 * Stores uploaded images and videos for reuse across multiple posts
 */
const mediaSchema = new mongoose.Schema({
  // File information
  filename: {
    type: String,
    required: true,
    unique: true
  },
  originalName: {
    type: String,
    required: true
  },
  filePath: {
    type: String,
    required: true
  },
  publicUrl: {
    type: String,
    required: true
  },
  /** When using S3, object key for DeleteObject (filePath stays absolute path for local) */
  s3Key: {
    type: String
  },
  storageType: {
    type: String,
    enum: ['local', 's3'],
    default: 'local'
  },

  // File metadata
  mimeType: {
    type: String,
    required: true
  },
  mediaType: {
    type: String,
    enum: ['image', 'video', 'audio'],
    required: true
  },
  size: {
    type: Number,
    required: true // in bytes
  },
  
  // Image/Video metadata
  width: Number,
  height: Number,
  duration: Number, // for videos, in seconds
  
  // Ownership
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  organization: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Organization',
    required: true
  },
  
  // Usage tracking
  usageCount: {
    type: Number,
    default: 0
  },
  lastUsedAt: Date,
  
  // Tags for organization
  tags: [{
    type: String,
    trim: true
  }],
  
  // Description/alt text
  description: {
    type: String,
    trim: true,
    maxlength: 500
  }
}, {
  timestamps: true
});

// Indexes for efficient queries
mediaSchema.index({ organization: 1, createdAt: -1 });
mediaSchema.index({ organization: 1, mediaType: 1 });
mediaSchema.index({ user: 1, createdAt: -1 });
mediaSchema.index({ tags: 1 });

// Virtual for file URL
mediaSchema.virtual('url').get(function() {
  return this.publicUrl;
});

// Method to increment usage count
mediaSchema.methods.incrementUsage = async function() {
  this.usageCount += 1;
  this.lastUsedAt = new Date();
  await this.save();
};

// Static method to get media stats for organization
mediaSchema.statics.getStats = async function(organizationId) {
  const stats = await this.aggregate([
    { $match: { organization: mongoose.Types.ObjectId(organizationId) } },
    {
      $group: {
        _id: '$mediaType',
        count: { $sum: 1 },
        totalSize: { $sum: '$size' }
      }
    }
  ]);
  
  return stats.reduce((acc, stat) => {
    acc[stat._id] = {
      count: stat.count,
      totalSize: stat.totalSize
    };
    return acc;
  }, {});
};

const Media = mongoose.model('Media', mediaSchema);

module.exports = Media;
