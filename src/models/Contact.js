const mongoose = require('mongoose');

const channelSchema = new mongoose.Schema({
  platform: {
    type: String,
    enum: ['instagram', 'facebook', 'whatsapp', 'youtube', 'google', 'website', 'linkedin', 'twitter', 'shopify'],
    required: true
  },
  platformUserId: { type: String, required: true },
  username: String,
  name: String,
  profileUrl: String,
  avatarUrl: String,
  rawData: { type: mongoose.Schema.Types.Mixed },
  addedAt: { type: Date, default: Date.now }
}, { _id: false });

/** Remembered delivery address so repeat orders only need a one-tap confirm. */
const contactShippingSchema = new mongoose.Schema({
  name:    { type: String, trim: true },
  phone:   { type: String, trim: true },
  line1:   { type: String, trim: true },
  line2:   { type: String, trim: true },
  city:    { type: String, trim: true },
  state:   { type: String, trim: true },
  pincode: { type: String, trim: true },
  country: { type: String, trim: true, default: 'India' }
}, { _id: false });

const contactSchema = new mongoose.Schema({
  organization: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Organization',
    required: true,
    index: true
  },

  primaryName: { type: String, trim: true, default: 'Unknown' },
  primaryPhone: { type: String, trim: true, default: null },
  primaryEmail: { type: String, trim: true, lowercase: true, default: null },

  channels: [channelSchema],

  tags: [{ type: String, trim: true }],
  notes: { type: String, trim: true, default: null },

  // Remembered delivery address (verbatim + structured) for repeat-order confirm.
  shippingAddress: { type: String, trim: true, default: null },
  shipping: { type: contactShippingSchema, default: undefined },
  shippingUpdatedAt: { type: Date, default: null },

  aiInsights: {
    intent: { type: String, default: null },
    sentiment: { type: String, default: null },
    priority: { type: String, default: null },
    updatedAt: { type: Date, default: null }
  },

  company: { type: String, trim: true, default: null },

  lifecycleStage: {
    type: String,
    enum: ['lead', 'engaged', 'qualified', 'customer', 'repeat_customer', 'vip', 'at_risk', 'churned'],
    default: 'lead',
    index: true
  },

  owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
  team: { type: mongoose.Schema.Types.ObjectId, ref: 'Team', default: null },

  customFields: { type: Map, of: mongoose.Schema.Types.Mixed, default: undefined },

  intelligence: {
    healthScore: { type: Number, default: null },
    healthBand: { type: String, enum: ['healthy', 'needs_attention', 'at_risk', null], default: null },
    leadScore: { type: Number, default: null },
    churnRisk: { type: String, enum: ['low', 'medium', 'high', null], default: null },
    engagementScore: { type: Number, default: null },
    aiSummary: { type: String, default: null },
    aiConfidence: { type: Number, default: null },
    computedAt: { type: Date, default: null }
  },

  commerceMetrics: {
    totalOrders: { type: Number, default: 0 },
    totalSpent: { type: Number, default: 0 },
    avgOrderValue: { type: Number, default: 0 },
    lastOrderAt: { type: Date, default: null }
  },

  communicationPreferences: {
    whatsapp: { type: Boolean, default: true },
    sms: { type: Boolean, default: true },
    email: { type: Boolean, default: true },
    instagram: { type: Boolean, default: true },
    facebook: { type: Boolean, default: true },
    marketingConsent: { type: Boolean, default: true },
    doNotContact: { type: Boolean, default: false }
  },

  source: {
    channel: { type: String, default: null },
    campaign: { type: mongoose.Schema.Types.ObjectId, ref: 'Campaign', default: null },
    firstTouchAt: { type: Date, default: null }
  },

  mergedFrom: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Contact' }],

  nextBestAction: {
    action: { type: String, default: null },
    reason: { type: String, default: null },
    computedAt: { type: Date, default: null }
  },

  lastInteractionAt: { type: Date, default: null },
  lastActivityChannel: { type: String, default: null },
  lastActivityType: { type: String, default: null },
  isDeleted: { type: Boolean, default: false, index: true },

  /**
   * WhatsApp opt-out flag — set to true when the contact sends STOP/UNSUBSCRIBE.
   * When true, the FlowTriggerRouter skips new enrollments for this contact.
   * Must be honoured to comply with WhatsApp Business Policy.
   */
  flowsOptedOut: { type: Boolean, default: false, index: true },
  flowsOptedOutAt: { type: Date, default: null }
}, {
  timestamps: true
});

// ─── Indexes ───────────────────────────────────────────────────────────────
contactSchema.index({ organization: 1, primaryPhone: 1 }, { sparse: true });
contactSchema.index({ organization: 1, primaryEmail: 1 }, { sparse: true });

// Fast channel lookup — critical for webhook traffic
contactSchema.index({ organization: 1, 'channels.platform': 1, 'channels.platformUserId': 1 });

// Text search on name/notes
contactSchema.index({ primaryName: 'text', notes: 'text' });

// Live count for the `contacts.max` ("Active Contacts") entitlement. Without this,
// every entitlements cache miss scans the whole collection for the org.
contactSchema.index({ organization: 1, isDeleted: 1 });
contactSchema.index({ organization: 1, isDeleted: 1, lifecycleStage: 1 });
contactSchema.index({ organization: 1, isDeleted: 1, owner: 1 });
contactSchema.index({ organization: 1, isDeleted: 1, lastInteractionAt: -1 });
contactSchema.index({ organization: 1, tags: 1 });

module.exports = mongoose.model('Contact', contactSchema);
