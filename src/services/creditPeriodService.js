'use strict';

/**
 * Credit Period Service
 *
 * Single source of truth for AI credit period management.
 * Implements unlimited monthly carry-forward for the main AI credit pool
 * (credits.ai.monthly / maxAICreditsPerMonth) using a lazy UTC calendar-month
 * rollover — no cron required.
 *
 * Design mirrors bucketService's lazy-reset pattern:
 *   - `ensureAiCreditPeriodCurrent()` is called before every credit read/write.
 *   - If the stored `usage.creditPeriodStart` is in a prior UTC month, unused
 *     credits are banked into `usage.carriedCredits`, usage is reset to 0, and
 *     the period anchor is advanced atomically to prevent double-rollover under
 *     concurrent requests.
 *
 * Excluded from carry-forward:
 *   - Unlimited plans  (planLimit === -1)
 *   - Demo workspaces  (isDemo === true — temporary trials should not bank credits)
 */

const Subscription = require('../models/Subscription');
const AICreditUsage = require('../models/AICreditUsage');
const entitlementsService = require('./entitlementsService');

/**
 * Returns the UTC month key string for a date, e.g. '2026-01'.
 * Shared semantics with bucketService for period comparisons.
 *
 * @param {Date|string|number} date
 * @returns {string}
 */
function monthKeyUTC(date) {
  const d = date instanceof Date ? date : new Date(date);
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
}

/**
 * Returns the start of the given UTC calendar month (midnight UTC on the 1st).
 *
 * @param {Date} [now=new Date()]
 * @returns {Date}
 */
function utcMonthStart(now = new Date()) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0));
}

/**
 * Ensure the AI credit period for an organisation is current (lazy rollover).
 *
 * Called before every AI credit read or write. If the stored
 * `usage.creditPeriodStart` is in a prior UTC calendar month:
 *   - Computes `remaining = max(0, planLimit + carriedCredits - aiCreditsThisMonth)`
 *   - Banks `remaining` into `usage.carriedCredits` (unlimited, no cap)
 *   - Resets `usage.aiCreditsThisMonth` to 0
 *   - Advances `usage.creditPeriodStart` to the start of the current UTC month
 *
 * The `findOneAndUpdate` conditions on the old `creditPeriodStart` value so that
 * exactly one concurrent call wins the rollover; the others re-read the settled
 * state without a second write.
 *
 * @param {string} organizationId
 * @returns {Promise<{planLimit: number, carriedCredits: number, used: number, effectiveLimit: number, remaining: number, isUnlimited: boolean}>}
 */
async function ensureAiCreditPeriodCurrent(organizationId) {
  const [entitlements, subscription] = await Promise.all([
    entitlementsService.getEntitlements(organizationId),
    Subscription.findOne({ organization: organizationId })
      .select('usage.aiCreditsThisMonth usage.carriedCredits usage.creditPeriodStart isDemo demoCreditsCap')
      .lean()
  ]);

  if (!subscription) {
    return { planLimit: 0, carriedCredits: 0, used: 0, effectiveLimit: 0, remaining: 0, isUnlimited: false };
  }

  let planLimit = entitlements.limits.maxAICreditsPerMonth ?? 0;
  if (subscription.isDemo && subscription.demoCreditsCap != null && subscription.demoCreditsCap >= 0) {
    planLimit = subscription.demoCreditsCap;
  }

  const isUnlimited = planLimit === -1;

  if (isUnlimited) {
    const used = subscription.usage?.aiCreditsThisMonth ?? 0;
    return { planLimit, carriedCredits: 0, used, effectiveLimit: -1, remaining: Infinity, isUnlimited: true };
  }

  const carriedCredits = subscription.usage?.carriedCredits ?? 0;
  const used = subscription.usage?.aiCreditsThisMonth ?? 0;
  const effectiveLimit = planLimit + carriedCredits;
  const remaining = Math.max(0, effectiveLimit - used);

  // Demo workspaces do not accumulate carry-forward credits.
  if (subscription.isDemo) {
    return { planLimit, carriedCredits, used, effectiveLimit, remaining, isUnlimited: false };
  }

  const now = new Date();
  const currentMonthKey = monthKeyUTC(now);
  const storedPeriodStart = subscription.usage?.creditPeriodStart
    ? new Date(subscription.usage.creditPeriodStart)
    : null;
  const storedMonthKey = storedPeriodStart ? monthKeyUTC(storedPeriodStart) : null;

  // Same UTC month — no rollover needed.
  if (storedMonthKey === currentMonthKey) {
    return { planLimit, carriedCredits, used, effectiveLimit, remaining, isUnlimited: false };
  }

  // New UTC month — bank unused credits and reset usage.
  const newCarried = Math.max(0, effectiveLimit - used);
  const newPeriodStart = utcMonthStart(now);

  // Atomic: condition on the old creditPeriodStart so only one concurrent caller
  // applies the rollover. Others will read the already-settled state below.
  const updated = await Subscription.findOneAndUpdate(
    {
      organization: organizationId,
      // Match the exact value we read — Date equality or null/missing
      'usage.creditPeriodStart': storedPeriodStart
    },
    {
      $set: {
        'usage.carriedCredits': newCarried,
        'usage.aiCreditsThisMonth': 0,
        'usage.lastResetAt': newPeriodStart,
        'usage.creditPeriodStart': newPeriodStart
      }
    },
    { new: true, select: 'usage.aiCreditsThisMonth usage.carriedCredits usage.creditPeriodStart' }
  );

  if (!updated) {
    // A concurrent call already applied the rollover — re-read the settled state.
    const fresh = await Subscription.findOne({ organization: organizationId })
      .select('usage.aiCreditsThisMonth usage.carriedCredits')
      .lean();
    const freshCarried = fresh?.usage?.carriedCredits ?? 0;
    const freshUsed = fresh?.usage?.aiCreditsThisMonth ?? 0;
    const freshEffective = planLimit + freshCarried;
    return {
      planLimit,
      carriedCredits: freshCarried,
      used: freshUsed,
      effectiveLimit: freshEffective,
      remaining: Math.max(0, freshEffective - freshUsed),
      isUnlimited: false
    };
  }

  // Audit log for the rollover (non-critical — don't propagate errors).
  try {
    await AICreditUsage.create({
      organization: organizationId,
      user: organizationId,
      operation: 'credit_rollover',
      creditsUsed: 0,
      metadata: {
        previousPeriod: storedMonthKey,
        newPeriod: currentMonthKey,
        bankedCredits: newCarried,
        planLimit
      }
    });
  } catch (_) {
    // Intentionally swallowed — audit failure must not block credit enforcement.
  }

  console.log(
    `[creditPeriodService] Rolled over AI credits for org ${organizationId}: ` +
    `${storedMonthKey} → ${currentMonthKey}, banked=${newCarried}, planLimit=${planLimit}`
  );

  const newEffective = planLimit + newCarried;
  return {
    planLimit,
    carriedCredits: newCarried,
    used: 0,
    effectiveLimit: newEffective,
    remaining: newEffective,
    isUnlimited: false
  };
}

module.exports = { monthKeyUTC, utcMonthStart, ensureAiCreditPeriodCurrent };
