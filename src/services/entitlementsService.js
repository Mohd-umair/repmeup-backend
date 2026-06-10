/**
 * Entitlements Service
 *
 * SINGLE SOURCE OF TRUTH for "what is this organization allowed to do?".
 *
 * Resolution chain (first match wins, per feature key):
 *   1. Plan.entitlements[key]                ← admin-edited typed map (preferred)
 *   2. Plan.limits.<legacyField>              ← back-compat for limit features
 *   3. Plan.features[].includes(<code>)       ← back-compat for boolean features
 *   4. Feature catalog defaultValue           ← code-defined fail-safe
 *
 * Public surface:
 *   getEntitlements(orgId)                  → resolved snapshot { keys: { …, _legacy }, plan }
 *   can(orgId, featureKey)                  → boolean (boolean + limit-not-zero)
 *   quota(orgId, featureKey)                → { limit, used, remaining, isUnlimited }
 *   consume(orgId, featureKey, n=1)         → atomic increment via bucketService
 *   assert(orgId, featureKey, [n=1])        → throws EntitlementError on violation
 *   invalidateEntitlements(orgId)           → drop Redis cache (after plan/sub changes)
 *
 * Legacy compatibility:
 *   - canAddResource(orgId, kind, ...) keeps the old API (used by accounts/users).
 *   - The old `entitlements.limits` shape (maxAccounts, maxUsers, …) is still returned
 *     so subscription/billing controllers don't have to change immediately.
 */

const Organization = require('../models/Organization');
const Subscription = require('../models/Subscription');
const Plan = require('../models/Plan');
const KnowledgeBase = require('../models/KnowledgeBase');
const cacheService = require('./cacheService');
const bucketService = require('./bucketService');
const logger = require('../config/logger');
const { CATALOG, CATALOG_BY_KEY, FEATURE_KEYS } = require('../config/featureCatalog');

const CACHE_TTL_SECONDS = 60;

/** HTTP-aware error class so route layers can map to 402/403 cleanly. */
class EntitlementError extends Error {
  constructor(message, { code = 'ENTITLEMENT_DENIED', featureKey, statusCode = 402, meta } = {}) {
    super(message);
    this.name = 'EntitlementError';
    this.code = code;
    this.featureKey = featureKey;
    this.statusCode = statusCode;
    this.meta = meta;
  }
}

/**
 * Map legacy limit fields (Plan.limits / Subscription.limits) → catalog feature keys.
 * Used as fallback when a plan has not been migrated to entitlements yet.
 */
const LEGACY_LIMIT_TO_KEY = {
  maxAccounts: FEATURE_KEYS.ACCOUNTS_MAX,
  maxUsers: FEATURE_KEYS.USERS_MAX,
  maxPostsPerMonth: FEATURE_KEYS.POSTS_PER_MONTH,
  maxAutoRepliesPerMonth: FEATURE_KEYS.CREDITS_AUTO_REPLY,
  maxAICreditsPerMonth: FEATURE_KEYS.CREDITS_AI_GENERAL,
  maxStorageGB: FEATURE_KEYS.STORAGE_GB,
  maxAPICallsPerDay: FEATURE_KEYS.API_CALLS_DAILY
};
const KEY_TO_LEGACY_LIMIT = Object.fromEntries(
  Object.entries(LEGACY_LIMIT_TO_KEY).map(([field, key]) => [key, field])
);

/**
 * Limit features whose `used` value must reflect live DB rows (not buckets).
 * KB entries can be deleted, so bucket counters would drift.
 */
const LIVE_COUNT_FEATURE_KEYS = new Set([
  FEATURE_KEYS.KB_ENTRIES_MAX
]);

async function getLiveUsedCount(organizationId, featureKey) {
  if (featureKey === FEATURE_KEYS.KB_ENTRIES_MAX) {
    return KnowledgeBase.countDocuments({ organization: organizationId });
  }
  return null;
}

/** Merge subscription.usageBuckets (plain object or Map) into a plain object. */
function normalizeUsageBuckets(raw) {
  if (!raw) return {};
  if (typeof raw.entries === 'function') {
    return Object.fromEntries(raw.entries());
  }
  return { ...raw };
}

/** Map legacy `Subscription.usage.*` → feature keys (for read-side back-compat). */
const LEGACY_USAGE_TO_KEY = {
  postsThisMonth: FEATURE_KEYS.POSTS_PER_MONTH,
  autoRepliesThisMonth: FEATURE_KEYS.CREDITS_AUTO_REPLY,
  aiCreditsThisMonth: FEATURE_KEYS.CREDITS_AI_GENERAL,
  connectedAccounts: FEATURE_KEYS.ACCOUNTS_MAX,
  activeUsers: FEATURE_KEYS.USERS_MAX
};

/** Hard fallback when nothing is seeded — minimal Free-tier shape. */
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

// ──────────────────────────────────────────────────────────────────────────────
// Resolution helpers
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Resolve the value for a single feature key from a Plan doc.
 * Returns the canonical { kind, enabled?, limit?, value? } shape.
 *
 * Order: plan.entitlements[key] → plan.limits.<legacy> → plan.features[]string → catalog default.
 */
/**
 * Read plan.entitlements[key] with case-insensitive fallback for legacy lowercase keys.
 */
function readPlanEntitlement(plan, featureKey) {
  const entitlements = plan?.entitlements;
  if (!entitlements) return null;
  if (typeof entitlements.get === 'function') {
    const direct = entitlements.get(featureKey);
    if (direct !== undefined && direct !== null) return direct;
    const lower = String(featureKey).toLowerCase();
    for (const [k, v] of entitlements.entries()) {
      if (String(k).toLowerCase() === lower) return v;
    }
    return null;
  }
  if (entitlements[featureKey] !== undefined && entitlements[featureKey] !== null) {
    return entitlements[featureKey];
  }
  const lower = String(featureKey).toLowerCase();
  const matchKey = Object.keys(entitlements).find((k) => String(k).toLowerCase() === lower);
  return matchKey ? entitlements[matchKey] : null;
}

function resolveFeatureFromPlan(plan, catalogEntry) {
  const empty = { source: 'default' };

  // 1. Admin-edited entitlements Map ────────────────────────────────────────
  const entRaw = readPlanEntitlement(plan, catalogEntry.key);
  if (entRaw && (entRaw.enabled !== undefined || entRaw.limit !== undefined || entRaw.value !== undefined)) {
    return { ...empty, source: 'plan.entitlements', ...normalizeValue(catalogEntry, entRaw) };
  }

  // 2. Legacy plan.limits.* mapped to a known key ────────────────────────────
  const legacyField = KEY_TO_LEGACY_LIMIT[catalogEntry.key];
  if (legacyField && plan?.limits && plan.limits[legacyField] !== undefined && catalogEntry.kind === 'limit') {
    return { ...empty, source: 'plan.limits', limit: plan.limits[legacyField], kind: 'limit' };
  }

  // 3. Legacy plan.features[] string array (boolean keys) ────────────────────
  if (catalogEntry.kind === 'boolean' && Array.isArray(plan?.features)) {
    const FEATURE_STRING_TO_KEY = {
      knowledge_base: FEATURE_KEYS.KB_ENTRIES_MAX,
      auto_reply: FEATURE_KEYS.AUTO_REPLY_ENABLED,
      ai_responses: FEATURE_KEYS.AUTO_REPLY_ENABLED,
      advanced_analytics: FEATURE_KEYS.ANALYTICS_ADVANCED,
      analytics_basic: FEATURE_KEYS.ANALYTICS_ADVANCED
    };
    const enabled = plan.features.some((c) => FEATURE_STRING_TO_KEY[c] === catalogEntry.key);
    if (enabled) return { ...empty, source: 'plan.features', enabled: true, kind: 'boolean' };
  }

  // 4. Catalog default ───────────────────────────────────────────────────────
  return { ...empty, ...defaultsFor(catalogEntry) };
}

function defaultsFor(catalogEntry) {
  const v = catalogEntry.defaultValue;
  switch (catalogEntry.kind) {
    case 'boolean':
      return { kind: 'boolean', enabled: v !== false };
    case 'limit':
      return { kind: 'limit', limit: typeof v === 'number' ? v : -1 };
    case 'enum':
      return { kind: 'enum', value: v };
    case 'list':
      return { kind: 'list', value: Array.isArray(v) ? v : [] };
    case 'json':
      return { kind: 'json', value: v ?? null };
    default:
      return { kind: 'json', value: v ?? null };
  }
}

function normalizeValue(catalogEntry, raw) {
  switch (catalogEntry.kind) {
    case 'boolean':
      return { kind: 'boolean', enabled: raw.enabled !== false && raw.enabled !== undefined ? !!raw.enabled : (raw.enabled === false ? false : true) };
    case 'limit': {
      const n = raw.limit ?? raw.value;
      return { kind: 'limit', limit: Number.isFinite(n) ? n : (catalogEntry.defaultValue ?? -1) };
    }
    case 'enum':
      return { kind: 'enum', value: raw.value ?? catalogEntry.defaultValue };
    case 'list':
      return { kind: 'list', value: Array.isArray(raw.value) ? raw.value : (Array.isArray(catalogEntry.defaultValue) ? catalogEntry.defaultValue : []) };
    case 'json':
    default:
      return { kind: 'json', value: raw.value ?? catalogEntry.defaultValue ?? null };
  }
}

/**
 * Build the resolved entitlements snapshot for an org without touching the cache.
 * Always returns BOTH the new `keys: {…}` map AND the legacy `limits: {…}` shape
 * so older callers continue to work.
 */
async function resolveFromDb(organizationId) {
  const [subscription, organization] = await Promise.all([
    Subscription.findOne({ organization: organizationId }).lean(),
    Organization.findById(organizationId).select('limits usage subscription').lean()
  ]);

  let plan = null;
  if (subscription?.planId) {
    plan = await Plan.findOne({ planId: subscription.planId, isActive: true }).lean();
    if (!plan) {
      logger.warn('[entitlementsService] Subscription references unknown plan', {
        organizationId,
        planId: subscription.planId
      });
    }
  }
  if (!plan) {
    plan = await Plan.findOne({ planId: 'free', isActive: true }).lean();
  }

  // Resolve every catalog key under the active plan (or plan-less HARD_DEFAULTS).
  const keys = {};
  for (const catalogEntry of CATALOG) {
    keys[catalogEntry.key] = resolveFeatureFromPlan(plan || {}, catalogEntry);
  }

  // Legacy `limits` view derived from the resolved keys.
  const limits = {};
  for (const [legacyField, key] of Object.entries(LEGACY_LIMIT_TO_KEY)) {
    const resolved = keys[key];
    limits[legacyField] = resolved?.kind === 'limit'
      ? resolved.limit
      : (HARD_DEFAULTS.limits[legacyField] ?? -1);
  }

  const usageBuckets = normalizeUsageBuckets(subscription?.usageBuckets);
  for (const featureKey of LIVE_COUNT_FEATURE_KEYS) {
    const liveUsed = await getLiveUsedCount(organizationId, featureKey);
    usageBuckets[featureKey] = {
      ...(usageBuckets[featureKey] || {}),
      used: liveUsed,
      periodStart: usageBuckets[featureKey]?.periodStart || null
    };
  }

  return {
    source: plan ? (subscription?.planId ? 'subscription' : 'default-free') : 'hard-default',
    planId: plan?.planId || HARD_DEFAULTS.planId,
    planName: plan?.name || HARD_DEFAULTS.planName,
    tier: plan?.tier ?? HARD_DEFAULTS.tier,
    limits, // legacy shape
    keys,   // new shape
    features: plan?.features || HARD_DEFAULTS.features,
    usage: subscription?.usage || mapLegacyOrgUsage(organization?.usage || {}),
    usageBuckets,
    status: subscription?.status || (organization?.subscription?.status || 'trial'),
    isActive: ['active', 'trialing', 'trial'].includes(
      subscription?.status || organization?.subscription?.status || 'trial'
    ),
    billingCycle: subscription?.billingCycle || null,
    currentPeriodEnd: subscription?.currentPeriodEnd || organization?.subscription?.endDate || null
  };
}

function mapLegacyOrgUsage(orgUsage) {
  return {
    connectedAccounts: orgUsage.currentPlatformConnections ?? 0,
    activeUsers: orgUsage.currentUsers ?? 0,
    postsThisMonth: 0,
    autoRepliesThisMonth: 0,
    aiCreditsThisMonth: orgUsage.aiCreditsUsedThisMonth ?? 0,
    lastResetAt: orgUsage.lastResetDate || null
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Public API
// ──────────────────────────────────────────────────────────────────────────────

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

async function invalidateEntitlements(organizationId) {
  if (!organizationId) return;
  const cacheKey = cacheService.entitlementsKey(organizationId.toString());
  await cacheService.del(cacheKey);
}

/**
 * Boolean check for any feature.
 * - `boolean` features → returns `enabled` flag.
 * - `limit`   features → returns true unless limit === 0 (i.e. quota wholly disabled).
 *                        Use `quota()` if you also need the remaining amount.
 * - other kinds        → true (presence implies allowed).
 */
async function can(organizationId, featureKey) {
  const catalogEntry = CATALOG_BY_KEY[featureKey];
  if (!catalogEntry) return true; // unknown key fails open
  const ent = await getEntitlements(organizationId);
  const resolved = ent.keys[featureKey];
  if (!resolved) return true;
  if (resolved.kind === 'boolean') return !!resolved.enabled;
  if (resolved.kind === 'limit') return resolved.limit !== 0; // 0 = explicitly disabled
  return true;
}

/**
 * Quota inspector for `limit` features.
 * Returns the per-org bucket state plus headroom.
 */
async function quota(organizationId, featureKey) {
  const catalogEntry = CATALOG_BY_KEY[featureKey];
  if (!catalogEntry || catalogEntry.kind !== 'limit') {
    throw new Error(`quota: feature "${featureKey}" is not a limit`);
  }

  const [ent, bucket] = await Promise.all([
    getEntitlements(organizationId),
    bucketService.getBucket(organizationId, featureKey)
  ]);

  const limit = ent.keys[featureKey]?.limit ?? catalogEntry.defaultValue ?? -1;
  const isUnlimited = limit === -1;
  let used = bucket.used ?? 0;
  if (LIVE_COUNT_FEATURE_KEYS.has(featureKey)) {
    used = await getLiveUsedCount(organizationId, featureKey);
  }
  const remaining = isUnlimited ? Infinity : Math.max(0, limit - used);

  return {
    featureKey,
    limit,
    used,
    remaining,
    isUnlimited,
    isExhausted: !isUnlimited && used >= limit,
    periodStart: bucket.periodStart,
    resetPeriod: catalogEntry.resetPeriod || 'none'
  };
}

/**
 * Throw EntitlementError unless org can do this op.
 * For boolean features → throws if disabled.
 * For limit   features → throws if used + amount > limit.
 */
async function assert(organizationId, featureKey, amount = 1) {
  const catalogEntry = CATALOG_BY_KEY[featureKey];
  if (!catalogEntry) return; // unknown key fails open

  if (catalogEntry.kind === 'boolean') {
    const allowed = await can(organizationId, featureKey);
    if (!allowed) {
      throw new EntitlementError(
        `Your plan does not include "${catalogEntry.label}". Upgrade to enable it.`,
        { code: 'FEATURE_DISABLED', featureKey, statusCode: 403 }
      );
    }
    return;
  }

  if (catalogEntry.kind === 'limit') {
    const q = await quota(organizationId, featureKey);
    if (q.isUnlimited) return;
    if (q.used + amount > q.limit) {
      throw new EntitlementError(
        `You've reached your "${catalogEntry.label}" limit (${q.used}/${q.limit}).`,
        {
          code: 'QUOTA_EXCEEDED',
          featureKey,
          statusCode: 402,
          meta: { limit: q.limit, used: q.used, remaining: q.remaining, needed: amount }
        }
      );
    }
  }
}

/**
 * Atomic consume: increment usage bucket then invalidate cache.
 * The cache invalidation isn't strictly needed (buckets aren't cached) but keeps
 * downstream callers from seeing a stale `entitlements.usage` snapshot.
 */
async function consume(organizationId, featureKey, amount = 1) {
  const catalogEntry = CATALOG_BY_KEY[featureKey];
  if (!catalogEntry || catalogEntry.kind !== 'limit') return null;
  const result = await bucketService.consume(organizationId, featureKey, amount);
  // We don't drop the entitlements cache here because plan/limits haven't
  // changed — `quota()` reads buckets live. Cache only holds plan-side data.
  return result;
}

// ──────────────────────────────────────────────────────────────────────────────
// Legacy API kept stable
// ──────────────────────────────────────────────────────────────────────────────

const LIMIT_KEY_BY_KIND = {
  accounts: { limit: 'maxAccounts', usage: 'connectedAccounts', featureKey: FEATURE_KEYS.ACCOUNTS_MAX },
  users: { limit: 'maxUsers', usage: 'activeUsers', featureKey: FEATURE_KEYS.USERS_MAX },
  posts: { limit: 'maxPostsPerMonth', usage: 'postsThisMonth', featureKey: FEATURE_KEYS.POSTS_PER_MONTH },
  autoReplies: {
    limit: 'maxAutoRepliesPerMonth',
    usage: 'autoRepliesThisMonth',
    featureKey: FEATURE_KEYS.CREDITS_AUTO_REPLY
  },
  aiCredits: {
    limit: 'maxAICreditsPerMonth',
    usage: 'aiCreditsThisMonth',
    featureKey: FEATURE_KEYS.CREDITS_AI_GENERAL
  }
};

async function canAddResource(organizationId, kind, currentCountOverride, delta = 1) {
  const keys = LIMIT_KEY_BY_KIND[kind];
  if (!keys) throw new Error(`canAddResource: unsupported kind "${kind}"`);

  const entitlements = await getEntitlements(organizationId);
  const limit = entitlements.limits[keys.limit];
  const isUnlimited = limit === -1;

  let current;
  if (currentCountOverride != null) {
    current = currentCountOverride;
  } else {
    // Prefer the bucket counter when one exists (post-migration); fall back to legacy.
    try {
      const bucket = await bucketService.getBucket(organizationId, keys.featureKey);
      current = bucket.used ?? entitlements.usage[keys.usage] ?? 0;
    } catch {
      current = entitlements.usage[keys.usage] ?? 0;
    }
  }

  const allowed = isUnlimited || current + delta <= limit;
  const remaining = isUnlimited ? Infinity : Math.max(0, limit - current);
  return { allowed, limit, current, remaining, isUnlimited };
}

function resolvePlanFeature(plan, featureKey) {
  const catalogEntry = CATALOG_BY_KEY[featureKey];
  if (!catalogEntry) return null;
  return resolveFeatureFromPlan(plan || {}, catalogEntry);
}

function buildLegacyLimitsFromPlan(plan) {
  const limits = {};
  for (const [legacyField, key] of Object.entries(LEGACY_LIMIT_TO_KEY)) {
    const catalogEntry = CATALOG_BY_KEY[key];
    const resolved = resolveFeatureFromPlan(plan || {}, catalogEntry);
    limits[legacyField] =
      resolved?.kind === 'limit'
        ? resolved.limit
        : (HARD_DEFAULTS.limits[legacyField] ?? -1);
  }
  return limits;
}

module.exports = {
  // New API
  getEntitlements,
  can,
  quota,
  assert,
  consume,
  invalidateEntitlements,
  EntitlementError,
  resolvePlanFeature,
  buildLegacyLimitsFromPlan,
  // Legacy API (still used by accounts/users middlewares — keep stable)
  canAddResource,
  // Test hooks
  _resolveFromDb: resolveFromDb,
  _resolveFeatureFromPlan: resolveFeatureFromPlan,
  _LEGACY_LIMIT_TO_KEY: LEGACY_LIMIT_TO_KEY,
  _LEGACY_USAGE_TO_KEY: LEGACY_USAGE_TO_KEY
};
