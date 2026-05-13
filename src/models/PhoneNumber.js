const mongoose = require('mongoose');

/**
 * Twilio phone number purchased for / assigned to an organization.
 * One number → one assigned VoiceAgent (route inbound calls to that agent).
 */
const phoneNumberSchema = new mongoose.Schema({
  organization: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Organization',
    required: true,
    index: true
  },
  twilioSid: { type: String, required: true, unique: true, trim: true },
  number: { type: String, required: true, trim: true },
  friendlyName: { type: String, default: '' },
  assignedAgent: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'VoiceAgent',
    default: null,
    index: true
  },
  capabilities: {
    voice: { type: Boolean, default: true },
    sms: { type: Boolean, default: false }
  },
  isActive: { type: Boolean, default: true }
}, { timestamps: true });

phoneNumberSchema.index({ organization: 1, number: 1 }, { unique: true });

module.exports = mongoose.model('PhoneNumber', phoneNumberSchema);
