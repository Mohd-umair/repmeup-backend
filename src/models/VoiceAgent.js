const mongoose = require('mongoose');

/**
 * VoiceAgent — an org-scoped AI calling persona.
 * Industry-tuned via `industry` + a custom `systemPrompt` and tool list.
 */
const voiceAgentToolSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  description: { type: String, default: '' },
  /** JSON schema for parameters (loosely typed; matches OpenAI tool schema shape) */
  parameters: { type: mongoose.Schema.Types.Mixed, default: {} },
  /** Built-in action key the workflow service understands (e.g. 'create_contact') */
  action: {
    type: String,
    enum: [
      'create_contact',
      'log_call_interaction',
      'send_whatsapp_followup',
      'lookup_appointment',
      'book_appointment',
      'check_product_availability',
      'transfer_to_human',
      'custom_webhook'
    ],
    required: true
  },
  /** Used only when action === 'custom_webhook' */
  webhookUrl: { type: String, default: '' },
  enabled: { type: Boolean, default: true }
}, { _id: false });

const voiceAgentSchema = new mongoose.Schema({
  organization: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Organization',
    required: true,
    index: true
  },
  name: { type: String, required: true, trim: true },
  industry: {
    type: String,
    enum: [
      'real_estate',
      'clinic',
      'restaurant',
      'education',
      'ecommerce',
      'finance',
      'custom'
    ],
    default: 'custom'
  },
  systemPrompt: { type: String, required: true },
  greetingMessage: { type: String, default: 'Hello! How can I help you today?' },
  language: { type: String, default: 'en-IN' },
  voiceId: { type: String, default: 'meera' },
  tools: { type: [voiceAgentToolSchema], default: [] },
  workflow: {
    sendWhatsappFollowUp: { type: Boolean, default: false },
    whatsappTemplateId: { type: mongoose.Schema.Types.ObjectId, ref: 'WhatsAppTemplate', default: null },
    createContact: { type: Boolean, default: true },
    createInboxInteraction: { type: Boolean, default: true },
    humanHandoffKeywords: {
      type: [String],
      default: ['talk to agent', 'human', 'representative', 'customer service']
    },
    maxCallDurationSeconds: { type: Number, default: 600, min: 30, max: 3600 }
  },
  isActive: { type: Boolean, default: true },
  linkedPhoneNumbers: [{ type: mongoose.Schema.Types.ObjectId, ref: 'PhoneNumber' }],
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
}, { timestamps: true });

voiceAgentSchema.index({ organization: 1, isActive: 1 });
voiceAgentSchema.index({ organization: 1, name: 1 });

module.exports = mongoose.model('VoiceAgent', voiceAgentSchema);
