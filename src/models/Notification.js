const mongoose = require('mongoose');

const notificationSchema = new mongoose.Schema({
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
  
  type: {
    type: String,
    enum: [
      'new_interaction',
      'assignment',
      'mention',
      'escalation',
      'negative_spike',
      'response_received',
      'platform_error',
      'system'
    ],
    required: true
  },
  
  title: {
    type: String,
    required: true
  },
  
  message: {
    type: String,
    required: true
  },
  
  // Related data
  relatedTo: {
    model: {
      type: String,
      enum: ['Interaction', 'Assignment', 'PlatformConnection', 'User']
    },
    id: mongoose.Schema.Types.ObjectId
  },
  
  actionUrl: String, // Where to go when clicked
  
  isRead: {
    type: Boolean,
    default: false
  },
  readAt: Date,
  
  // Delivery status
  deliveryMethod: [{
    type: String,
    enum: ['in_app', 'email', 'push']
  }],
  emailSent: {
    type: Boolean,
    default: false
  },
  emailSentAt: Date,
  
  expiresAt: Date
}, {
  timestamps: true
});

// Indexes
notificationSchema.index({ user: 1, isRead: 1, createdAt: -1 });
notificationSchema.index({ user: 1, createdAt: -1 });
notificationSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 }); // TTL index

// Mark as read
notificationSchema.methods.markAsRead = function() {
  this.isRead = true;
  this.readAt = new Date();
  return this.save();
};

module.exports = mongoose.model('Notification', notificationSchema);

