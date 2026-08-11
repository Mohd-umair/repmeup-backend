/**
 * The published pricing sheet, expressed as data.
 *
 * This is the ONLY place the public comparison table's shape lives: section order,
 * row order, row labels, and which feature key (or add-on SKU, or static string)
 * fills each cell. `planPresentationService.buildComparisonMatrix()` walks it once
 * per plan and emits display-ready cells.
 *
 * Row kinds:
 *   - `key`         — resolve this feature key against each plan's entitlements.
 *   - `addOnRef`    — resolve from the AddOn catalog (per-plan price and grant size),
 *                     so the number advertised and the number charged are one value.
 *   - `staticValue` — the same string on every plan (pass-through costs, free-forever
 *                     capabilities). Used with `spansAllColumns` for full-width notes.
 *
 * `formatter` names a renderer in planPresentationService (not a function, so this
 * file stays serialisable and safe to ship to the client if ever needed).
 */

const { FEATURE_KEYS } = require('./featureCatalog');

const SECTIONS = [
  {
    id: 'every_plan',
    title: 'INCLUDED ON EVERY PLAN',
    rows: [
      { key: FEATURE_KEYS.BRANDING_REMOVED, label: 'Branding removed' }
    ]
  },
  {
    id: 'users_contacts',
    title: 'USERS & ACTIVE CONTACTS',
    rows: [
      { key: FEATURE_KEYS.USERS_MAX, label: 'Users included' },
      {
        addOnRef: 'extra_user',
        label: 'Extra user cost, per user/mo',
        formatter: 'addOnPrice',
        metering: 'AC'
      },
      { key: FEATURE_KEYS.CONTACTS_MAX, label: 'Active Contacts included' },
      {
        addOnRef: 'contacts_topup',
        label: 'Additional contacts — one-time top-up',
        formatter: 'addOnPriceForGrant',
        metering: 'AC'
      }
    ]
  },
  {
    id: 'channels',
    title: 'CHANNELS',
    rows: [
      { key: FEATURE_KEYS.CHANNELS_ALLOWED, label: 'Channels included', formatter: 'channelList' }
    ]
  },
  {
    id: 'ai_automation',
    title: 'AI & AUTOMATION',
    rows: [
      { key: FEATURE_KEYS.CREDITS_AI_CONVERSATIONS, label: 'AI conversation credits included' },
      {
        addOnRef: 'ai_conversations_recharge',
        label: 'AI conversation recharge — minimum top-up',
        formatter: 'addOnPriceRange',
        metering: 'AC'
      },
      {
        key: FEATURE_KEYS.AUTO_REPLY_ENABLED,
        label: 'Social management (AI-powered replies, DMs & comments)',
        formatter: 'includedFlag'
      },
      { key: FEATURE_KEYS.INBOX_INTENT_BUCKET_ENABLED, label: 'Intent Bucket (AI-classified customer intent)' },
      {
        key: FEATURE_KEYS.AUTOMATION_FLOWS_MAX,
        label: 'Automations (rule-based flows)',
        formatter: 'automationsWithAiDecisioning'
      },
      { key: FEATURE_KEYS.CAMPAIGNS_RECIPIENTS_MONTHLY, label: 'Broadcasts (proactive campaigns) / month' }
    ]
  },
  {
    id: 'whatsapp',
    title: 'WHATSAPP',
    rows: [
      { key: FEATURE_KEYS.CHANNELS_ALLOWED, label: 'WhatsApp channel access', formatter: 'whatsappAccess' },
      {
        key: FEATURE_KEYS.INBOX_COLLABORATION_LEVEL,
        label: 'Unified Inbox (Instagram, WhatsApp, Facebook, YouTube)'
      },
      {
        staticValue: 'Same for every plan — see the panel below the table',
        label: 'Marketing / utility / authentication message costs',
        metering: 'NAC',
        spansAllColumns: true
      }
    ]
  },
  {
    id: 'growth_tools',
    title: 'GROWTH TOOLS',
    rows: [
      { key: FEATURE_KEYS.POSTS_PUBLISHING_LEVEL, label: 'Publish & post management' },
      { key: FEATURE_KEYS.POSTS_AI_ENABLED, label: 'AI-generated post content' }
    ]
  },
  {
    id: 'commerce_support',
    title: 'COMMERCE & SUPPORT OPERATIONS — FROM GROWTH',
    rows: [
      { key: FEATURE_KEYS.RBAC_LEVEL, label: 'User access control (roles & permissions)' },
      { key: FEATURE_KEYS.COMMERCE_ORDERS_LEVEL, label: 'Order & Ecommerce management' },
      { key: FEATURE_KEYS.SUPPORT_COMPLAINTS_LEVEL, label: 'Complaint management' }
    ]
  },
  {
    id: 'premium',
    title: 'PREMIUM — PRO EXCLUSIVE OR PAID ADD-ON',
    rows: [
      { key: FEATURE_KEYS.SUPPORT_LEVEL, label: 'Priority support / dedicated manager' },
      {
        key: FEATURE_KEYS.FLOW_BUILDER_ENABLED,
        addOnRef: 'flow_builder',
        label: 'Flow Builder (₹/mo)',
        formatter: 'flowBuilder'
      }
    ]
  },
  {
    id: 'also_included',
    title: 'ALSO INCLUDED, EVERY PLAN',
    rows: [
      {
        staticValue: 'Free',
        label: 'Service messages (24-hr reply window)',
        metering: 'NAC'
      }
    ]
  }
];

/**
 * Enum value → the exact wording used on the sheet. Anything not listed here falls
 * back to a title-cased version of the raw value.
 */
const ENUM_CELL_LABELS = Object.freeze({
  [FEATURE_KEYS.INBOX_COLLABORATION_LEVEL]: {
    labels: 'Labels & reminders',
    shared: 'Shared inbox + assignment'
  },
  [FEATURE_KEYS.POSTS_PUBLISHING_LEVEL]: {
    none: '–',
    basic: 'Basic',
    full: 'Full'
  },
  [FEATURE_KEYS.RBAC_LEVEL]: {
    single: 'Single role',
    roles: 'Role-based',
    advanced: 'Advanced + audit log'
  },
  [FEATURE_KEYS.COMMERCE_ORDERS_LEVEL]: {
    none: '–',
    basic: 'Basic',
    full: 'Full, advanced SLA workflows'
  },
  [FEATURE_KEYS.SUPPORT_COMPLAINTS_LEVEL]: {
    none: '–',
    basic: 'Yes',
    advanced: 'Advanced SLA workflows'
  },
  [FEATURE_KEYS.SUPPORT_LEVEL]: {
    email: 'Email',
    priority: 'Priority email',
    dedicated: 'Dedicated manager'
  }
});

/**
 * Short labels for the hero metric tiles on a plan card. Catalog labels are written for
 * the admin form ("Maximum users"); the card wants the sheet's wording ("users").
 */
const HEADLINE_METRIC_LABELS = Object.freeze({
  [FEATURE_KEYS.CREDITS_AI_CONVERSATIONS]: 'AI conversations / month',
  [FEATURE_KEYS.USERS_MAX]: 'users',
  [FEATURE_KEYS.CONTACTS_MAX]: 'Active Contacts',
  [FEATURE_KEYS.CAMPAIGNS_RECIPIENTS_MONTHLY]: 'broadcasts / month'
});

/** Channel key → display name, for the channels.allowed list cell. */
const CHANNEL_LABELS = Object.freeze({
  instagram: 'Instagram',
  whatsapp: 'WhatsApp',
  youtube: 'YouTube',
  facebook: 'Facebook',
  google: 'Google',
  linkedin: 'LinkedIn',
  twitter: 'X'
});

module.exports = { SECTIONS, ENUM_CELL_LABELS, CHANNEL_LABELS, HEADLINE_METRIC_LABELS };
