const mongoose = require('mongoose');

/**
 * WhatsAppConversationCharge — one row per billable WhatsApp conversation.
 *
 * Meta bills per CONVERSATION, not per message: a 24-hour window opened by the
 * first message in a category, within which further messages are free. So the row
 * is created when a status webhook first carries a new `conversation.id`, and later
 * statuses for the same conversation only increment `messageCount`.
 *
 * This is a pass-through cost — identical on every plan — so it is recorded for
 * visibility and invoicing, never enforced as a quota.
 */

const CHARGE_CATEGORIES = [
  'marketing',
  'utility',
  'authentication',
  'service',
  'referral_conversion',
  'unknown'
];

const whatsAppConversationChargeSchema = new mongoose.Schema(
  {
    organization: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Organization',
      required: true
    },
    /** Meta's conversation id — the natural key for the whole 24h window. */
    wabaConversationId: { type: String, required: true, trim: true },

    category: { type: String, enum: CHARGE_CATEGORIES, default: 'unknown' },
    /** Meta's `conversation.origin.type` — why the window opened. */
    originType: { type: String, trim: true, default: null },
    /** false when Meta tells us this one is free (e.g. inside a service window). */
    billable: { type: Boolean, default: true },

    /**
     * The rate applied, in paise, SNAPSHOTTED at charge time. If Meta reprices
     * tomorrow, this row still says what it actually cost.
     */
    rateInr: { type: Number, required: true, default: 0 },

    startedAt: { type: Date, default: Date.now },
    expiresAt: { type: Date, default: null },
    /**
     * Delivery-status events seen for this conversation — reporting only, never
     * billing. Not deduplicated by message id, so a Meta retry of the same message
     * counts twice; treat it as activity volume, not an exact message tally.
     */
    messageCount: { type: Number, default: 1 },

    campaign: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'WhatsAppCampaign',
      default: null
    },

    /** UTC 'YYYY-MM' — the aggregation key for monthly spend. */
    periodMonthKey: { type: String, required: true, trim: true }
  },
  { timestamps: true }
);

/**
 * One charge per conversation, enforced by the database. Meta delivers status
 * webhooks at least once, so without this a redelivery would bill twice.
 */
whatsAppConversationChargeSchema.index(
  { organization: 1, wabaConversationId: 1 },
  { unique: true }
);

/** Monthly spend summary groups on exactly this. */
whatsAppConversationChargeSchema.index({ organization: 1, periodMonthKey: 1, category: 1 });
whatsAppConversationChargeSchema.index({ campaign: 1 }, { sparse: true });

whatsAppConversationChargeSchema.statics.CATEGORIES = CHARGE_CATEGORIES;

module.exports = mongoose.model('WhatsAppConversationCharge', whatsAppConversationChargeSchema);
