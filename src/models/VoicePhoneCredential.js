const mongoose = require('mongoose');

/**
 * Per-organization telephony routing for Voice IVR.
 *
 * - byow: customer Twilio Account SID + Auth Token on this document.
 * - managed: RepMeUp master creates a Twilio subaccount; SID + token stored here.
 *
 * Voice AI (STT/TTS/LLM) uses platform env keys only (`voiceAiKeys.js`); legacy
 * sarvamApiKey/openaiApiKey fields are deprecated and ignored by the API layer.
 */
const voicePhoneCredentialSchema = new mongoose.Schema({
  organization: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Organization',
    required: true,
    unique: true,
    index: true
  },

  /** byow | managed — default byow for legacy rows without the field */
  telephonyMode: {
    type: String,
    enum: ['byow', 'managed'],
    default: 'byow'
  },

  /** BYO Twilio parent account */
  twilioAccountSid: { type: String, default: '' },
  twilioAuthToken: { type: String, default: '' },
  twilioApiKey: { type: String, default: '' },
  twilioApiSecret: { type: String, default: '' },

  /** Managed mode: subaccount under TWILIO_MASTER_* */
  twilioSubaccountSid: { type: String, default: '' },
  twilioSubaccountAuthToken: { type: String, default: '' },

  /** @deprecated ignored — platform Sarvam key only */
  sarvamApiKey: { type: String, default: '' },
  /** @deprecated ignored — optional platform OpenAI fallback in env */
  openaiApiKey: { type: String, default: '' },

  /** Publicly reachable base URL for Twilio webhooks (BYOW); managed defaults to PUBLIC_API_BASE_URL */
  publicBaseUrl: { type: String, default: '' },

  isActive: { type: Boolean, default: true }
}, { timestamps: true });

module.exports = mongoose.model('VoicePhoneCredential', voicePhoneCredentialSchema);
