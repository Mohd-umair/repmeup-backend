const mongoose = require('mongoose');

/**
 * A single PSTN call handled by the AI Voice IVR.
 * Created when Twilio's inbound webhook fires; updated by the media-stream gateway
 * and the post-call Bull worker.
 */
const transcriptTurnSchema = new mongoose.Schema({
  role: { type: String, enum: ['user', 'assistant', 'system'], required: true },
  text: { type: String, default: '' },
  timestamp: { type: Date, default: Date.now },
  languageDetected: { type: String, default: null }
}, { _id: false });

const callSessionSchema = new mongoose.Schema({
  organization: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Organization',
    required: true,
    index: true
  },
  agent: { type: mongoose.Schema.Types.ObjectId, ref: 'VoiceAgent', index: true },
  phoneNumber: { type: mongoose.Schema.Types.ObjectId, ref: 'PhoneNumber' },

  twilioCallSid: { type: String, required: true, unique: true, trim: true },
  twilioStreamSid: { type: String, default: null },

  direction: { type: String, enum: ['inbound', 'outbound'], required: true },
  callerNumber: { type: String, default: '' },
  calledNumber: { type: String, default: '' },

  status: {
    type: String,
    enum: ['queued', 'ringing', 'in-progress', 'completed', 'failed', 'no-answer', 'busy', 'canceled'],
    default: 'queued',
    index: true
  },

  startedAt: { type: Date, default: Date.now },
  endedAt: { type: Date, default: null },
  durationSeconds: { type: Number, default: 0 },

  transcript: { type: [transcriptTurnSchema], default: [] },

  summary: { type: String, default: '' },
  intent: { type: String, default: '' },
  sentiment: {
    type: String,
    enum: ['positive', 'neutral', 'negative', ''],
    default: ''
  },

  toolCallsUsed: [{ type: String }],
  followUpSent: { type: Boolean, default: false },
  humanHandoffTriggered: { type: Boolean, default: false },

  linkedContact: { type: mongoose.Schema.Types.ObjectId, ref: 'Contact', default: null },
  linkedInteraction: { type: mongoose.Schema.Types.ObjectId, ref: 'Interaction', default: null },

  recordingUrl: { type: String, default: '' },
  errorMessage: { type: String, default: '' },

  metadata: { type: mongoose.Schema.Types.Mixed, default: {} }
}, { timestamps: true });

callSessionSchema.index({ organization: 1, startedAt: -1 });
callSessionSchema.index({ organization: 1, agent: 1, startedAt: -1 });
callSessionSchema.index({ organization: 1, status: 1, startedAt: -1 });

module.exports = mongoose.model('CallSession', callSessionSchema);
