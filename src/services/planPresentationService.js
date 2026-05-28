/**
 * Builds customer-facing plan cards from admin-configured entitlements.
 * Single place for pricing-page limits + feature bullets (processed on backend).
 */

const { CATALOG_BY_KEY, FEATURE_KEYS } = require('../config/featureCatalog');
const {
  resolvePlanFeature,
  buildLegacyLimitsFromPlan
} = require('./entitlementsService');

/** Limit rows shown on pricing / billing cards (order matters). */
const CARD_LIMIT_KEYS = [
  FEATURE_KEYS.ACCOUNTS_MAX,
  FEATURE_KEYS.USERS_MAX,
  FEATURE_KEYS.POSTS_PER_MONTH,
  FEATURE_KEYS.CREDITS_AUTO_REPLY,
  FEATURE_KEYS.CREDITS_AI_GENERAL,
  FEATURE_KEYS.STORAGE_GB,
  FEATURE_KEYS.INBOX_UNIQUE_CONTACTS,
  FEATURE_KEYS.CAMPAIGNS_RECIPIENTS_MONTHLY,
  FEATURE_KEYS.COMMERCE_PRODUCTS_MAX,
  FEATURE_KEYS.WHATSAPP_TEMPLATES_MAX
];

/** Boolean module bullets (only shown when enabled on the plan). */
const CARD_FEATURE_KEYS = [
  FEATURE_KEYS.CAMPAIGNS_ENABLED,
  FEATURE_KEYS.WHATSAPP_BROADCAST_ENABLED,
  FEATURE_KEYS.AUTO_REPLY_ENABLED,
  FEATURE_KEYS.ANALYTICS_ADVANCED,
  FEATURE_KEYS.COMMERCE_WA_CATALOG_ENABLED,
  FEATURE_KEYS.COMMERCE_AI_ASSIST_ENABLED,
  FEATURE_KEYS.AGENTS_ENABLED,
  FEATURE_KEYS.VOICE_IVR_ENABLED,
  FEATURE_KEYS.INBOX_BUCKET_CREATE,
  FEATURE_KEYS.INBOX_BUCKET_CHAT,
  FEATURE_KEYS.KB_UPLOAD_URL,
  FEATURE_KEYS.KB_UPLOAD_PDF,
  FEATURE_KEYS.POSTS_TRENDS,
  FEATURE_KEYS.POSTS_SAVE_DRAFT
];

function formatLimitDisplay(limit) {
  if (limit === -1) return 'Unlimited';
  if (typeof limit === 'number') return limit.toLocaleString('en-IN');
  return String(limit ?? '—');
}

function buildHighlight(plan, featureKey) {
  const catalogEntry = CATALOG_BY_KEY[featureKey];
  if (!catalogEntry || catalogEntry.kind !== 'limit') return null;
  const resolved = resolvePlanFeature(plan, featureKey);
  if (!resolved || resolved.source === 'default') return null;
  const limit = resolved?.limit;
  if (limit === undefined || limit === null) return null;
  return {
    key: featureKey,
    label: catalogEntry.label,
    value: formatLimitDisplay(limit),
    raw: limit,
    unit: catalogEntry.unit || null,
    resetPeriod: catalogEntry.resetPeriod || null
  };
}

function buildFeatureBullet(plan, featureKey) {
  const catalogEntry = CATALOG_BY_KEY[featureKey];
  if (!catalogEntry) return null;
  const resolved = resolvePlanFeature(plan, featureKey);
  if (catalogEntry.kind === 'boolean') {
    if (!resolved?.enabled || resolved.source === 'default') return null;
    return { key: featureKey, label: catalogEntry.label };
  }
  if (catalogEntry.kind === 'limit') {
    if (resolved?.source === 'default') return null;
    const limit = resolved?.limit;
    if (limit === undefined || limit === null || limit === 0) return null;
    return {
      key: featureKey,
      label: `${catalogEntry.label}: ${formatLimitDisplay(limit)}`
    };
  }
  return null;
}

/**
 * Public plan card payload for GET /api/plans and subscription/plans.
 */
function buildPublicPlanCard(plan) {
  const highlights = CARD_LIMIT_KEYS.map((key) => buildHighlight(plan, key)).filter(Boolean);
  const features = CARD_FEATURE_KEYS.map((key) => buildFeatureBullet(plan, key)).filter(Boolean);
  const limits = buildLegacyLimitsFromPlan(plan);

  return {
    name: plan.name,
    tier: plan.tier,
    price: plan.price,
    description: plan.description || null,
    limits,
    highlights,
    features,
    badge: plan.badge || null,
    badgeColor: plan.badgeColor || null,
    billingCycle: plan.billingCycle || 'monthly'
  };
}

module.exports = {
  buildPublicPlanCard,
  CARD_LIMIT_KEYS,
  CARD_FEATURE_KEYS
};
