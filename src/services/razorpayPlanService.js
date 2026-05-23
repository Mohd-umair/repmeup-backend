'use strict';

const razorpay = require('../config/razorpay');
const logger = require('../config/logger');

class RazorpayPlanSyncError extends Error {
  constructor(message, { statusCode = 502, razorpayCode } = {}) {
    super(message);
    this.name = 'RazorpayPlanSyncError';
    this.statusCode = statusCode;
    this.razorpayCode = razorpayCode;
  }
}

function extractRzpError(err) {
  return err?.error?.description || err?.error?.code || err?.message || 'Razorpay request failed';
}

function hasRazorpayCredentials() {
  return Boolean(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET);
}

/**
 * True when the plan should be billed via Razorpay subscriptions.
 */
function isPaidBillablePlan(plan) {
  if (!plan) return false;
  if (plan.price === 0 || plan.price === 'free') return false;
  if (plan.price === 'custom' || typeof plan.price === 'string') return false;
  if (typeof plan.price !== 'number' || plan.price <= 0) return false;
  const cycle = plan.billingCycle || 'monthly';
  return cycle === 'monthly' || cycle === 'yearly';
}

/**
 * Resolve monthly/yearly price in paise for Razorpay.
 * Uses stored priceInr when set; otherwise derives from whole-rupee `price`.
 */
function resolvePriceInPaise(plan) {
  if (!isPaidBillablePlan(plan)) return null;

  // Whole-rupee `price` is the admin source of truth when numeric.
  const rupees = Number(plan.price);
  if (Number.isFinite(rupees) && rupees > 0) {
    return Math.round(rupees * 100);
  }

  if (plan.priceInr != null && plan.priceInr !== '') {
    const stored = Number(plan.priceInr);
    if (Number.isFinite(stored) && stored > 0) return Math.round(stored);
  }

  return null;
}

/**
 * Map app billingCycle to Razorpay plan period/interval.
 * custom/lifetime plans are not synced with Razorpay.
 */
function mapBillingCycle(billingCycle) {
  switch (billingCycle || 'monthly') {
    case 'monthly':
      return { period: 'monthly', interval: 1 };
    case 'yearly':
      return { period: 'yearly', interval: 1 };
    default:
      return null;
  }
}

/**
 * Whether a new Razorpay plan must be created (plans are immutable on Razorpay).
 */
function needsNewRazorpayPlan(previousPlan, nextPlan) {
  if (!isPaidBillablePlan(nextPlan)) return false;
  if (!previousPlan) return true;
  if (!previousPlan.razorpayPlanId) return true;

  const prevPaise = resolvePriceInPaise(previousPlan);
  const nextPaise = resolvePriceInPaise(nextPlan);
  if (prevPaise !== nextPaise) return true;

  const prevCycle = previousPlan.billingCycle || 'monthly';
  const nextCycle = nextPlan.billingCycle || 'monthly';
  return prevCycle !== nextCycle;
}

/**
 * Create a Razorpay Plan via API.
 * @returns {Promise<{ razorpayPlanId: string, priceInr: number }>}
 */
async function createRazorpayPlan(planDoc) {
  if (!hasRazorpayCredentials()) {
    throw new RazorpayPlanSyncError(
      'Razorpay credentials are not configured. Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET.',
      { statusCode: 503 }
    );
  }

  const priceInPaise = resolvePriceInPaise(planDoc);
  if (!priceInPaise) {
    throw new RazorpayPlanSyncError('Invalid price for Razorpay plan creation.', { statusCode: 400 });
  }

  const billing = mapBillingCycle(planDoc.billingCycle);
  if (!billing) {
    throw new RazorpayPlanSyncError(
      `Billing cycle "${planDoc.billingCycle}" is not supported for Razorpay subscriptions.`,
      { statusCode: 400 }
    );
  }

  const billingLabel = planDoc.billingCycle === 'yearly' ? 'yearly' : 'monthly';

  try {
    const rzpPlan = await razorpay.plans.create({
      period: billing.period,
      interval: billing.interval,
      item: {
        name: `RepMeUp ${planDoc.name} Plan`,
        amount: priceInPaise,
        currency: 'INR',
        description:
          planDoc.description ||
          `RepMeUp ${planDoc.name} — ${billingLabel} subscription`
      },
      notes: {
        planId: String(planDoc.planId || ''),
        planName: String(planDoc.name || ''),
        tier: String(planDoc.tier ?? '')
      }
    });

    logger.info('[RazorpayPlan] Created Razorpay plan', {
      planId: planDoc.planId,
      razorpayPlanId: rzpPlan.id,
      priceInr: priceInPaise
    });

    return {
      razorpayPlanId: rzpPlan.id,
      priceInr: priceInPaise
    };
  } catch (err) {
    const description = extractRzpError(err);
    logger.error('[RazorpayPlan] create failed', {
      planId: planDoc.planId,
      description,
      statusCode: err?.statusCode
    });
    throw new RazorpayPlanSyncError(description, {
      statusCode: err?.statusCode && err.statusCode >= 400 && err.statusCode < 600 ? err.statusCode : 502,
      razorpayCode: err?.error?.code
    });
  }
}

/**
 * Sync Mongo plan document with Razorpay.
 * @param {object} planDoc - current plan state (plain object or mongoose doc)
 * @param {object|null} previousPlan - prior state on update; omit on create
 * @returns {Promise<{ razorpayPlanId?: string|null, priceInr?: number|null, created: boolean }>}
 */
async function syncPlanWithRazorpay(planDoc, previousPlan = null) {
  const nextPlain = planDoc?.toObject ? planDoc.toObject() : { ...planDoc };

  if (!isPaidBillablePlan(nextPlain)) {
    return {
      razorpayPlanId: null,
      priceInr: null,
      created: false
    };
  }

  const priceInr = resolvePriceInPaise(nextPlain);
  if (!priceInr) {
    throw new RazorpayPlanSyncError('Paid plan must have a valid numeric price in INR.', {
      statusCode: 400
    });
  }

  const prevPlain = previousPlan
    ? (previousPlan.toObject ? previousPlan.toObject() : { ...previousPlan })
    : null;

  if (!needsNewRazorpayPlan(prevPlain, nextPlain)) {
    return {
      razorpayPlanId: prevPlain?.razorpayPlanId || nextPlain.razorpayPlanId,
      priceInr,
      created: false
    };
  }

  const created = await createRazorpayPlan({ ...nextPlain, priceInr });
  return {
    razorpayPlanId: created.razorpayPlanId,
    priceInr: created.priceInr,
    created: true
  };
}

module.exports = {
  RazorpayPlanSyncError,
  extractRzpError,
  hasRazorpayCredentials,
  isPaidBillablePlan,
  resolvePriceInPaise,
  mapBillingCycle,
  needsNewRazorpayPlan,
  createRazorpayPlan,
  syncPlanWithRazorpay
};
