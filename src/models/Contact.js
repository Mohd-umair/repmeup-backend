const mongoose = require('mongoose');

const channelSchema = new mongoose.Schema({
  platform: {
    type: String,
    enum: ['instagram', 'facebook', 'whatsapp', 'youtube', 'google', 'website', 'linkedin', 'twitter'],
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

  lastInteractionAt: { type: Date, default: null },
  isDeleted: { type: Boolean, default: false, index: true }
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

module.exports = mongoose.model('Contact', contactSchema);
