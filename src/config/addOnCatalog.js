/**
 * Purchasable add-on SKUs, code-defined and DB-seeded — the same pattern as
 * featureCatalog → Feature.
 *
 * Why prices live here and not as feature keys: the pricing sheet advertises
 * "₹1,000 → +1,500 contacts", and that is the same number a customer is charged.
 * Keeping it in one place means the public table and the checkout can never drift.
 *
 * `pricing[]` is per plan, because ₹1,000 buys a different amount of headroom on
 * each tier. A plan absent from `pricing[]` cannot buy that SKU (either it is
 * already bundled, or it is not offered).
 *
 * Amounts are in whole rupees here for readability; the seed converts to paise,
 * which is what Razorpay and Transaction use.
 */

const { FEATURE_KEYS } = require('./featureCatalog');

const ADD_ON_CATALOG = [
  {
    addOnId: 'extra_user',
    name: 'Extra user',
    description: 'One additional team member seat, billed monthly.',
    quantityLabel: 'users',
    kind: 'recurring',
    grant: { featureKey: FEATURE_KEYS.USERS_MAX, mode: 'limit_delta' },
    /** Card-tile wording: a recurring per-unit price reads "+₹1,000/extra user". */
    perUnitLabel: 'extra user',
    displayOrder: 10,
    pricing: [
      { planId: 'starter', amountRupees: 1000, grantAmount: 1, minQuantity: 1, maxQuantity: 50 },
      { planId: 'growth', amountRupees: 1000, grantAmount: 1, minQuantity: 1, maxQuantity: 100 },
      { planId: 'pro_max', amountRupees: 1000, grantAmount: 1, minQuantity: 1, maxQuantity: 200 }
    ]
  },
  {
    addOnId: 'contacts_topup',
    name: 'Additional contacts',
    description: 'A one-time top-up that permanently raises your Active Contacts ceiling.',
    quantityLabel: 'packs',
    kind: 'one_time',
    grant: { featureKey: FEATURE_KEYS.CONTACTS_MAX, mode: 'limit_delta' },
    grantUnit: 'contacts',
    displayOrder: 20,
    pricing: [
      { planId: 'starter', amountRupees: 1000, grantAmount: 1000, minQuantity: 1, maxQuantity: 50 },
      { planId: 'growth', amountRupees: 1000, grantAmount: 1500, minQuantity: 1, maxQuantity: 50 },
      { planId: 'pro_max', amountRupees: 1000, grantAmount: 3000, minQuantity: 1, maxQuantity: 50 }
    ]
  },
  {
    addOnId: 'ai_conversations_recharge',
    name: 'AI conversation recharge',
    description: 'Top up AI conversation credits for the current billing month.',
    quantityLabel: 'credits',
    kind: 'one_time',
    grant: { featureKey: FEATURE_KEYS.CREDITS_AI_CONVERSATIONS, mode: 'period_credit' },
    grantUnit: 'conversations',
    displayOrder: 30,
    pricing: [
      // The sheet publishes the ₹1,500–₹2,500 band, which is what the comparison
      // table renders. `grantAmount` (conversations per ₹1,500 block) is a pricing
      // decision that is NOT on the sheet — set it per plan in the admin add-ons
      // screen before enabling purchase. Left null so nothing is silently invented.
      { planId: 'starter', amountRupees: 1500, minRupees: 1500, maxRupees: 2500, grantAmount: null },
      { planId: 'growth', amountRupees: 1500, minRupees: 1500, maxRupees: 2500, grantAmount: null },
      { planId: 'pro_max', amountRupees: 1500, minRupees: 1500, maxRupees: 2500, grantAmount: null }
    ]
  },
  {
    addOnId: 'flow_builder',
    name: 'Flow Builder',
    description:
      'Visual automation flow builder. Whether it is AI-powered is decided by your plan, '
      + 'not by this add-on.',
    quantityLabel: 'subscription',
    kind: 'recurring',
    grant: { featureKey: FEATURE_KEYS.FLOW_BUILDER_ENABLED, mode: 'boolean_grant' },
    displayOrder: 40,
    pricing: [
      { planId: 'starter', amountRupees: 1999, grantAmount: 1, minQuantity: 1, maxQuantity: 1 },
      { planId: 'growth', amountRupees: 1999, grantAmount: 1, minQuantity: 1, maxQuantity: 1 }
      // pro_max omitted deliberately — Flow Builder is bundled there.
    ]
  }
];

const ADD_ON_BY_ID = Object.freeze(
  ADD_ON_CATALOG.reduce((acc, row) => {
    acc[row.addOnId] = Object.freeze(row);
    return acc;
  }, {})
);

/**
 * Add-on prices keyed by planId then addOnId, in the shape the pricing-sheet
 * cell formatters expect.
 *
 * @returns {{ [planId: string]: { [addOnId: string]: object } }}
 */
function buildAddOnPriceIndex() {
  const index = {};
  for (const addOn of ADD_ON_CATALOG) {
    for (const row of addOn.pricing) {
      index[row.planId] = index[row.planId] || {};
      index[row.planId][addOn.addOnId] = {
        addOnId: addOn.addOnId,
        name: addOn.name,
        kind: addOn.kind,
        grantFeatureKey: addOn.grant.featureKey,
        grantMode: addOn.grant.mode,
        amountRupees: row.amountRupees,
        grantAmount: row.grantAmount ?? null,
        grantUnit: addOn.grantUnit || null,
        perUnitLabel: addOn.perUnitLabel || null,
        minRupees: row.minRupees ?? null,
        maxRupees: row.maxRupees ?? null,
        minQuantity: row.minQuantity ?? 1,
        maxQuantity: row.maxQuantity ?? 1
      };
    }
  }
  return index;
}

module.exports = { ADD_ON_CATALOG, ADD_ON_BY_ID, buildAddOnPriceIndex };
