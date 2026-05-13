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
  VOICE_IVR_ENABLED: 'voice.ivr.enabled'
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
    description: 'Credits consumed each time the AI sends an automated reply.',
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
    description: 'Credits consumed each time the AI helps generate a post.',
    category: 'limits',
    kind: 'limit',
    defaultValue: -1,
    unit: 'credits',
    resetPeriod: 'monthly',
    sortOrder: 60
  },
  {
    key: FEATURE_KEYS.CREDITS_AI_GENERAL,
    label: 'General AI credits / month',
    description: 'Catch-all bucket for AI ops not covered by post or auto-reply (KB, summaries).',
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
    label: 'AI variants per generation',
    description: 'How many alternative drafts AI can generate at once.',
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
    label: 'Auto-reply (AI) enabled',
    description: 'Master switch for the AI auto-reply feature.',
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
    label: 'AI agents (multi-agent flows)',
    category: 'automation',
    kind: 'boolean',
    defaultValue: true,
    sortOrder: 20
  },

  // ── Voice IVR ─────────────────────────────────────────────────────────────
  {
    key: FEATURE_KEYS.VOICE_IVR_ENABLED,
    label: 'AI Voice IVR',
    description: 'AI phone calling, voice agents, and call analytics for automation teams.',
    category: 'automation',
    kind: 'boolean',
    defaultValue: true,
    sortOrder: 30
  }
];

const BUCKET_KEYS = CATALOG
  .filter((c) => c.kind === 'limit' && c.resetPeriod && c.resetPeriod !== 'none')
  .map((c) => c.key);

const CATALOG_BY_KEY = Object.freeze(
  CATALOG.reduce((acc, row) => {
    acc[row.key] = Object.freeze(row);
    return acc;
  }, {})
);

module.exports = {
  FEATURE_KEYS,
  CATALOG,
  CATALOG_BY_KEY,
  BUCKET_KEYS
};
