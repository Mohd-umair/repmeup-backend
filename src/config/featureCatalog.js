/**
 * Canonical feature catalog (code-defined, DB-seeded).
 *
 * Everything this module exports is the source of truth for:
 *   - what feature keys exist,
 *   - what kind of value each one stores,
 *   - what defaults a plan inherits when it does not specify a value,
 *   - which keys are monthly-reset usage buckets.
 *
 * Used by:
 *   - backend/scripts/seedFeatures.js          - upserts into the DB
 *   - backend/src/services/entitlementsService - resolves values when a plan key is missing
 *   - backend/src/services/bucketService       - knows which buckets need monthly reset
 *   - frontend (via /api/entitlements + /api/super-admin/features)
 *
 * Adding a new feature:
 *   1. Append one entry below.
 *   2. Re-run `node backend/scripts/seedFeatures.js`.
 *   3. Wire enforcement in code (a single `entitlements.assert(orgId, KEY)` call).
 *   4. The admin Plans page picks up the row automatically.
 */

const FEATURE_KEYS = Object.freeze({
  // ── Limits / users ────────────────────────────────────────────────────────
  USERS_MAX: 'users.max',
  ACCOUNTS_MAX: 'accounts.max',
  STORAGE_GB: 'storage.gb',
  API_CALLS_DAILY: 'api.calls.daily',

  // ── Credit buckets (monthly reset, deducted per operation) ────────────────
  CREDITS_AUTO_REPLY: 'credits.autoReply.monthly',
  CREDITS_POST_CREATION: 'credits.postCreation.monthly',
  CREDITS_AI_GENERAL: 'credits.ai.monthly',

  // ── Inbox ─────────────────────────────────────────────────────────────────
  INBOX_UNIQUE_CONTACTS: 'inbox.uniqueContacts.monthly',
  INBOX_MESSAGE_SUGGESTIONS: 'inbox.messageSuggestions.enabled',
  INBOX_BUCKET_CHAT: 'inbox.bucket.chat',
  INBOX_BUCKET_CREATE: 'inbox.bucket.create',

  // ── Knowledge base ────────────────────────────────────────────────────────
  KB_ENTRIES_MAX: 'kb.entries.max',
  KB_UPLOAD_URL: 'kb.upload.url',
  KB_UPLOAD_PDF: 'kb.upload.pdf',

  // ── Posts / publishing ────────────────────────────────────────────────────
  POSTS_PER_MONTH: 'posts.perMonth',
  POSTS_PLATFORMS_MAX: 'posts.platforms.maxPerPost',
  POSTS_AI_VARIANTS_MAX: 'posts.ai.variants.max',
  POSTS_TRENDS: 'posts.trends',
  POSTS_LOGO: 'posts.logo',
  POSTS_SAVE_DRAFT: 'posts.saveDraft',

  // ── Automation / analytics / agents ───────────────────────────────────────
  AUTO_REPLY_ENABLED: 'automation.autoReply.enabled',
  ANALYTICS_ADVANCED: 'analytics.advanced',
  AGENTS_ENABLED: 'agents.enabled',

  // ── Voice IVR ─────────────────────────────────────────────────────────────
  VOICE_IVR_ENABLED: 'voice.ivr.enabled',

  // ── Commerce (catalog + orders + AI selling) ──────────────────────────────
  COMMERCE_PRODUCTS_MAX: 'commerce.products.max',
  COMMERCE_WA_CATALOG_ENABLED: 'commerce.whatsappCatalog.enabled',
  COMMERCE_AI_ASSIST_ENABLED: 'commerce.aiAssist.enabled',
  COMMERCE_AUTONOMOUS_AGENT: 'commerce.autonomousAgent.enabled',

  // ── Campaigns & WhatsApp broadcast ────────────────────────────────────────
  CAMPAIGNS_ENABLED: 'campaigns.enabled',
  CAMPAIGNS_RECIPIENTS_MONTHLY: 'campaigns.recipients.monthly',
  WHATSAPP_TEMPLATES_MAX: 'whatsapp.templates.max',
  WHATSAPP_BROADCAST_ENABLED: 'whatsapp.broadcast.enabled',
  AUTOMATION_FLOWS_MAX: 'automation.flows.max',
  CONTACTS_MAX: 'contacts.max'
});

/**
 * Canonical catalog rows.
 *
 * `defaultValue` is the value used when a plan does NOT have an entry for the key.
 * For boolean: explicit true/false.
 * For limit:   -1 (= unlimited) is intentional; we want missing keys to fail OPEN
 *              for legacy plans rather than break the app on first deploy.
 *              The Free plan seed (seedPlans.js) overrides with concrete numbers.
 */
const CATALOG = [
  // ── Limits ─────────────────────────────────────────────────────────────────
  {
    key: FEATURE_KEYS.USERS_MAX,
    label: 'Maximum users',
    description: 'Total users that can belong to the organization.',
    category: 'limits',
    kind: 'limit',
    defaultValue: -1,
    unit: 'count',
    sortOrder: 10
  },
  {
    key: FEATURE_KEYS.ACCOUNTS_MAX,
    label: 'Connected social accounts',
    description: 'Maximum platform connections (Instagram, Facebook, Google, …).',
    category: 'limits',
    kind: 'limit',
    defaultValue: -1,
    unit: 'count',
    sortOrder: 20
  },
  {
    key: FEATURE_KEYS.STORAGE_GB,
    label: 'Media storage (GB)',
    category: 'limits',
    kind: 'limit',
    defaultValue: -1,
    unit: 'gb',
    sortOrder: 30
  },
  {
    key: FEATURE_KEYS.API_CALLS_DAILY,
    label: 'Daily API call ceiling',
    category: 'limits',
    kind: 'limit',
    defaultValue: -1,
    unit: 'calls',
    resetPeriod: 'daily',
    sortOrder: 40
  },

  // ── Credit buckets ────────────────────────────────────────────────────────
  {
    key: FEATURE_KEYS.CREDITS_AUTO_REPLY,
    label: 'Auto-reply credits / month',
    description: 'Credits consumed each time Reppy sends an automated reply.',
    category: 'limits',
    kind: 'limit',
    defaultValue: -1,
    unit: 'credits',
    resetPeriod: 'monthly',
    sortOrder: 50
  },
  {
    key: FEATURE_KEYS.CREDITS_POST_CREATION,
    label: 'Post creation credits / month',
    description: 'Credits consumed each time Reppy helps generate a post.',
    category: 'limits',
    kind: 'limit',
    defaultValue: -1,
    unit: 'credits',
    resetPeriod: 'monthly',
    sortOrder: 60
  },
  {
    key: FEATURE_KEYS.CREDITS_AI_GENERAL,
    label: 'General Reppy credits / month',
    description: 'Catch-all bucket for Reppy AI ops not covered by post or auto-reply (KB, summaries).',
    category: 'limits',
    kind: 'limit',
    defaultValue: -1,
    unit: 'credits',
    resetPeriod: 'monthly',
    sortOrder: 70
  },

  // ── Inbox ─────────────────────────────────────────────────────────────────
  {
    key: FEATURE_KEYS.INBOX_UNIQUE_CONTACTS,
    label: 'Unique contacts / month',
    description: 'How many distinct people can be talked to in a billing period.',
    category: 'inbox',
    kind: 'limit',
    defaultValue: -1,
    unit: 'contacts',
    resetPeriod: 'monthly',
    sortOrder: 10
  },

  {   
    key: FEATURE_KEYS.INBOX_MESSAGE_SUGGESTIONS,
    label: 'Message suggestions',
    description: 'Enable message suggestions in the inbox.',
    category: 'inbox',
    kind: 'boolean',
    defaultValue: true,
    sortOrder: 15
  },
  {
    key: FEATURE_KEYS.INBOX_BUCKET_CHAT,
    label: 'Chat from bucket view',
    description: 'Allow replying directly from Inbox bucket view.',
    category: 'inbox',
    kind: 'boolean',
    defaultValue: true,
    sortOrder: 20
  },
  {
    key: FEATURE_KEYS.INBOX_BUCKET_CREATE,
    label: 'Create custom buckets',
    description: 'Allow the org to define new intent buckets.',
    category: 'inbox',
    kind: 'boolean',
    defaultValue: true,
    sortOrder: 30
  },

  // ── Knowledge base ────────────────────────────────────────────────────────
  {
    key: FEATURE_KEYS.KB_ENTRIES_MAX,
    label: 'Knowledge base entries',
    description: 'Maximum saved entries (manual + PDF + URL combined).',
    category: 'kb',
    kind: 'limit',
    defaultValue: -1,
    unit: 'count',
    sortOrder: 10
  },
  {
    key: FEATURE_KEYS.KB_UPLOAD_URL,
    label: 'Add KB entries from URL',
    description: 'Enable the URL ingestion option in the KB create form.',
    category: 'kb',
    kind: 'boolean',
    defaultValue: true,
    sortOrder: 20
  },
  {
    key: FEATURE_KEYS.KB_UPLOAD_PDF,
    label: 'Add KB entries from PDF',
    description: 'Enable the PDF upload option in the KB create form.',
    category: 'kb',
    kind: 'boolean',
    defaultValue: true,
    sortOrder: 30
  },

  // ── Posts / publishing ────────────────────────────────────────────────────
  {
    key: FEATURE_KEYS.POSTS_PER_MONTH,
    label: 'Posts published / month',
    category: 'posts',
    kind: 'limit',
    defaultValue: -1,
    unit: 'count',
    resetPeriod: 'monthly',
    sortOrder: 5
  },
  {
    key: FEATURE_KEYS.POSTS_PLATFORMS_MAX,
    label: 'Platforms per post',
    description: 'Maximum platforms a single post can be published to.',
    category: 'posts',
    kind: 'limit',
    defaultValue: -1,
    unit: 'count',
    sortOrder: 10
  },
  {
    key: FEATURE_KEYS.POSTS_AI_VARIANTS_MAX,
    label: 'Reppy AI variants per generation',
    description: 'How many alternative drafts Reppy can generate at once.',
    category: 'posts',
    kind: 'limit',
    defaultValue: -1,
    unit: 'count',
    sortOrder: 20
  },
  {
    key: FEATURE_KEYS.POSTS_TRENDS,
    label: 'Trends explorer',
    description: 'Show the trending topics panel inside Content Studio.',
    category: 'posts',
    kind: 'boolean',
    defaultValue: true,
    sortOrder: 30
  },
  {
    key: FEATURE_KEYS.POSTS_LOGO,
    label: 'Add brand logo to posts',
    category: 'posts',
    kind: 'boolean',
    defaultValue: true,
    sortOrder: 40
  },
  {
    key: FEATURE_KEYS.POSTS_SAVE_DRAFT,
    label: 'Save post as draft',
    category: 'posts',
    kind: 'boolean',
    defaultValue: true,
    sortOrder: 50
  },

  // ── Automation / analytics / agents ───────────────────────────────────────
  {
    key: FEATURE_KEYS.AUTO_REPLY_ENABLED,
    label: 'Auto-reply (Reppy AI) enabled',
    description: 'Master switch for the Reppy AI auto-reply feature.',
    category: 'automation',
    kind: 'boolean',
    defaultValue: true,
    sortOrder: 10
  },
  {
    key: FEATURE_KEYS.ANALYTICS_ADVANCED,
    label: 'Advanced analytics',
    description: 'Cohorts, time-series exports, agent performance.',
    category: 'analytics',
    kind: 'boolean',
    defaultValue: true,
    sortOrder: 10
  },
  {
    key: FEATURE_KEYS.AGENTS_ENABLED,
    label: 'Reppy AI agents (multi-agent flows)',
    category: 'automation',
    kind: 'boolean',
    defaultValue: true,
    sortOrder: 20
  },

  // ── Voice IVR ─────────────────────────────────────────────────────────────
  {
    key: FEATURE_KEYS.VOICE_IVR_ENABLED,
    label: 'Reppy AI Voice IVR',
    description: 'Reppy AI phone calling, voice agents, and call analytics for automation teams.',
    category: 'automation',
    kind: 'boolean',
    defaultValue: true,
    sortOrder: 30
  },

  // ── Commerce ──────────────────────────────────────────────────────────────
  {
    key: FEATURE_KEYS.COMMERCE_PRODUCTS_MAX,
    label: 'Max products in catalog',
    description: 'Total active products the organization can maintain.',
    category: 'commerce',
    kind: 'limit',
    defaultValue: -1,
    unit: 'count',
    sortOrder: 10
  },
  {
    key: FEATURE_KEYS.COMMERCE_WA_CATALOG_ENABLED,
    label: 'WhatsApp Catalog',
    description: 'Enable WhatsApp Commerce Catalog sync, product cards, and cart orders.',
    category: 'commerce',
    kind: 'boolean',
    defaultValue: true,
    sortOrder: 20
  },
  {
    key: FEATURE_KEYS.COMMERCE_AI_ASSIST_ENABLED,
    label: 'Reppy AI Commerce Assist',
    description: 'Reppy-powered product suggestions and sales replies in the inbox.',
    category: 'commerce',
    kind: 'boolean',
    defaultValue: true,
    sortOrder: 30
  },
  {
    key: FEATURE_KEYS.COMMERCE_AUTONOMOUS_AGENT,
    label: 'Autonomous Reppy AI Sales Agent',
    description: 'Allow Reppy to auto-send product messages and handle sales without agent intervention.',
    category: 'commerce',
    kind: 'boolean',
    defaultValue: false,
    sortOrder: 40
  },

  // ── Campaigns ─────────────────────────────────────────────────────────────
  {
    key: FEATURE_KEYS.CAMPAIGNS_ENABLED,
    label: 'WhatsApp campaigns',
    description: 'Master switch for WhatsApp template campaign module.',
    category: 'campaigns',
    kind: 'boolean',
    defaultValue: true,
    sortOrder: 10
  },
  {
    key: FEATURE_KEYS.CAMPAIGNS_RECIPIENTS_MONTHLY,
    label: 'Campaign recipients / month',
    description: 'Maximum WhatsApp template messages sent via campaigns per billing month.',
    category: 'campaigns',
    kind: 'limit',
    defaultValue: -1,
    unit: 'recipients',
    resetPeriod: 'monthly',
    sortOrder: 20
  },
  {
    key: FEATURE_KEYS.WHATSAPP_BROADCAST_ENABLED,
    label: 'Bulk template broadcast',
    description: 'Allow launching bulk WhatsApp template campaigns.',
    category: 'campaigns',
    kind: 'boolean',
    defaultValue: true,
    sortOrder: 30
  },

  // ── Integrations (WhatsApp templates, flows, CRM) ─────────────────────────
  {
    key: FEATURE_KEYS.WHATSAPP_TEMPLATES_MAX,
    label: 'Approved WA templates stored',
    description: 'Maximum WhatsApp message templates synced/stored for the org.',
    category: 'integrations',
    kind: 'limit',
    defaultValue: -1,
    unit: 'count',
    sortOrder: 10
  },
  {
    key: FEATURE_KEYS.AUTOMATION_FLOWS_MAX,
    label: 'WhatsApp automation flows',
    description: 'Maximum active WhatsApp automation flows.',
    category: 'integrations',
    kind: 'limit',
    defaultValue: -1,
    unit: 'count',
    sortOrder: 20
  },
  {
    key: FEATURE_KEYS.CONTACTS_MAX,
    label: 'CRM contacts stored',
    description: 'Maximum contacts stored in the CRM.',
    category: 'integrations',
    kind: 'limit',
    defaultValue: -1,
    unit: 'count',
    sortOrder: 30
  }
];

const BUCKET_KEYS = CATALOG
  .filter((c) => c.kind === 'limit' && c.resetPeriod && c.resetPeriod !== 'none')
  .map((c) => c.key);

/** Keys with backend assert/consume/requireFeature wired — shown in admin as "enforced". */
const ENFORCED_FEATURE_KEYS = new Set([
  FEATURE_KEYS.USERS_MAX,
  FEATURE_KEYS.ACCOUNTS_MAX,
  FEATURE_KEYS.STORAGE_GB,
  FEATURE_KEYS.CREDITS_AUTO_REPLY,
  FEATURE_KEYS.CREDITS_POST_CREATION,
  FEATURE_KEYS.CREDITS_AI_GENERAL,
  FEATURE_KEYS.INBOX_UNIQUE_CONTACTS,
  FEATURE_KEYS.INBOX_BUCKET_CREATE,
  FEATURE_KEYS.KB_ENTRIES_MAX,
  FEATURE_KEYS.KB_UPLOAD_URL,
  FEATURE_KEYS.KB_UPLOAD_PDF,
  FEATURE_KEYS.POSTS_PER_MONTH,
  FEATURE_KEYS.POSTS_PLATFORMS_MAX,
  FEATURE_KEYS.POSTS_AI_VARIANTS_MAX,
  FEATURE_KEYS.POSTS_TRENDS,
  FEATURE_KEYS.POSTS_SAVE_DRAFT,
  FEATURE_KEYS.AUTO_REPLY_ENABLED,
  FEATURE_KEYS.ANALYTICS_ADVANCED,
  FEATURE_KEYS.AGENTS_ENABLED,
  FEATURE_KEYS.VOICE_IVR_ENABLED,
  FEATURE_KEYS.COMMERCE_PRODUCTS_MAX,
  FEATURE_KEYS.COMMERCE_WA_CATALOG_ENABLED,
  FEATURE_KEYS.CAMPAIGNS_ENABLED,
  FEATURE_KEYS.CAMPAIGNS_RECIPIENTS_MONTHLY,
  FEATURE_KEYS.WHATSAPP_BROADCAST_ENABLED,
  FEATURE_KEYS.WHATSAPP_TEMPLATES_MAX,
  FEATURE_KEYS.AUTOMATION_FLOWS_MAX,
  FEATURE_KEYS.CONTACTS_MAX
]);

const CATALOG_BY_KEY = Object.freeze(
  CATALOG.reduce((acc, row) => {
    if (!row?.key) {
      throw new Error(`Feature catalog row missing "key": ${JSON.stringify(row)}`);
    }
    acc[row.key] = Object.freeze(row);
    return acc;
  }, {})
);

/** Case-insensitive lookup — Feature model historically lowercased dotted keys in MongoDB. */
const CATALOG_BY_LOWER_KEY = Object.freeze(
  CATALOG.reduce((acc, row) => {
    if (!row?.key) return acc;
    const lower = row.key.toLowerCase();
    acc[lower] = acc[lower] || row;
    return acc;
  }, {})
);

const ENFORCED_FEATURE_KEYS_LOWER = Object.freeze(
  new Set([...ENFORCED_FEATURE_KEYS].map((k) => k.toLowerCase()))
);

function normalizeFeatureKeyForLookup(key) {
  return String(key || '').toLowerCase();
}

function isEnforcedFeatureKey(key) {
  return ENFORCED_FEATURE_KEYS_LOWER.has(normalizeFeatureKeyForLookup(key));
}

function resolveCatalogEntry(featureKey) {
  if (!featureKey) return null;
  return CATALOG_BY_KEY[featureKey] || CATALOG_BY_LOWER_KEY[normalizeFeatureKeyForLookup(featureKey)] || null;
}

module.exports = {
  FEATURE_KEYS,
  CATALOG,
  CATALOG_BY_KEY,
  CATALOG_BY_LOWER_KEY,
  BUCKET_KEYS,
  ENFORCED_FEATURE_KEYS,
  ENFORCED_FEATURE_KEYS_LOWER,
  normalizeFeatureKeyForLookup,
  isEnforcedFeatureKey,
  resolveCatalogEntry
};
