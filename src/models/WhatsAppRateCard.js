const mongoose = require('mongoose');

/**
 * WhatsAppRateCard — what Meta charges per conversation category, effective-dated.
 *
 * Rates are DATA, not constants. Meta reprices periodically, and when that happens
 * the correct move is to insert a new row with a new `effectiveFrom` — never to edit
 * an existing one. Charges snapshot the rate they were billed at, so history stays
 * accurate no matter how often pricing changes.
 *
 * Seeded from src/config/whatsappRates.js by scripts/seedWhatsAppRates.js.
 */

const RATE_CATEGORIES = [
  'marketing',
  'utility',
  'authentication',
  'service',
  'referral_conversion'
];

const whatsAppRateCardSchema = new mongoose.Schema(
  {
    /** ISO country code. Meta prices per market; India is all we sell in today. */
    country: { type: String, required: true, uppercase: true, trim: true, default: 'IN' },
    currency: { type: String, required: true, uppercase: true, trim: true, default: 'INR' },
    category: { type: String, enum: RATE_CATEGORIES, required: true },

    /** Rate per conversation, in paise. Integer money — never a float. */
    rateInr: { type: Number, required: true, min: 0 },

    effectiveFrom: { type: Date, required: true, default: () => new Date(0) },
    /** null = still current. */
    effectiveTo: { type: Date, default: null },

    source: { type: String, trim: true, default: 'meta-price-list' },
    notes: { type: String, trim: true, default: '' }
  },
  { timestamps: true }
);

/** Resolving "the rate for category X at time T" is the only read pattern. */
whatsAppRateCardSchema.index({ country: 1, category: 1, effectiveFrom: -1 });

whatsAppRateCardSchema.statics.CATEGORIES = RATE_CATEGORIES;

module.exports = mongoose.model('WhatsAppRateCard', whatsAppRateCardSchema);
