const mongoose = require('mongoose');

/**
 * AddOn — a purchasable SKU that grants extra capability on top of a plan.
 *
 * Seeded from `src/config/addOnCatalog.js` (same code-defines / DB-stores pattern as
 * featureCatalog → Feature), so engineers add a SKU in a reviewed change while admins
 * still tune price and availability from the panel.
 *
 * `pricing[]` is per plan. That is the whole point: ₹1,000 buys +1,000 contacts on
 * Starter but +3,000 on Pro, and the row that sets the price is the same row the
 * public comparison table reads — so what we advertise and what we charge cannot drift.
 * A plan absent from `pricing[]` cannot buy the SKU (it is bundled, or not offered).
 */

const ADD_ON_KINDS = ['one_time', 'recurring'];

/**
 * How a purchase turns into entitlement:
 *   limit_delta   — permanently raises a numeric ceiling (contacts, seats)
 *   period_credit — tops up a monthly bucket for the current month only
 *   boolean_grant — switches a feature on for as long as the add-on is active
 */
const GRANT_MODES = ['limit_delta', 'period_credit', 'boolean_grant'];

const addOnPricingSchema = new mongoose.Schema(
  {
    _id: false,
    planId: { type: String, required: true, lowercase: true, trim: true },
    /** Price per unit, in paise. */
    priceInr: { type: Number, required: true, min: 0 },
    /** How much capability ONE unit grants on this plan (null = configure before selling). */
    grantAmount: { type: Number, default: null },
    minQuantity: { type: Number, default: 1, min: 1 },
    maxQuantity: { type: Number, default: 1, min: 1 },
    /** Published band for open-ended top-ups, in paise. Display only. */
    minPriceInr: { type: Number, default: null },
    maxPriceInr: { type: Number, default: null },
    /** Razorpay plan id for `recurring` SKUs; server-managed. */
    razorpayPlanId: { type: String, trim: true, default: null }
  },
  { _id: false }
);

const addOnSchema = new mongoose.Schema(
  {
    addOnId: { type: String, required: true, unique: true, lowercase: true, trim: true },
    name: { type: String, required: true, trim: true },
    description: { type: String, trim: true, default: '' },
    /** Noun for the quantity stepper, e.g. 'packs', 'users'. */
    quantityLabel: { type: String, trim: true, default: 'units' },
    /** Noun for what a grant buys, e.g. 'contacts'. Used in "₹1,000 → +1,500 contacts". */
    grantUnit: { type: String, trim: true, default: null },
    /** Card wording for per-seat recurring SKUs, e.g. "+₹1,000/extra user". */
    perUnitLabel: { type: String, trim: true, default: null },

    kind: { type: String, enum: ADD_ON_KINDS, required: true },
    grant: {
      featureKey: { type: String, required: true, trim: true },
      mode: { type: String, enum: GRANT_MODES, required: true }
    },

    pricing: { type: [addOnPricingSchema], default: [] },

    isActive: { type: Boolean, default: true },
    isPublic: { type: Boolean, default: true },
    displayOrder: { type: Number, default: 100 }
  },
  { timestamps: true }
);

addOnSchema.index({ isActive: 1, displayOrder: 1 });

/** The pricing row for a plan, or null when this SKU is not sold on that plan. */
addOnSchema.methods.pricingFor = function pricingFor(planId) {
  if (!planId) return null;
  const wanted = String(planId).toLowerCase();
  return this.pricing.find((p) => p.planId === wanted) || null;
};

addOnSchema.statics.KINDS = ADD_ON_KINDS;
addOnSchema.statics.GRANT_MODES = GRANT_MODES;

module.exports = mongoose.model('AddOn', addOnSchema);
