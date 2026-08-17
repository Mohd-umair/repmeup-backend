/**
 * Canonical feature catalog (code-defined, DB-seeded).
 *
 * Everything this module exports is the source of truth for:
 *   - what feature keys exist,
 *   - what kind of value each one stores,
 *   - what defaults a plan inherits when it does not specify a value,
 *   - which keys are monthly-reset usage buckets,
 *   - how each row is classified on the public pricing sheet (AC / NAC).
 *
 * Used by:
 *   - backend/scripts/seedFeatures.js          - upserts into the DB
 *   - backend/src/services/entitlementsService - resolves values when a plan key is missing
 *   - backend/src/services/bucketService       - knows which buckets need monthly reset
 *   - backend/src/config/pricingSheetLayout    - builds the public comparison table
 *   - frontend (via /api/entitlements + /api/super-admin/features)
 *
 * Adding a new feature:
 *   1. Append one entry below, including `metering` AND `enforcement` — the reducer
 *      throws without either.
 *   2. Re-run `node backend/scripts/seedFeatures.js`.
 *   3. Wire the gate in code (`entitlements.assert` / `requireFeature` / `requireLevel`)
 *      and set `enforcement: 'code'` on the same row. If you cannot gate it yet, say so
 *      honestly with 'unbuilt' rather than shipping a value that does nothing silently.
 *   4. The admin Plans page picks up the row automatically.
 *
 * `metering` mirrors the published pricing sheet's legend:
 *   AC  = counted or credit-based — has a number that scales by plan, or is powered
 *         by an AI agent.
 *   NAC = not counted — a flat capability, present or absent, same mechanic
 *         regardless of tier or volume.
 * Every `kind: 'limit'` row is AC by definition; for booleans and enums the split is
 * "is an AI agent doing the work?" (AC) versus "is this just a switch?" (NAC).
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
  CREDITS_AI_CONVERSATIONS: 'credits.aiConversations.monthly',

  // ── Inbox ─────────────────────────────────────────────────────────────────
  INBOX_UNIQUE_CONTACTS: 'inbox.uniqueContacts.monthly',
  INBOX_MESSAGE_SUGGESTIONS: 'inbox.messageSuggestions.enabled',
  INBOX_BUCKET_CHAT: 'inbox.bucket.chat',
  INBOX_BUCKET_CREATE: 'inbox.bucket.create',
  INBOX_INTENT_BUCKET_ENABLED: 'inbox.intentBucket.enabled',
  INBOX_COLLABORATION_LEVEL: 'inbox.collaboration.level',

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
  POSTS_PUBLISHING_LEVEL: 'posts.publishing.level',
  POSTS_AI_ENABLED: 'posts.ai.enabled',

  // ── Automation / analytics / agents ───────────────────────────────────────
  AUTO_REPLY_ENABLED: 'automation.autoReply.enabled',
  ANALYTICS_ADVANCED: 'analytics.advanced',
  AGENTS_ENABLED: 'agents.enabled',
  AUTOMATION_AI_DECISIONING: 'automation.aiDecisioning.enabled',
  FLOW_BUILDER_ENABLED: 'flowBuilder.enabled',
  FLOW_BUILDER_AI_ENABLED: 'flowBuilder.ai.enabled',

  // ── Voice IVR ─────────────────────────────────────────────────────────────
  VOICE_IVR_ENABLED: 'voice.ivr.enabled',

  // ── Commerce (catalog + orders + AI selling) ──────────────────────────────
  COMMERCE_PRODUCTS_MAX: 'commerce.products.max',
  COMMERCE_WA_CATALOG_ENABLED: 'commerce.whatsappCatalog.enabled',
  COMMERCE_AI_ASSIST_ENABLED: 'commerce.aiAssist.enabled',
  COMMERCE_AUTONOMOUS_AGENT: 'commerce.autonomousAgent.enabled',
  COMMERCE_ORDERS_LEVEL: 'commerce.orders.level',
  SUPPORT_COMPLAINTS_LEVEL: 'support.complaints.level',

  // ── Campaigns & WhatsApp broadcast ────────────────────────────────────────
  CAMPAIGNS_ENABLED: 'campaigns.enabled',
  CAMPAIGNS_RECIPIENTS_MONTHLY: 'campaigns.recipients.monthly',
  WHATSAPP_TEMPLATES_MAX: 'whatsapp.templates.max',
  WHATSAPP_BROADCAST_ENABLED: 'whatsapp.broadcast.enabled',
  WHATSAPP_FLOWS_ENABLED: 'whatsapp.flows.enabled',
  WHATSAPP_FLOWS_MAX: 'whatsapp.flows.max',
  AUTOMATION_FLOWS_MAX: 'automation.flows.max',
  CONTACTS_MAX: 'contacts.max',
  CHANNELS_ALLOWED: 'channels.allowed',

  // ── Account-level / general ───────────────────────────────────────────────
  BRANDING_REMOVED: 'branding.removed',
  RBAC_LEVEL: 'rbac.level',
  SUPPORT_LEVEL: 'support.level'
});

/**
 * Canonical catalog rows.
 *
 * `defaultValue` is the value used when a plan does NOT have an entry for the key.
 *
 * Two generations of defaults live here, deliberately:
 *   - The original 34 keys default to -1 / true (fail OPEN). Changing them now would
 *     silently strip capability from live subscriptions, so they stay as they are.
 *   - Every key added for the 2026 pricing sheet defaults fail CLOSED (0 / false /
 *     lowest enum / empty list), so a plan that does not name the key does not get it.
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
    metering: 'AC',
    enforcement: 'code',
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
    metering: 'AC',
    enforcement: 'code',
    sortOrder: 20
  },
  {
    key: FEATURE_KEYS.STORAGE_GB,
    label: 'Media storage (GB)',
    category: 'limits',
    kind: 'limit',
    defaultValue: -1,
    unit: 'gb',
    metering: 'AC',
    enforcement: 'code',
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
    metering: 'AC',
    enforcement: 'unbuilt',
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
    metering: 'AC',
    enforcement: 'code',
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
    metering: 'AC',
    enforcement: 'code',
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
    metering: 'AC',
    enforcement: 'code',
    sortOrder: 70
  },
  {
    key: FEATURE_KEYS.CREDITS_AI_CONVERSATIONS,
    label: 'AI conversation credits / month',
    description:
      'The headline meter. One credit opens a 24-hour conversation window with a contact; '
      + 'every further AI reply to that contact inside the window is free.',
    category: 'limits',
    kind: 'limit',
    defaultValue: 0,
    unit: 'conversations',
    resetPeriod: 'monthly',
    metering: 'AC',
    enforcement: 'code',
    sortOrder: 5
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
    metering: 'AC',
    enforcement: 'code',
    sortOrder: 10
  },
  {
    key: FEATURE_KEYS.INBOX_MESSAGE_SUGGESTIONS,
    label: 'Message suggestions',
    description: 'Enable message suggestions in the inbox.',
    category: 'inbox',
    kind: 'boolean',
    defaultValue: true,
    metering: 'AC',
    enforcement: 'code',
    sortOrder: 15
  },
  {
    key: FEATURE_KEYS.INBOX_BUCKET_CHAT,
    label: 'Chat from bucket view',
    description: 'Allow replying directly from Inbox bucket view.',
    category: 'inbox',
    kind: 'boolean',
    defaultValue: true,
    metering: 'NAC',
    enforcement: 'code',
    sortOrder: 20
  },
  {
    key: FEATURE_KEYS.INBOX_BUCKET_CREATE,
    label: 'Create custom buckets',
    description: 'Allow the org to define new intent buckets.',
    category: 'inbox',
    kind: 'boolean',
    defaultValue: true,
    metering: 'NAC',
    enforcement: 'code',
    sortOrder: 30
  },
  {
    key: FEATURE_KEYS.INBOX_INTENT_BUCKET_ENABLED,
    label: 'Intent Bucket (AI-classified customer intent)',
    description: 'Reppy classifies every inbound message into an intent bucket for triage.',
    category: 'inbox',
    kind: 'boolean',
    defaultValue: false,
    metering: 'AC',
    enforcement: 'code',
    sortOrder: 35
  },
  {
    key: FEATURE_KEYS.INBOX_COLLABORATION_LEVEL,
    label: 'Unified Inbox capability',
    description: 'How much team collaboration the shared inbox supports.',
    category: 'inbox',
    kind: 'enum',
    defaultValue: 'labels',
    enumOptions: ['labels', 'shared'],
    metering: 'NAC',
    enforcement: 'code',
    sortOrder: 40
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
    metering: 'AC',
    enforcement: 'code',
    sortOrder: 10
  },
  {
    key: FEATURE_KEYS.KB_UPLOAD_URL,
    label: 'Add KB entries from URL',
    description: 'Enable the URL ingestion option in the KB create form.',
    category: 'kb',
    kind: 'boolean',
    defaultValue: true,
    metering: 'NAC',
    enforcement: 'code',
    sortOrder: 20
  },
  {
    key: FEATURE_KEYS.KB_UPLOAD_PDF,
    label: 'Add KB entries from PDF',
    description: 'Enable the PDF upload option in the KB create form.',
    category: 'kb',
    kind: 'boolean',
    defaultValue: true,
    metering: 'NAC',
    enforcement: 'code',
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
    metering: 'AC',
    enforcement: 'code',
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
    metering: 'AC',
    enforcement: 'code',
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
    metering: 'AC',
    enforcement: 'code',
    sortOrder: 20
  },
  {
    key: FEATURE_KEYS.POSTS_TRENDS,
    label: 'Trends explorer',
    description: 'Show the trending topics panel inside Content Studio.',
    category: 'posts',
    kind: 'boolean',
    defaultValue: true,
    metering: 'NAC',
    enforcement: 'code',
    sortOrder: 30
  },
  {
    key: FEATURE_KEYS.POSTS_LOGO,
    label: 'Add brand logo to posts',
    category: 'posts',
    kind: 'boolean',
    defaultValue: true,
    metering: 'NAC',
    enforcement: 'code',
    sortOrder: 40
  },
  {
    key: FEATURE_KEYS.POSTS_SAVE_DRAFT,
    label: 'Save post as draft',
    category: 'posts',
    kind: 'boolean',
    defaultValue: true,
    metering: 'NAC',
    enforcement: 'code',
    sortOrder: 50
  },
  {
    key: FEATURE_KEYS.POSTS_PUBLISHING_LEVEL,
    label: 'Publish & post management',
    description: 'Depth of the publishing suite: basic scheduling versus the full calendar and approvals.',
    category: 'posts',
    kind: 'enum',
    defaultValue: 'basic',
    enumOptions: ['none', 'basic', 'full'],
    metering: 'NAC',
    enforcement: 'code',
    sortOrder: 60
  },
  {
    key: FEATURE_KEYS.POSTS_AI_ENABLED,
    label: 'AI-generated post content',
    description: 'Let Reppy write post copy and captions.',
    category: 'posts',
    kind: 'boolean',
    defaultValue: false,
    metering: 'AC',
    enforcement: 'code',
    sortOrder: 70
  },

  // ── Automation / analytics / agents ───────────────────────────────────────
  {
    key: FEATURE_KEYS.AUTO_REPLY_ENABLED,
    label: 'Auto-reply (Reppy AI) enabled',
    description: 'Master switch for the Reppy AI auto-reply feature.',
    category: 'automation',
    kind: 'boolean',
    defaultValue: true,
    metering: 'AC',
    enforcement: 'code',
    sortOrder: 10
  },
  {
    key: FEATURE_KEYS.ANALYTICS_ADVANCED,
    label: 'Advanced analytics',
    description: 'Cohorts, time-series exports, agent performance.',
    category: 'analytics',
    kind: 'boolean',
    defaultValue: true,
    metering: 'NAC',
    enforcement: 'code',
    sortOrder: 10
  },
  {
    key: FEATURE_KEYS.AGENTS_ENABLED,
    label: 'Reppy AI agents (multi-agent flows)',
    category: 'automation',
    kind: 'boolean',
    defaultValue: true,
    metering: 'AC',
    enforcement: 'code',
    sortOrder: 20
  },
  {
    key: FEATURE_KEYS.AUTOMATION_AI_DECISIONING,
    label: 'AI-decisioned automations',
    description: 'Let Reppy choose the branch in an automation flow instead of fixed rules.',
    category: 'automation',
    kind: 'boolean',
    defaultValue: false,
    metering: 'AC',
    enforcement: 'code',
    sortOrder: 25
  },
  {
    key: FEATURE_KEYS.FLOW_BUILDER_ENABLED,
    label: 'Flow Builder',
    description: 'Access to the visual flow builder. Sold as a paid add-on on lower tiers.',
    category: 'automation',
    kind: 'boolean',
    defaultValue: false,
    metering: 'AC',
    enforcement: 'code',
    sortOrder: 40
  },
  {
    key: FEATURE_KEYS.FLOW_BUILDER_AI_ENABLED,
    label: 'Flow Builder — AI-powered',
    description: 'Whether flow builder nodes can call Reppy. Granted by the plan, not by the add-on.',
    category: 'automation',
    kind: 'boolean',
    defaultValue: false,
    metering: 'AC',
    enforcement: 'code',
    sortOrder: 45
  },

  // ── Voice IVR ─────────────────────────────────────────────────────────────
  {
    key: FEATURE_KEYS.VOICE_IVR_ENABLED,
    label: 'Reppy AI Voice IVR',
    description: 'Reppy AI phone calling, voice agents, and call analytics for automation teams.',
    category: 'automation',
    kind: 'boolean',
    defaultValue: true,
    metering: 'AC',
    enforcement: 'code',
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
    metering: 'AC',
    enforcement: 'code',
    sortOrder: 10
  },
  {
    key: FEATURE_KEYS.COMMERCE_WA_CATALOG_ENABLED,
    label: 'WhatsApp Catalog',
    description: 'Enable WhatsApp Commerce Catalog sync, product cards, and cart orders.',
    category: 'commerce',
    kind: 'boolean',
    defaultValue: true,
    metering: 'NAC',
    enforcement: 'code',
    sortOrder: 20
  },
  {
    key: FEATURE_KEYS.COMMERCE_AI_ASSIST_ENABLED,
    label: 'Reppy AI Commerce Assist',
    description: 'Reppy-powered product suggestions and sales replies in the inbox.',
    category: 'commerce',
    kind: 'boolean',
    defaultValue: true,
    metering: 'AC',
    enforcement: 'code',
    sortOrder: 30
  },
  {
    key: FEATURE_KEYS.COMMERCE_AUTONOMOUS_AGENT,
    label: 'Autonomous Reppy AI Sales Agent',
    description: 'Allow Reppy to auto-send product messages and handle sales without agent intervention.',
    category: 'commerce',
    kind: 'boolean',
    defaultValue: false,
    metering: 'AC',
    enforcement: 'code',
    sortOrder: 40
  },
  {
    key: FEATURE_KEYS.COMMERCE_ORDERS_LEVEL,
    label: 'Order & Ecommerce management',
    description: 'Depth of the order desk: none, basic order tracking, or full SLA workflows.',
    category: 'commerce',
    kind: 'enum',
    defaultValue: 'none',
    enumOptions: ['none', 'basic', 'full'],
    metering: 'NAC',
    enforcement: 'code',
    sortOrder: 50
  },
  {
    key: FEATURE_KEYS.SUPPORT_COMPLAINTS_LEVEL,
    label: 'Complaint management',
    description: 'Depth of complaint handling: none, basic, or advanced SLA workflows.',
    category: 'commerce',
    kind: 'enum',
    defaultValue: 'none',
    enumOptions: ['none', 'basic', 'advanced'],
    metering: 'NAC',
    enforcement: 'code',
    sortOrder: 60
  },

  // ── Campaigns ─────────────────────────────────────────────────────────────
  {
    key: FEATURE_KEYS.CAMPAIGNS_ENABLED,
    label: 'WhatsApp campaigns',
    description: 'Master switch for WhatsApp template campaign module.',
    category: 'campaigns',
    kind: 'boolean',
    defaultValue: true,
    metering: 'NAC',
    enforcement: 'code',
    sortOrder: 10
  },
  {
    key: FEATURE_KEYS.CAMPAIGNS_RECIPIENTS_MONTHLY,
    label: 'Broadcasts (proactive campaigns) / month',
    description: 'Maximum WhatsApp template messages sent via campaigns per billing month.',
    category: 'campaigns',
    kind: 'limit',
    defaultValue: -1,
    unit: 'recipients',
    resetPeriod: 'monthly',
    metering: 'AC',
    enforcement: 'code',
    sortOrder: 20
  },
  {
    key: FEATURE_KEYS.WHATSAPP_BROADCAST_ENABLED,
    label: 'Bulk template broadcast',
    description: 'Allow launching bulk WhatsApp template campaigns.',
    category: 'campaigns',
    kind: 'boolean',
    defaultValue: true,
    metering: 'NAC',
    enforcement: 'code',
    sortOrder: 30
  },

  // ── Integrations (WhatsApp templates, flows, CRM, channels) ───────────────
  {
    key: FEATURE_KEYS.WHATSAPP_TEMPLATES_MAX,
    label: 'Approved WA templates stored',
    description: 'Maximum WhatsApp message templates synced/stored for the org.',
    category: 'integrations',
    kind: 'limit',
    defaultValue: -1,
    unit: 'count',
    metering: 'AC',
    enforcement: 'code',
    sortOrder: 10
  },
  {
    key: FEATURE_KEYS.AUTOMATION_FLOWS_MAX,
    label: 'Automations (rule-based flows)',
    description: 'Maximum active WhatsApp automation flows.',
    category: 'integrations',
    kind: 'limit',
    defaultValue: -1,
    unit: 'count',
    metering: 'AC',
    enforcement: 'code',
    sortOrder: 20
  },
  {
    key: FEATURE_KEYS.WHATSAPP_FLOWS_ENABLED,
    label: 'WhatsApp Forms (Interactive Flows)',
    description: 'Create and publish interactive forms (surveys, reviews) in WhatsApp.',
    category: 'integrations',
    kind: 'boolean',
    defaultValue: false,
    metering: 'NAC',
    enforcement: 'code',
    sortOrder: 25
  },
  {
    key: FEATURE_KEYS.WHATSAPP_FLOWS_MAX,
    label: 'Published WhatsApp Forms',
    description: 'Maximum published interactive flows per organization.',
    category: 'integrations',
    kind: 'limit',
    defaultValue: 0,
    unit: 'count',
    metering: 'AC',
    enforcement: 'code',
    sortOrder: 26
  },
  {
    key: FEATURE_KEYS.CONTACTS_MAX,
    label: 'Active Contacts included',
    description: 'Maximum contacts stored in the CRM. Top-ups permanently raise this ceiling.',
    category: 'integrations',
    kind: 'limit',
    defaultValue: -1,
    unit: 'contacts',
    metering: 'AC',
    enforcement: 'code',
    sortOrder: 30
  },
  {
    key: FEATURE_KEYS.CHANNELS_ALLOWED,
    label: 'Channels included',
    description: 'Which platforms the organization may connect and converse on.',
    category: 'integrations',
    kind: 'list',
    defaultValue: [],
    enumOptions: ['instagram', 'whatsapp', 'youtube', 'facebook', 'google', 'linkedin', 'twitter'],
    metering: 'AC',
    enforcement: 'code',
    sortOrder: 40
  },

  // ── Account-level / general ───────────────────────────────────────────────
  {
    key: FEATURE_KEYS.BRANDING_REMOVED,
    label: 'Branding removed',
    description: 'Hide RepMeUp branding from customer-facing surfaces.',
    category: 'general',
    kind: 'boolean',
    defaultValue: false,
    metering: 'NAC',
    enforcement: 'unbuilt',
    sortOrder: 10
  },
  {
    key: FEATURE_KEYS.RBAC_LEVEL,
    label: 'User access control (roles & permissions)',
    description: 'Single shared role, full role-based access, or advanced roles with an audit log.',
    category: 'general',
    kind: 'enum',
    defaultValue: 'single',
    enumOptions: ['single', 'roles', 'advanced'],
    metering: 'NAC',
    enforcement: 'code',
    sortOrder: 20
  },
  {
    key: FEATURE_KEYS.SUPPORT_LEVEL,
    label: 'Priority support / dedicated manager',
    description: 'Support tier attached to the plan.',
    category: 'general',
    kind: 'enum',
    defaultValue: 'email',
    enumOptions: ['email', 'priority', 'dedicated'],
    metering: 'NAC',
    enforcement: 'manual',
    sortOrder: 30
  }
];

const BUCKET_KEYS = CATALOG
  .filter((c) => c.kind === 'limit' && c.resetPeriod && c.resetPeriod !== 'none')
  .map((c) => c.key);

/**
 * `enforcement` states, derived from each row rather than a parallel list.
 *
 * A hand-maintained Set used to live here, and it drifted: `credits.aiConversations.monthly`
 * was asserted in aiConversationService while the admin panel reported it "Not enforced",
 * because someone (me) wired the gate and forgot the second edit. Keeping the flag on the
 * row it describes makes that class of mistake impossible.
 *
 *   code    — a real gate exists in the backend (assert / requireFeature / requireLevel)
 *   manual  — genuine, but delivered by humans (support SLA); no code can enforce it
 *   unbuilt — the feature does not exist yet, so there is nothing to gate
 *
 * `unbuilt` is not a to-do marker: it is an honest statement that the plan value is
 * currently decorative. Build the feature, then flip the row to `code`.
 */
const VALID_ENFORCEMENT = new Set(['code', 'manual', 'unbuilt']);

const ENFORCED_FEATURE_KEYS = new Set(
  CATALOG.filter((row) => row.enforcement === 'code').map((row) => row.key)
);

const VALID_METERING = new Set(['AC', 'NAC']);

const CATALOG_BY_KEY = Object.freeze(
  CATALOG.reduce((acc, row) => {
    if (!row?.key) {
      throw new Error(`Feature catalog row missing "key": ${JSON.stringify(row)}`);
    }
    if (!VALID_METERING.has(row.metering)) {
      throw new Error(
        `Feature catalog row "${row.key}" must declare metering: 'AC' | 'NAC' (it drives the public pricing sheet).`
      );
    }
    if (!VALID_ENFORCEMENT.has(row.enforcement)) {
      throw new Error(
        `Feature catalog row "${row.key}" must declare enforcement: 'code' | 'manual' | 'unbuilt' `
        + '(it tells admins whether the value actually does anything).'
      );
    }
    if (row.kind === 'enum' && !Array.isArray(row.enumOptions)) {
      throw new Error(`Feature catalog row "${row.key}" is kind 'enum' but has no enumOptions.`);
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

/**
 * Rank of an enum value on its capability ladder (enumOptions order is ascending).
 * @returns {number} -1 when the key is not an enum or the value is unknown.
 */
function enumRank(featureKey, value) {
  const entry = resolveCatalogEntry(featureKey);
  if (!entry || entry.kind !== 'enum' || !Array.isArray(entry.enumOptions)) return -1;
  return entry.enumOptions.indexOf(value);
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
  resolveCatalogEntry,
  enumRank
};
