/**
 * Canonical entitlement maps for the 2026 pricing sheet (Starter / Growth / Pro).
 *
 * Every key is listed explicitly on every tier — no inheritance by spread. With the
 * new keys defaulting fail-closed, an omitted key silently becomes "off", and the
 * difference between "deliberately off" and "forgotten" would be invisible. Listing
 * everything makes the diff against the sheet reviewable line by line.
 *
 * Values come straight off the published sheet. Where the sheet says "Unlimited"
 * the value is -1.
 *
 * Used by scripts/seedPricingSheetPlans.js.
 */

const { FEATURE_KEYS: K } = require('../src/config/featureCatalog');

const ALL_CHANNELS = ['instagram', 'whatsapp', 'youtube', 'facebook'];
/** What Starter buys, per the sheet — and the ceiling for the unpaid tier. */
const STARTER_CHANNELS = ['instagram', 'whatsapp'];

/** Everything the three paid tiers share. */
const COMMON_2026 = {
  [K.BRANDING_REMOVED]: { enabled: true },

  // Automations are unlimited on every tier; the differentiator is AI decisioning.
  [K.AUTOMATION_FLOWS_MAX]: { limit: -1 },

  // "Social management (AI-powered replies, DMs & comments) — Included" on all tiers.
  [K.AUTO_REPLY_ENABLED]: { enabled: true },
  [K.CAMPAIGNS_ENABLED]: { enabled: true },
  [K.WHATSAPP_BROADCAST_ENABLED]: { enabled: true },

  // The conversation meter replaces the per-reply throttle on paid tiers. Leaving a
  // finite number here would create a second, invisible gate that contradicts the sheet.
  [K.CREDITS_AUTO_REPLY]: { limit: -1 },

  // Not on the sheet, but must not fail closed for paying customers.
  [K.INBOX_MESSAGE_SUGGESTIONS]: { enabled: true },
  [K.INBOX_BUCKET_CHAT]: { enabled: true },
  [K.INBOX_BUCKET_CREATE]: { enabled: true },
  [K.KB_UPLOAD_URL]: { enabled: true },
  [K.KB_UPLOAD_PDF]: { enabled: true },
  [K.POSTS_TRENDS]: { enabled: true },
  [K.POSTS_LOGO]: { enabled: true },
  [K.POSTS_SAVE_DRAFT]: { enabled: true }
};

const STARTER_2026 = {
  ...COMMON_2026,
  [K.USERS_MAX]: { limit: 2 },
  [K.CONTACTS_MAX]: { limit: 2000 },
  [K.CREDITS_AI_CONVERSATIONS]: { limit: 500 },
  [K.CAMPAIGNS_RECIPIENTS_MONTHLY]: { limit: 5000 },
  [K.CHANNELS_ALLOWED]: { value: ['instagram', 'whatsapp'] },

  [K.INBOX_INTENT_BUCKET_ENABLED]: { enabled: false },
  [K.AUTOMATION_AI_DECISIONING]: { enabled: false },
  [K.POSTS_AI_ENABLED]: { enabled: false },
  [K.POSTS_PUBLISHING_LEVEL]: { value: 'basic' },
  [K.INBOX_COLLABORATION_LEVEL]: { value: 'labels' },
  [K.RBAC_LEVEL]: { value: 'single' },
  [K.COMMERCE_ORDERS_LEVEL]: { value: 'none' },
  [K.SUPPORT_COMPLAINTS_LEVEL]: { value: 'none' },
  [K.SUPPORT_LEVEL]: { value: 'email' },
  [K.FLOW_BUILDER_ENABLED]: { enabled: false },
  [K.FLOW_BUILDER_AI_ENABLED]: { enabled: false },

  // Supporting limits not itemised on the sheet — sized to the tier.
  [K.ACCOUNTS_MAX]: { limit: 5 },
  [K.STORAGE_GB]: { limit: 5 },
  [K.CREDITS_AI_GENERAL]: { limit: 500 },
  [K.CREDITS_POST_CREATION]: { limit: 100 },
  [K.POSTS_PER_MONTH]: { limit: -1 },
  [K.POSTS_PLATFORMS_MAX]: { limit: 2 },
  [K.POSTS_AI_VARIANTS_MAX]: { limit: 4 },
  [K.KB_ENTRIES_MAX]: { limit: 50 },
  [K.INBOX_UNIQUE_CONTACTS]: { limit: -1 },
  [K.COMMERCE_PRODUCTS_MAX]: { limit: 50 },
  [K.WHATSAPP_TEMPLATES_MAX]: { limit: 20 },
  [K.COMMERCE_WA_CATALOG_ENABLED]: { enabled: false },
  [K.COMMERCE_AI_ASSIST_ENABLED]: { enabled: false },
  [K.COMMERCE_AUTONOMOUS_AGENT]: { enabled: false },
  [K.ANALYTICS_ADVANCED]: { enabled: false },
  [K.AGENTS_ENABLED]: { enabled: true },
  [K.VOICE_IVR_ENABLED]: { enabled: false }
};

const GROWTH_2026 = {
  ...COMMON_2026,
  [K.USERS_MAX]: { limit: 8 },
  [K.CONTACTS_MAX]: { limit: 10000 },
  [K.CREDITS_AI_CONVERSATIONS]: { limit: 2500 },
  [K.CAMPAIGNS_RECIPIENTS_MONTHLY]: { limit: 20000 },
  [K.CHANNELS_ALLOWED]: { value: [...ALL_CHANNELS] },

  [K.INBOX_INTENT_BUCKET_ENABLED]: { enabled: true },
  [K.AUTOMATION_AI_DECISIONING]: { enabled: true },
  [K.POSTS_AI_ENABLED]: { enabled: true },
  [K.POSTS_PUBLISHING_LEVEL]: { value: 'full' },
  [K.INBOX_COLLABORATION_LEVEL]: { value: 'shared' },
  [K.RBAC_LEVEL]: { value: 'roles' },
  [K.COMMERCE_ORDERS_LEVEL]: { value: 'basic' },
  [K.SUPPORT_COMPLAINTS_LEVEL]: { value: 'basic' },
  [K.SUPPORT_LEVEL]: { value: 'priority' },
  // Flow Builder is a ₹1,999 add-on here — but when bought it IS AI-powered,
  // because the AI capability is granted by the plan, not by the add-on.
  [K.FLOW_BUILDER_ENABLED]: { enabled: false },
  [K.FLOW_BUILDER_AI_ENABLED]: { enabled: true },

  [K.ACCOUNTS_MAX]: { limit: 20 },
  [K.STORAGE_GB]: { limit: 20 },
  [K.CREDITS_AI_GENERAL]: { limit: 5000 },
  [K.CREDITS_POST_CREATION]: { limit: 500 },
  [K.POSTS_PER_MONTH]: { limit: -1 },
  [K.POSTS_PLATFORMS_MAX]: { limit: 4 },
  [K.POSTS_AI_VARIANTS_MAX]: { limit: 8 },
  [K.KB_ENTRIES_MAX]: { limit: -1 },
  [K.INBOX_UNIQUE_CONTACTS]: { limit: -1 },
  [K.COMMERCE_PRODUCTS_MAX]: { limit: -1 },
  [K.WHATSAPP_TEMPLATES_MAX]: { limit: -1 },
  [K.COMMERCE_WA_CATALOG_ENABLED]: { enabled: true },
  [K.COMMERCE_AI_ASSIST_ENABLED]: { enabled: true },
  [K.COMMERCE_AUTONOMOUS_AGENT]: { enabled: false },
  [K.ANALYTICS_ADVANCED]: { enabled: true },
  [K.AGENTS_ENABLED]: { enabled: true },
  [K.VOICE_IVR_ENABLED]: { enabled: false }
};

const PRO_MAX_2026 = {
  ...COMMON_2026,
  [K.USERS_MAX]: { limit: 20 },
  [K.CONTACTS_MAX]: { limit: 50000 },
  [K.CREDITS_AI_CONVERSATIONS]: { limit: 8000 },
  [K.CAMPAIGNS_RECIPIENTS_MONTHLY]: { limit: -1 },   // "Unlimited broadcasts"
  [K.CHANNELS_ALLOWED]: { value: [...ALL_CHANNELS] },

  [K.INBOX_INTENT_BUCKET_ENABLED]: { enabled: true },
  [K.AUTOMATION_AI_DECISIONING]: { enabled: true },
  [K.POSTS_AI_ENABLED]: { enabled: true },
  [K.POSTS_PUBLISHING_LEVEL]: { value: 'full' },
  [K.INBOX_COLLABORATION_LEVEL]: { value: 'shared' },
  [K.RBAC_LEVEL]: { value: 'advanced' },
  [K.COMMERCE_ORDERS_LEVEL]: { value: 'full' },
  [K.SUPPORT_COMPLAINTS_LEVEL]: { value: 'advanced' },
  [K.SUPPORT_LEVEL]: { value: 'dedicated' },
  [K.FLOW_BUILDER_ENABLED]: { enabled: true },       // "Included free"
  [K.FLOW_BUILDER_AI_ENABLED]: { enabled: true },

  [K.ACCOUNTS_MAX]: { limit: -1 },
  [K.STORAGE_GB]: { limit: 100 },
  [K.CREDITS_AI_GENERAL]: { limit: 20000 },
  [K.CREDITS_POST_CREATION]: { limit: 2000 },
  [K.POSTS_PER_MONTH]: { limit: -1 },
  [K.POSTS_PLATFORMS_MAX]: { limit: -1 },
  [K.POSTS_AI_VARIANTS_MAX]: { limit: 10 },
  [K.KB_ENTRIES_MAX]: { limit: -1 },
  [K.INBOX_UNIQUE_CONTACTS]: { limit: -1 },
  [K.COMMERCE_PRODUCTS_MAX]: { limit: -1 },
  [K.WHATSAPP_TEMPLATES_MAX]: { limit: -1 },
  [K.COMMERCE_WA_CATALOG_ENABLED]: { enabled: true },
  [K.COMMERCE_AI_ASSIST_ENABLED]: { enabled: true },
  [K.COMMERCE_AUTONOMOUS_AGENT]: { enabled: true },
  [K.ANALYTICS_ADVANCED]: { enabled: true },
  [K.AGENTS_ENABLED]: { enabled: true },
  [K.VOICE_IVR_ENABLED]: { enabled: true }
};

/**
 * Patch applied to the off-sheet `free` plan: only the NEW keys, so the rest of the
 * free tier is untouched.
 *
 * `channels.allowed` is the one that must NOT fail closed — 13 live orgs already have
 * platform connections, and an empty list would cut them off the moment enforcement
 * lands. Tightening free to fewer channels is a separate product decision.
 */
const FREE_PATCH_2026 = {
  /**
   * The unpaid tier must never out-rank a paying one.
   *
   * Free briefly carried all four channels (preserved so existing connections would not
   * break when the keys were introduced) while Starter — at ₹1,499/mo — carried two.
   * Once `channels.allowed` became enforced, that gap was visible: a free user could
   * connect YouTube and a paying customer could not. Free is capped at Starter's set.
   *
   * This is safe for the 13 live free orgs because the gate is on CONNECT only —
   * anything already connected keeps working; only new connections are refused.
   */
  [K.CHANNELS_ALLOWED]: { value: [...STARTER_CHANNELS] },
  [K.CREDITS_AI_CONVERSATIONS]: { limit: 50 },
  [K.BRANDING_REMOVED]: { enabled: false },
  /**
   * Explicit `false`, not left to the catalog default.
   *
   * `commerce.aiAssist.enabled` is one of the original fail-OPEN keys, so an absent
   * value resolves to true — which is how free ended up with Commerce Assist while
   * Starter had an explicit false. Stating it removes the accident.
   */
  [K.COMMERCE_AI_ASSIST_ENABLED]: { enabled: false },
  [K.INBOX_INTENT_BUCKET_ENABLED]: { enabled: false },
  [K.AUTOMATION_AI_DECISIONING]: { enabled: false },
  [K.POSTS_AI_ENABLED]: { enabled: false },
  [K.POSTS_PUBLISHING_LEVEL]: { value: 'basic' },
  [K.INBOX_COLLABORATION_LEVEL]: { value: 'labels' },
  [K.RBAC_LEVEL]: { value: 'single' },
  [K.COMMERCE_ORDERS_LEVEL]: { value: 'none' },
  [K.SUPPORT_COMPLAINTS_LEVEL]: { value: 'none' },
  [K.SUPPORT_LEVEL]: { value: 'email' },
  [K.FLOW_BUILDER_ENABLED]: { enabled: false },
  [K.FLOW_BUILDER_AI_ENABLED]: { enabled: false }
};

/** Card copy, straight from the sheet. */
const PLAN_MARKETING_2026 = {
  starter: {
    tagline: 'For brands running their first real AI-led conversations.',
    badge: 'LIMITED OFFER',
    cardStyle: 'light',
    annualOfferLabel: 'Save 67% — offer price, billed annually',
    headlineMetricKeys: [K.CREDITS_AI_CONVERSATIONS, K.USERS_MAX, K.CONTACTS_MAX],
    entitlementNotes: { [K.USERS_MAX]: 'Simultaneous login allowed' },
    cardBullets: [
      { label: 'Instagram + WhatsApp channels', included: true, featureKey: K.CHANNELS_ALLOWED },
      { label: 'Unified Inbox across every channel', included: true, featureKey: K.INBOX_COLLABORATION_LEVEL },
      { label: 'Unlimited automations', included: true, featureKey: K.AUTOMATION_FLOWS_MAX },
      { label: 'Basic Publish & scheduling', included: true, featureKey: K.POSTS_PUBLISHING_LEVEL },
      { label: 'Intent Bucket', included: false, featureKey: K.INBOX_INTENT_BUCKET_ENABLED },
      { label: 'Order, Ecommerce & Complaint management', included: false, featureKey: K.COMMERCE_ORDERS_LEVEL }
    ]
  },
  growth: {
    tagline: 'For teams scaling acquisition and post-sale together.',
    badge: 'MOST POPULAR',
    cardStyle: 'dark',
    inheritsFromPlanId: 'starter',
    headlineMetricKeys: [K.CREDITS_AI_CONVERSATIONS, K.USERS_MAX, K.CONTACTS_MAX],
    cardBullets: [
      { label: 'Intent Bucket', included: true, featureKey: K.INBOX_INTENT_BUCKET_ENABLED },
      { label: 'AI-generated post content', included: true, featureKey: K.POSTS_AI_ENABLED },
      { label: 'Order & Ecommerce management (Basic)', included: true, featureKey: K.COMMERCE_ORDERS_LEVEL },
      { label: 'Complaint management', included: true, featureKey: K.SUPPORT_COMPLAINTS_LEVEL },
      { label: 'Role-based access control', included: true, featureKey: K.RBAC_LEVEL },
      { label: 'Full Publish & scheduling', included: true, featureKey: K.POSTS_PUBLISHING_LEVEL },
      { label: 'Priority email support', included: true, featureKey: K.SUPPORT_LEVEL }
    ]
  },
  pro_max: {
    tagline: 'For established brands running commerce at volume.',
    cardStyle: 'light',
    inheritsFromPlanId: 'growth',
    headlineMetricKeys: [K.CREDITS_AI_CONVERSATIONS, K.USERS_MAX, K.CONTACTS_MAX],
    cardBullets: [
      { label: 'Order & Ecommerce management (Full)', included: true, featureKey: K.COMMERCE_ORDERS_LEVEL },
      { label: 'Unlimited broadcasts', included: true, featureKey: K.CAMPAIGNS_RECIPIENTS_MONTHLY },
      { label: 'Flow Builder (AI-powered) included', included: true, featureKey: K.FLOW_BUILDER_ENABLED },
      { label: 'Advanced roles + audit log', included: true, featureKey: K.RBAC_LEVEL },
      { label: 'Dedicated account manager', included: true, featureKey: K.SUPPORT_LEVEL }
    ]
  },
  enterprise: {
    tagline: 'Starts around ₹50,000/mo for high-volume operators.',
    cardStyle: 'light',
    headlineMetricKeys: [],
    cardBullets: [
      { label: 'Custom-priced around your volume', included: true },
      { label: 'Dedicated CSM', included: true },
      { label: 'Custom integrations', included: true },
      { label: 'SLA', included: true }
    ]
  }
};

module.exports = {
  ALL_CHANNELS,
  STARTER_2026,
  GROWTH_2026,
  PRO_MAX_2026,
  FREE_PATCH_2026,
  PLAN_MARKETING_2026
};
