const mongoose = require('mongoose');

const reviewRequestSchema = new mongoose.Schema({
  organization: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Organization',
    required: true,
    index: true
  },
  contact: { type: mongoose.Schema.Types.ObjectId, ref: 'Contact' },
  orderId: { type: mongoose.Schema.Types.ObjectId, ref: 'ProductOrder' },
  interactionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Interaction' },
  channel: { type: String, enum: ['whatsapp', 'email', 'sms'], default: 'whatsapp' },
  platform: { type: String }, // google, facebook, etc.
  whatsappFlowToken: {
    type: String,
    unique: true,
    sparse: true,
    index: true
  },
  status: {
    type: String,
    enum: ['pending', 'sent', 'delivered', 'reviewed', 'failed', 'skipped'],
    default: 'pending'
  },
  messageSent: String,
  sentAt: Date,
  deliveredAt: Date,
  reviewSubmittedAt: Date,
  reviewUrl: String,
  rating: Number,
  comment: String,
  reminderCount: { type: Number, default: 0 },
  nextReminderAt: Date,
  errorMessage: String,
  metadata: { type: mongoose.Schema.Types.Mixed }
}, { timestamps: true });

reviewRequestSchema.index({ organization: 1, status: 1 });
reviewRequestSchema.index({ organization: 1, sentAt: -1 });
reviewRequestSchema.index({ organization: 1, contact: 1, sentAt: -1 });

module.exports = mongoose.model('ReviewRequest', reviewRequestSchema);
