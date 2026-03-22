const mongoose = require('mongoose');

/**
 * User-facing activity: authenticated API usage, auth events, and SPA navigation beacons.
 * Used by the Super Admin panel to review where users access the product.
 */
const userActivityLogSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true
    },
    organization: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Organization',
      index: true
    },
    category: {
      type: String,
      required: true,
      enum: ['api', 'auth', 'navigation'],
      index: true
    },
    /** e.g. api_request | login | register | google_oauth_login | page_view */
    action: {
      type: String,
      required: true,
      trim: true,
      maxlength: 64
    },
    /** API path or client route */
    path: {
      type: String,
      trim: true,
      maxlength: 1024
    },
    method: {
      type: String,
      trim: true,
      maxlength: 16
    },
    statusCode: {
      type: Number,
      min: 100,
      max: 599
    },
    ip: {
      type: String,
      trim: true,
      maxlength: 64
    },
    userAgent: {
      type: String,
      trim: true,
      maxlength: 512
    },
    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: undefined
    }
  },
  { timestamps: true }
);

userActivityLogSchema.index({ user: 1, createdAt: -1 });
userActivityLogSchema.index({ createdAt: -1 });

module.exports = mongoose.model('UserActivityLog', userActivityLogSchema);
