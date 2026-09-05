const mongoose = require('mongoose');

/**
 * AddOnGrant — the ledger of one-time purchases (contact top-ups, AI recharges).
 *
 * Append-only: every fulfilled payment writes exactly one row, and an org's extra
 * capacity is the sum of its rows. Keeping the ledger separate from the computed
 * total means a botched override can always be rebuilt from what was actually paid
 * for, and a replayed webhook can never double-grant (the Transaction guard upstream
 * only lets fulfilment run once).
 */
const addOnGrantSchema = new mongoose.Schema(
  {
    organization: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Organization',
      required: true
    },
    addOnId: { type: String, required: true, lowercase: true, trim: true },
    transaction: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Transaction',
      required: true
    },

    featureKey: { type: String, required: true, trim: true },
    mode: {
      type: String,
      enum: ['limit_delta', 'period_credit', 'boolean_grant'],
      required: true
    },
    /** Total capability granted (quantity × per-unit grant). */
    amount: { type: Number, required: true, default: 0 },

    /**
     * Set only for `period_credit` grants: the UTC 'YYYY-MM' the top-up applies to.
     * A grant for a past month is ignored when overrides are recomputed, so monthly
     * recharges lapse on their own with no cron.
     */
    periodMonthKey: { type: String, trim: true, default: null },

    grantedAt: { type: Date, default: Date.now },
    /** null = permanent (the normal case for limit_delta top-ups). */
    expiresAt: { type: Date, default: null },

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }
  },
  { timestamps: true }
);

/** Rebuilding an org's overrides reads exactly this. */
addOnGrantSchema.index({ organization: 1, featureKey: 1 });
addOnGrantSchema.index({ organization: 1, periodMonthKey: 1 });
/** One grant per fulfilled transaction — a second write would be a double-grant. */
addOnGrantSchema.index({ transaction: 1 }, { unique: true });

module.exports = mongoose.model('AddOnGrant', addOnGrantSchema);
