const mongoose = require('mongoose');

const reviewRequestSettingsSchema = new mongoose.Schema({
  organization: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Organization',
    required: true,
    unique: true,
    index: true
  },
  enabled: { type: Boolean, default: false },
  platforms: {
    type: [{
      key: { type: String, enum: ['google', 'facebook', 'tripadvisor', 'yelp', 'custom'] },
      active: { type: Boolean, default: false },
      url: String
    }],
    default: []
  },
  trigger: {
    type: String,
    enum: ['after_purchase', 'after_support_resolved', 'manual'],
    default: 'after_purchase'
  },
  delayDays: { type: Number, default: 3, min: 0, max: 30 },
  channels: { type: [String], enum: ['whatsapp', 'email', 'sms'], default: ['whatsapp'] },
  language: { type: String, default: 'en' },
  message: {
    type: String,
    default: 'Hi {{customer_name}}! 😊 We hope you loved your experience. If you have a moment, we\'d really appreciate a quick review. {{review_link}}'
  },
  sendReminders: { type: Boolean, default: false },
  reminderCount: { type: Number, default: 1, min: 1, max: 3 },
  reminderDelayDays: { type: Number, default: 3 },
  ignoreNegativeRating: { type: Boolean, default: true },
  excludeRecentReviewers: { type: Boolean, default: true },
  recentReviewerDays: { type: Number, default: 90 },
  quietHoursStart: { type: String, default: '22:00' },
  quietHoursEnd: { type: String, default: '08:00' },
  maxDailyRequests: { type: Number, default: 100 }
}, { timestamps: true });

module.exports = mongoose.model('ReviewRequestSettings', reviewRequestSettingsSchema);
