/**
 * Entitlements Service
 *
 * SINGLE SOURCE OF TRUTH for answering "what is this organization allowed to do?".
 *
 * Why this exists:
 *   Before this service, entitlements were read from THREE overlapping places:
 *     1. Organization.subscription.plan + Organization.limits  (legacy embedded data)
 *     2. Subscription.planId + Subscription.limits             (per-org billing doc)
 *     3. Plan.limits                                           (catalog definitions)
 *
 *   The limits could (and did) drift between these three whenever a plan definition
 *   was updated or a subscription was upgraded. Every middleware and controller had
 *   its own copy of the resolution logic, so a bug fix had to be made in 6 places.
 *
 * Resolution strategy (in order):
 *   1. Subscription → fetch current Plan by planId → use Plan.limits         ← preferred
 *   2. No Subscription → use Organization.limits (legacy) mapped to canonical shape
 *   3. No limits stored → use the free-plan definition
 *   4. No free plan seeded → hard-coded minimal defaults (fail-safe)
 *
 * Caching:
 *   Entitlements rarely change. We cache the resolved result in Redis with a short
 *   TTL (60s) and expose invalidateEntitlements(orgId) which MUST be called from
 *   every code path that mutates subscription state (upgrade, cancel, webhook).
 *
 * Exports:
 *   getEntitlements(organizationId)       → { planId, limits, usage, features, ... }
 *   canAddResource(orgId, kind, delta=1)  → { allowed, limit, current, remaining, isUnlimited }
 *   invalidateEntitlements(organizationId)
 */

const Organization = require('../models/Organization');
const Subscription = require('../models/Subscription');
const Plan = require('../models/Plan');
const cacheService = require('./cacheService');
const logger = require('../config/logger');

const CACHE_TTL_SECONDS = 60;

// Absolute fallback when nothing is seeded — conservative values.
const HARD_DEFAULTS = Object.freeze({
  planId: 'free',
  planName: 'Free',
  tier: 0,
  limits: {
    maxAccounts: 1,
    maxUsers: 1,
    maxPostsPerMonth: 10,
    maxAutoRepliesPerMonth: 50,
    maxAICreditsPerMonth: 100,
    maxStorageGB: 1,
    maxAPICallsPerDay: 100
  },
  features: []
});

/**
 * Normalize legacy Organization.limits field names to the canonical Plan.limits shape.
 * Old names: maxPlatformConnections, maxInteractionsPerMonth
 * Canonical: maxAccounts, maxPostsPerMonth (interactions repurposed as posts here is wrong —
 * we keep these separate and just copy the values most closely equivalent).
 */
function normalizeLegacyOrgLimits(orgLimits = {}) {
  return {
    maxAccounts: orgLimits.maxPlatformConnections ?? HARD_DEFAULTS.limits.maxAccounts,
    maxUsers: orgLimits.maxUsers ?? HARD_DEFAULTS.limits.maxUsers,
    // Organization.limits.maxInteractionsPerMonth is a different concept from
    // Plan.limits.maxPostsPerMonth, but it is the closest thing the legacy shape has.
    // We keep them distinct here and let callers ask for the field they actually care about.
    maxPostsPerMonth: HARD_DEFAULTS.limits.maxPostsPerMonth,
    maxAutoRepliesPerMonth: HARD_DEFAULTS.limits.maxAutoRepliesPerMonth,
    maxAICreditsPerMonth: orgLimits.maxAICreditsPerMonth ?? HARD_DEFAULTS.limits.maxAICreditsPerMonth,
    maxStorageGB: HARD_DEFAULTS.limits.maxStorageGB,
    maxAPICallsPerDay: HARD_DEFAULTS.limits.maxAPICallsPerDay
  };
}

/**
 * Resolve entitlements from the database without touching the cache.
 * @param {string} organizationId
 * @returns {Promise<object>}
 */
async function resolveFromDb(organizationId) {
  const [subscription, organization] = await Promise.all([
    Subscription.findOne({ organization: organizationId }).lean(),
    Organization.findById(organizationId).select('limits usage subscription').lean()
  ]);

  // ── Preferred path: Subscription → Plan (live lookup, no snapshot drift) ────
  if (subscription?.planId) {
    const plan = await Plan.findOne({ planId: subscription.planId, isActive: true }).lean();

    if (plan) {
      return {
        source: 'subscription',
        planId: plan.planId,
        planName: plan.name,
        tier: plan.tier,
        limits: plan.limits,
        features: plan.features || [],
        usage: subscription.usage || {},
        status: subscription.status,
        isActive: subscription.status === 'active' || subscription.status === 'trialing',
        billingCycle: subscription.billingCycle,
        currentPeriodEnd: subscription.currentPeriodEnd || null
      };
    }

    // Plan referenced by the subscription is missing/inactive — fall through and log.
    logger.warn('[entitlementsService] Subscription references unknown plan', {
      organizationId,
      planId: subscription.planId
    });
  }

  // ── Fallback: legacy Organization.limits ─────────────────────────────────────
  if (organization?.limits) {
    return {
      source: 'organization-legacy',
      planId: organization.subscription?.plan || 'free',
      planName: (organization.subscription?.plan || 'free').replace(/^./, (c) => c.toUpperCase()),
      tier: 0,
      limits: normalizeLegacyOrgLimits(organization.limits),
      features: [],
      usage: mapLegacyOrgUsage(organization.usage || {}),
      status: organization.subscription?.status || 'trial',
      isActive: ['active', 'trialing', 'trial'].includes(organization.subscription?.status || 'trial'),
      billingCycle: null,
      currentPeriodEnd: organization.subscription?.endDate || null
    };
  }

  // ── Last resort: free plan from DB, else hard defaults ───────────────────────
  const freePlan = await Plan.findOne({ planId: 'free', isActive: true }).lean();
  if (freePlan) {
    return {
      source: 'default-free',
      planId: freePlan.planId,
      planName: freePlan.name,
      tier: freePlan.tier,
      limits: freePlan.limits,
      features: freePlan.features || [],
      usage: {},
      status: 'trial',
      isActive: true,
      billingCycle: null,
      currentPeriodEnd: null
    };
  }

  logger.error('[entitlementsService] No subscription, org.limits, or free plan — using hard defaults', {
    organizationId
  });
  return {
    source: 'hard-default',
    ...HARD_DEFAULTS,
    usage: {},
    status: 'trial',
    isActive: true,
    billingCycle: null,
    currentPeriodEnd: null
  };
}

/**
 * Map legacy Organization.usage field names to the canonical Subscription.usage shape,
 * so callers always see the same keys no matter which code path sourced the data.
 */
function mapLegacyOrgUsage(orgUsage) {
  return {
    connectedAccounts: orgUsage.currentPlatformConnections ?? 0,
    activeUsers: orgUsage.currentUsers ?? 0,
    postsThisMonth: 0, // not tracked in the legacy shape
    autoRepliesThisMonth: 0,
    aiCreditsThisMonth: orgUsage.aiCreditsUsedThisMonth ?? 0,
    lastResetAt: orgUsage.lastResetDate || null
  };
}

/**
 * Redis-cached entitlements for an organization.
 *
 * @param {string} organizationId
 * @param {object} [options]
 * @param {boolean} [options.bypassCache=false] - Skip the cache read (still writes back)
 * @returns {Promise<object>} entitlements
 */
async function getEntitlements(organizationId, { bypassCache = false } = {}) {
  if (!organizationId) throw new Error('getEntitlements: organizationId is required');
  const orgIdStr = organizationId.toString();
  const key = cacheService.entitlementsKey(orgIdStr);

  if (!bypassCache) {
    const cached = await cacheService.get(key);
    if (cached) return cached;
  }

  const entitlements = await resolveFromDb(orgIdStr);
  await cacheService.set(key, entitlements, CACHE_TTL_SECONDS);
  return entitlements;
}

/**
 * Drop the cached entitlements for an organization.
 * MUST be called after any write that changes subscription state or plan assignment.
 *
 * @param {string} organizationId
 */
async function invalidateEntitlements(organizationId) {
  if (!organizationId) return;
  const key = cacheService.entitlementsKey(organizationId.toString());
  await cacheService.del(key);
}

/**
 * Convenience: check whether an org can add N more of a given resource kind.
 * Centralizes the "is this unlimited, is this at capacity?" logic so it stops
 * being duplicated across middlewares and controllers.
 *
 * @param {string} organizationId
 * @param {'accounts'|'users'|'posts'|'autoReplies'|'aiCredits'} kind
 * @param {number} [currentCountOverride] - Pass a freshly-computed count to avoid
 *     trusting the cached usage counter (e.g. platform connection limits recount
 *     live because usage drift is common).
 * @param {number} [delta=1] - How many to add
 * @returns {Promise<{ allowed, limit, current, remaining, isUnlimited }>}
 */
async function canAddResource(organizationId, kind, currentCountOverride, delta = 1) {
  const entitlements = await getEntitlements(organizationId);

  const LIMIT_KEY_BY_KIND = {
    accounts: { limit: 'maxAccounts', usage: 'connectedAccounts' },
    users: { limit: 'maxUsers', usage: 'activeUsers' },
    posts: { limit: 'maxPostsPerMonth', usage: 'postsThisMonth' },
    autoReplies: { limit: 'maxAutoRepliesPerMonth', usage: 'autoRepliesThisMonth' },
    aiCredits: { limit: 'maxAICreditsPerMonth', usage: 'aiCreditsThisMonth' }
  };

  const keys = LIMIT_KEY_BY_KIND[kind];
  if (!keys) throw new Error(`canAddResource: unsupported kind "${kind}"`);

  const limit = entitlements.limits[keys.limit];
  const current = currentCountOverride != null
    ? currentCountOverride
    : (entitlements.usage[keys.usage] ?? 0);

  const isUnlimited = limit === -1;
  const allowed = isUnlimited || current + delta <= limit;
  const remaining = isUnlimited ? Infinity : Math.max(0, limit - current);

  return { allowed, limit, current, remaining, isUnlimited };
}

module.exports = {
  getEntitlements,
  canAddResource,
  invalidateEntitlements,
  // Exported for tests
  _resolveFromDb: resolveFromDb
};
