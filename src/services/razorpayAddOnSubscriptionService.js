'use strict';

/**
 * Recurring add-ons — extra user seats and Flow Builder.
 *
 * Each recurring add-on gets its OWN Razorpay subscription rather than being folded
 * into the plan subscription. That is not a stylistic choice: `createSubscription`
 * cancels and recreates the plan subscription on every upgrade, so anything bundled
 * into it would be destroyed the first time a customer moved tiers. Separate
 * subscriptions survive plan changes untouched, and `recomputeOverrides` does not
 * care where a grant came from.
 *
 * Entitlement is granted by the WEBHOOK (`subscription.activated` / `.charged`), never
 * by the checkout callback — a customer who closes the tab still gets what they paid
 * for. The callback verify below is a UX shortcut only.
 *
 * ⚠️ Subscriptions sign `payment_id|subscription_id`. Orders sign the REVERSE
 * (`order_id|payment_id`, see razorpayOrderService). Mixing them up fails silently.
 */

const crypto = require('crypto');
const razorpay = require('../config/razorpay');
const AddOn = require('../models/AddOn');
const SubscriptionAddOn = require('../models/SubscriptionAddOn');
const Transaction = require('../models/Transaction');
const addOnService = require('./addOnService');
const { resolvePurchase, AddOnPurchaseError } = require('./razorpayOrderService');
const { mapBillingCycle } = require('./razorpayPlanService');
const logger = require('../config/logger');

function safeSignatureEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * The Razorpay plan backing one (add-on, org-plan) pair, created on first use.
 *
 * Stored on the pricing row rather than the SKU because the same add-on costs
 * different amounts per plan, and a Razorpay plan is immutable once created.
 */
async function ensureAddOnRazorpayPlan(addOn, pricing) {
  if (pricing.razorpayPlanId) return pricing.razorpayPlanId;

  if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) {
    throw new AddOnPurchaseError('Payments are not configured. Please contact support.', 503);
  }

  const cycle = mapBillingCycle('monthly');
  let created;
  try {
    created = await razorpay.plans.create({
      period: cycle.period,
      interval: cycle.interval,
      item: {
        name: `${addOn.name} (${pricing.planId})`,
        amount: pricing.priceInr,          // paise
        currency: 'INR',
        description: addOn.description || undefined
      },
      notes: { addOnId: addOn.addOnId, planId: pricing.planId }
    });
  } catch (err) {
    logger.error('[Razorpay] add-on plan creation failed', {
      addOnId: addOn.addOnId,
      planId: pricing.planId,
      error: err?.error?.description || err.message
    });
    throw new AddOnPurchaseError(
      err?.error?.description || 'Could not set up this add-on for billing.',
      502
    );
  }

  // Persist against the exact pricing row so we never create a second plan for it.
  await AddOn.updateOne(
    { addOnId: addOn.addOnId, 'pricing.planId': pricing.planId },
    { $set: { 'pricing.$.razorpayPlanId': created.id } }
  );

  logger.info('[Razorpay] add-on plan created', {
    addOnId: addOn.addOnId,
    planId: pricing.planId,
    razorpayPlanId: created.id
  });
  return created.id;
}

/**
 * Start a recurring add-on purchase.
 *
 * Returns the Razorpay subscription id for checkout. The SubscriptionAddOn row is
 * created as `pending` and only becomes `active` — and therefore only grants
 * entitlement — when the webhook confirms payment.
 */
async function createAddOnSubscription({
  organizationId,
  organizationName,
  userId,
  userEmail,
  addOnId,
  quantity
}) {
  const { addOn, pricing, quantity: qty, planId } =
    await resolvePurchase(organizationId, addOnId, quantity);

  if (addOn.kind !== 'recurring') {
    throw new AddOnPurchaseError('This add-on is a one-time purchase, not a subscription.', 400);
  }

  // One live subscription per SKU per org — quantity is how you buy "more seats".
  const existing = await SubscriptionAddOn.findOne({
    organization: organizationId,
    addOnId: addOn.addOnId,
    status: { $in: ['pending', 'active', 'past_due'] }
  }).lean();
  if (existing) {
    throw new AddOnPurchaseError(
      `You already have "${addOn.name}". Change the quantity or cancel it first.`,
      409
    );
  }

  const razorpayPlanId = await ensureAddOnRazorpayPlan(addOn, pricing);

  let rzpSubscription;
  try {
    rzpSubscription = await razorpay.subscriptions.create({
      plan_id: razorpayPlanId,
      total_count: 120,        // 10 years of monthly cycles, same as the plan flow
      quantity: qty,
      notes: {
        organizationId: String(organizationId),
        addOnId: addOn.addOnId,
        planId,
        kind: 'addon'          // makes add-on subscriptions identifiable in the dashboard
      }
    });
  } catch (err) {
    logger.error('[Razorpay] add-on subscription creation failed', {
      organizationId: String(organizationId),
      addOnId: addOn.addOnId,
      error: err?.error?.description || err.message
    });
    throw new AddOnPurchaseError(
      err?.error?.description || 'Could not start the subscription. Please try again.',
      502
    );
  }

  await SubscriptionAddOn.create({
    organization: organizationId,
    addOnId: addOn.addOnId,
    quantity: qty,
    unitPriceInr: pricing.priceInr,
    status: 'pending',
    razorpaySubscriptionId: rzpSubscription.id,
    // Snapshot what this grants, so a later SKU change never rewrites what was bought.
    grantSnapshot: {
      featureKey: addOn.grant.featureKey,
      mode: addOn.grant.mode,
      amountPerUnit: pricing.grantAmount ?? (addOn.grant.mode === 'boolean_grant' ? 1 : 0)
    },
    createdBy: userId || null
  });

  try {
    await Transaction.create({
      organization: organizationId,
      organizationName: organizationName || '',
      user: userId,
      userEmail: userEmail || '',
      planId,
      razorpaySubscriptionId: rzpSubscription.id,
      amountInr: pricing.priceInr * qty,
      currency: 'INR',
      type: 'addon_subscription',
      status: 'pending',
      lineItems: [{
        addOnId: addOn.addOnId,
        name: addOn.name,
        quantity: qty,
        unitAmountInr: pricing.priceInr,
        amountInr: pricing.priceInr * qty,
        grantFeatureKey: addOn.grant.featureKey,
        grantAmount: (pricing.grantAmount || 0) * qty
      }]
    });
  } catch (txErr) {
    // Billing already exists at this point; a missing audit row must not fail checkout.
    logger.warn('[addOns] failed to record subscription transaction', { error: txErr.message });
  }

  logger.info('[Razorpay] add-on subscription created', {
    organizationId: String(organizationId),
    addOnId: addOn.addOnId,
    razorpaySubscriptionId: rzpSubscription.id,
    quantity: qty
  });

  return {
    subscriptionId: rzpSubscription.id,
    keyId: process.env.RAZORPAY_KEY_ID,
    amountInr: pricing.priceInr * qty,
    currency: 'INR',
    addOn: { addOnId: addOn.addOnId, name: addOn.name, quantity: qty }
  };
}

/** Checkout callback signature: HMAC over `payment_id|subscription_id`. */
function verifyAddOnSubscriptionSignature({
  razorpay_payment_id,
  razorpay_subscription_id,
  razorpay_signature
}) {
  if (!razorpay_payment_id || !razorpay_subscription_id || !razorpay_signature) return false;
  const expected = crypto
    .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
    .update(`${razorpay_payment_id}|${razorpay_subscription_id}`)
    .digest('hex');
  return safeSignatureEqual(expected, razorpay_signature);
}

/**
 * Mark an add-on subscription paid and grant its entitlement.
 *
 * Idempotent: activating an already-active row recomputes to the same overrides,
 * so webhook redelivery and the checkout callback can both call this safely.
 */
async function activateAddOnSubscription(razorpaySubscriptionId, { periodStart, periodEnd } = {}) {
  const addOnSub = await SubscriptionAddOn.findOne({ razorpaySubscriptionId });
  if (!addOnSub) return { activated: false, reason: 'not_found' };

  // A cancelled row must not be resurrected by a late webhook.
  if (addOnSub.status === 'cancelled') {
    return { activated: false, reason: 'cancelled' };
  }

  addOnSub.status = 'active';
  if (periodStart) addOnSub.currentPeriodStart = periodStart;
  if (periodEnd) addOnSub.currentPeriodEnd = periodEnd;
  await addOnSub.save();

  await addOnService.recomputeOverrides(addOnSub.organization);

  logger.info('[addOns] recurring add-on active', {
    organizationId: String(addOnSub.organization),
    addOnId: addOnSub.addOnId,
    razorpaySubscriptionId
  });
  return { activated: true, organizationId: String(addOnSub.organization), addOnId: addOnSub.addOnId };
}

/** A renewal failed — keep the entitlement, flag the row for the billing page. */
async function markAddOnPastDue(razorpaySubscriptionId) {
  const addOnSub = await SubscriptionAddOn.findOne({ razorpaySubscriptionId });
  if (!addOnSub || addOnSub.status === 'cancelled') return { updated: false };
  addOnSub.status = 'past_due';
  await addOnSub.save();
  // The entitlement deliberately survives a failed renewal — `recomputeOverrides`
  // counts `past_due` alongside `active`. Capacity is only removed when Razorpay gives
  // up and cancels, which arrives as `subscription.cancelled`.
  return { updated: true };
}

/**
 * Stop a recurring add-on.
 *
 * Default is end-of-cycle: the customer paid for this month, so they keep the
 * capability until it expires. `immediate` revokes now (used when Razorpay tells us
 * the subscription is already dead).
 */
async function cancelAddOnSubscription({ organizationId, addOnId, immediate = false }) {
  const addOnSub = await SubscriptionAddOn.findOne({
    organization: organizationId,
    addOnId,
    status: { $in: ['pending', 'active', 'past_due'] }
  });
  if (!addOnSub) {
    throw new AddOnPurchaseError('No active subscription for this add-on.', 404);
  }

  if (addOnSub.razorpaySubscriptionId) {
    try {
      await razorpay.subscriptions.cancel(
        addOnSub.razorpaySubscriptionId,
        // Razorpay: cancel_at_cycle_end 1 = at period end, 0 = now
        { cancel_at_cycle_end: immediate ? 0 : 1 }
      );
    } catch (err) {
      const description = err?.error?.description || err.message;
      // Already cancelled at Razorpay → converge our record instead of failing.
      const alreadyGone = /already\s+cancell?ed|not\s+found/i.test(String(description));
      if (!alreadyGone) {
        logger.error('[Razorpay] add-on cancellation failed', {
          organizationId: String(organizationId),
          addOnId,
          error: description
        });
        throw new AddOnPurchaseError(description || 'Could not cancel the add-on.', 502);
      }
      logger.warn('[Razorpay] add-on already cancelled at Razorpay, converging locally', {
        addOnId,
        error: description
      });
    }
  }

  if (immediate) {
    addOnSub.status = 'cancelled';
    addOnSub.cancelledAt = new Date();
    addOnSub.cancelAtPeriodEnd = false;
  } else {
    // Still `active`, so recomputeOverrides keeps granting until the period actually ends.
    addOnSub.cancelAtPeriodEnd = true;
  }
  await addOnSub.save();

  // Only an immediate cancel changes entitlement now; end-of-cycle is revoked by the
  // `subscription.cancelled` webhook when Razorpay closes it.
  if (immediate) await addOnService.recomputeOverrides(organizationId);

  logger.info('[addOns] recurring add-on cancelled', {
    organizationId: String(organizationId),
    addOnId,
    immediate
  });

  return {
    addOnId,
    status: addOnSub.status,
    cancelAtPeriodEnd: addOnSub.cancelAtPeriodEnd,
    currentPeriodEnd: addOnSub.currentPeriodEnd || null
  };
}

/** Razorpay closed the subscription for good — revoke the entitlement. */
async function finaliseAddOnCancellation(razorpaySubscriptionId) {
  const addOnSub = await SubscriptionAddOn.findOne({ razorpaySubscriptionId });
  if (!addOnSub) return { updated: false, reason: 'not_found' };
  if (addOnSub.status === 'cancelled') return { updated: false, reason: 'already_cancelled' };

  addOnSub.status = 'cancelled';
  addOnSub.cancelledAt = new Date();
  await addOnSub.save();

  await addOnService.recomputeOverrides(addOnSub.organization);

  logger.info('[addOns] recurring add-on closed by Razorpay', {
    organizationId: String(addOnSub.organization),
    addOnId: addOnSub.addOnId
  });
  return { updated: true, organizationId: String(addOnSub.organization) };
}

module.exports = {
  ensureAddOnRazorpayPlan,
  createAddOnSubscription,
  verifyAddOnSubscriptionSignature,
  activateAddOnSubscription,
  markAddOnPastDue,
  cancelAddOnSubscription,
  finaliseAddOnCancellation
};
