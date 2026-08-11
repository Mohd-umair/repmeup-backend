'use strict';

/**
 * Add-on entitlement engine.
 *
 * The one idea that makes this safe: `Subscription.entitlementOverrides` is never
 * written incrementally. Every change RECOMPUTES it from scratch out of the two
 * durable records of what a customer actually paid for:
 *
 *   AddOnGrant        — append-only ledger of one-time purchases
 *   SubscriptionAddOn — currently-active recurring purchases
 *
 * So fulfilment is naturally idempotent (replaying a webhook recomputes to the same
 * number), self-healing (repair = recompute for every org), and auditable (the
 * ledger explains every unit of capacity).
 */

const AddOn = require('../models/AddOn');
const AddOnGrant = require('../models/AddOnGrant');
const SubscriptionAddOn = require('../models/SubscriptionAddOn');
const Subscription = require('../models/Subscription');
const entitlementsService = require('./entitlementsService');
const { CATALOG_BY_KEY } = require('../config/featureCatalog');
const logger = require('../config/logger');

/** UTC 'YYYY-MM' — must match entitlementsService.currentMonthKey. */
function currentMonthKey(now = new Date()) {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

function addDelta(target, featureKey, amount) {
  if (!amount) return;
  target[featureKey] = target[featureKey] || { limitDelta: 0 };
  target[featureKey].limitDelta = (target[featureKey].limitDelta || 0) + amount;
}

/**
 * Rebuild an organization's purchased entitlement from the ledger and persist it.
 *
 * @returns {Promise<object>} the overrides map that was written
 */
async function recomputeOverrides(organizationId) {
  const orgId = String(organizationId);
  const thisMonth = currentMonthKey();

  const [grants, recurring] = await Promise.all([
    AddOnGrant.find({ organization: orgId }).lean(),
    /**
     * `past_due` counts as still granting. A single failed renewal should not strip
     * seats mid-cycle — Razorpay retries, and if it ultimately gives up it cancels the
     * subscription, which lands here as `cancelled` and removes the capacity properly.
     *
     * This has to live in the QUERY, not in the caller: overrides are recomputed by any
     * add-on change, so excluding past_due here would silently revoke a grace-period
     * customer's seats the next time they bought something unrelated.
     */
    SubscriptionAddOn.find({ organization: orgId, status: { $in: ['active', 'past_due'] } }).lean()
  ]);

  const overrides = {};
  const now = new Date();

  // ── one-time purchases ────────────────────────────────────────────────────
  for (const grant of grants) {
    if (grant.expiresAt && new Date(grant.expiresAt) < now) continue;
    // A monthly recharge only counts in the month it was bought for.
    if (grant.mode === 'period_credit' && grant.periodMonthKey !== thisMonth) continue;

    const catalogEntry = CATALOG_BY_KEY[grant.featureKey];
    if (!catalogEntry) continue;

    if (grant.mode === 'limit_delta' || grant.mode === 'period_credit') {
      addDelta(overrides, grant.featureKey, grant.amount);
      if (grant.mode === 'period_credit') {
        overrides[grant.featureKey].periodMonthKey = thisMonth;
      }
    } else if (grant.mode === 'boolean_grant') {
      overrides[grant.featureKey] = { ...(overrides[grant.featureKey] || {}), enabled: true };
    }
  }

  // ── active recurring purchases ────────────────────────────────────────────
  for (const sub of recurring) {
    const snapshot = sub.grantSnapshot || {};
    const featureKey = snapshot.featureKey;
    const catalogEntry = featureKey ? CATALOG_BY_KEY[featureKey] : null;
    if (!catalogEntry) continue;

    if (snapshot.mode === 'limit_delta') {
      addDelta(overrides, featureKey, (snapshot.amountPerUnit || 0) * (sub.quantity || 1));
    } else if (snapshot.mode === 'boolean_grant') {
      overrides[featureKey] = { ...(overrides[featureKey] || {}), enabled: true };
    }
  }

  await Subscription.updateOne(
    { organization: orgId },
    { $set: { entitlementOverrides: overrides } }
  );
  await entitlementsService.invalidateEntitlements(orgId);

  logger.info('[addOns] overrides recomputed', {
    organizationId: orgId,
    keys: Object.keys(overrides)
  });

  return overrides;
}

/**
 * The add-on catalogue as offered to ONE organization, display-ready.
 *
 * SKUs the org's plan already includes are filtered out — that is how Flow Builder
 * disappears for Pro without a single conditional: the plan simply already grants
 * `flowBuilder.enabled`.
 */
async function listAvailableAddOns(organizationId) {
  const orgId = String(organizationId);
  const [subscription, addOns, entitlements, held] = await Promise.all([
    Subscription.findOne({ organization: orgId }).select('planId').lean(),
    AddOn.find({ isActive: true, isPublic: true }).sort({ displayOrder: 1 }).lean(),
    entitlementsService.getEntitlements(orgId),
    SubscriptionAddOn.find({
      organization: orgId,
      status: { $in: ['pending', 'active', 'past_due'] }
    }).select('addOnId').lean()
  ]);

  const planId = subscription?.planId;
  if (!planId) return [];

  // One live subscription per recurring SKU, so anything already held is not on offer —
  // it is shown under "your recurring add-ons" instead. Without this the UI would render
  // a Buy button that the duplicate guard rejects with a 409.
  const heldAddOnIds = new Set(held.map((h) => h.addOnId));

  const items = [];
  for (const addOn of addOns) {
    const pricing = (addOn.pricing || []).find((p) => p.planId === planId);
    if (!pricing) continue;   // not sold on this plan
    if (addOn.kind === 'recurring' && heldAddOnIds.has(addOn.addOnId)) continue;

    // Already entitled by the plan itself → nothing to sell.
    const resolved = entitlements.keys?.[addOn.grant.featureKey];
    if (addOn.grant.mode === 'boolean_grant'
        && resolved?.enabled
        && resolved.source !== 'subscription.override') {
      continue;
    }

    const rupees = (paise) => (paise == null ? null : Math.round(paise / 100));
    items.push({
      addOnId: addOn.addOnId,
      name: addOn.name,
      description: addOn.description,
      kind: addOn.kind,
      quantityLabel: addOn.quantityLabel,
      grantUnit: addOn.grantUnit,
      featureKey: addOn.grant.featureKey,
      mode: addOn.grant.mode,
      priceInr: pricing.priceInr,
      priceDisplay: `₹${rupees(pricing.priceInr).toLocaleString('en-IN')}`,
      grantAmount: pricing.grantAmount,
      /** e.g. "₹1,000 → +1,500 contacts" */
      offerDisplay: pricing.grantAmount && addOn.grantUnit
        ? `₹${rupees(pricing.priceInr).toLocaleString('en-IN')} → `
          + `+${pricing.grantAmount.toLocaleString('en-IN')} ${addOn.grantUnit}`
        : `₹${rupees(pricing.priceInr).toLocaleString('en-IN')}`
        + (addOn.perUnitLabel ? ` / ${addOn.perUnitLabel}` : ''),
      minQuantity: pricing.minQuantity,
      maxQuantity: pricing.maxQuantity,
      /** Not purchasable until an admin sets how much one unit grants. */
      purchasable: pricing.grantAmount != null || addOn.grant.mode === 'boolean_grant'
    });
  }
  return items;
}

/** Active recurring add-ons plus the resolved overrides, for the billing page. */
async function listMyAddOns(organizationId) {
  const orgId = String(organizationId);
  const [recurring, grants, subscription] = await Promise.all([
    SubscriptionAddOn.find({ organization: orgId, status: { $in: ['active', 'past_due'] } }).lean(),
    AddOnGrant.find({ organization: orgId }).sort({ grantedAt: -1 }).limit(20).lean(),
    Subscription.findOne({ organization: orgId }).select('entitlementOverrides').lean()
  ]);

  return {
    recurring: recurring.map((r) => ({
      addOnId: r.addOnId,
      quantity: r.quantity,
      status: r.status,
      unitPriceInr: r.unitPriceInr,
      currentPeriodEnd: r.currentPeriodEnd || null,
      cancelAtPeriodEnd: !!r.cancelAtPeriodEnd
    })),
    recentGrants: grants.map((g) => ({
      addOnId: g.addOnId,
      featureKey: g.featureKey,
      amount: g.amount,
      grantedAt: g.grantedAt,
      periodMonthKey: g.periodMonthKey
    })),
    overrides: subscription?.entitlementOverrides || {}
  };
}

module.exports = {
  recomputeOverrides,
  listAvailableAddOns,
  listMyAddOns,
  currentMonthKey
};
