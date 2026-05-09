/**
 * One-shot migration: copy legacy Plan.limits.* + Plan.features[] into Plan.entitlements.
 *
 *   node backend/scripts/migrate-plan-entitlements.js          # dry run
 *   node backend/scripts/migrate-plan-entitlements.js --fix    # write changes
 *
 * Idempotent: a plan that already has `entitlements` populated for a key
 * is left untouched for that key (admin edits win).
 */

require('dotenv').config();
const mongoose = require('mongoose');
const Plan = require('../src/models/Plan');
const { FEATURE_KEYS } = require('../src/config/featureCatalog');

const DRY_RUN = !process.argv.includes('--fix');

/**
 * Map old `Plan.limits.maxXxx` field → new entitlements key.
 * Keep in sync with featureCatalog.js.
 */
const LIMIT_FIELD_TO_KEY = {
  maxAccounts: FEATURE_KEYS.ACCOUNTS_MAX,
  maxUsers: FEATURE_KEYS.USERS_MAX,
  maxPostsPerMonth: FEATURE_KEYS.POSTS_PER_MONTH,
  maxAutoRepliesPerMonth: FEATURE_KEYS.CREDITS_AUTO_REPLY,
  maxAICreditsPerMonth: FEATURE_KEYS.CREDITS_AI_GENERAL,
  maxStorageGB: FEATURE_KEYS.STORAGE_GB,
  maxAPICallsPerDay: FEATURE_KEYS.API_CALLS_DAILY
};

/**
 * Map legacy free-form feature strings → new boolean keys.
 * Anything not recognized stays in `Plan.features[]` for backwards compat.
 */
const FEATURE_STRING_TO_KEY = {
  knowledge_base: FEATURE_KEYS.KB_ENTRIES_MAX, // any KB usage allowed
  auto_reply: FEATURE_KEYS.AUTO_REPLY_ENABLED,
  ai_responses: FEATURE_KEYS.AUTO_REPLY_ENABLED,
  advanced_analytics: FEATURE_KEYS.ANALYTICS_ADVANCED,
  analytics_basic: FEATURE_KEYS.ANALYTICS_ADVANCED // basic ⇒ also turn flag on
};

async function connect() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('✅ MongoDB connected');
}

async function migrate() {
  const plans = await Plan.find();
  let touched = 0;

  for (const plan of plans) {
    /** @type {Record<string, object>} */
    let ent =
      plan.entitlements && typeof plan.entitlements === 'object' && !(plan.entitlements instanceof Map)
        ? { ...plan.entitlements }
        : plan.entitlements instanceof Map
          ? Object.fromEntries(plan.entitlements)
          : {};
    const before = Object.keys(ent).length;

    for (const [field, key] of Object.entries(LIMIT_FIELD_TO_KEY)) {
      if (ent[key] !== undefined) continue;
      const v = plan.limits?.[field];
      if (v === undefined || v === null) continue;
      ent[key] = { limit: v };
    }

    if (Array.isArray(plan.features)) {
      for (const code of plan.features) {
        const key = FEATURE_STRING_TO_KEY[code];
        if (!key) continue;
        if (ent[key] !== undefined) continue;
        if (key === FEATURE_KEYS.KB_ENTRIES_MAX) {
          ent[key] = { limit: -1 };
        } else {
          ent[key] = { enabled: true };
        }
      }
    }

    const after = Object.keys(ent).length;
    const added = after - before;
    if (added <= 0) continue;

    plan.entitlements = ent;
    plan.markModified('entitlements');
    touched += 1;
    console.log(`📦 ${plan.planId}: +${added} entitlement entries (total ${after}).`);

    if (!DRY_RUN) await plan.save();
  }

  console.log(
    `\n${DRY_RUN ? '👀 DRY RUN' : '✅ MIGRATION COMPLETE'}: ${touched}/${plans.length} plans would be updated.`
  );
  if (DRY_RUN) console.log('   Re-run with --fix to persist.');
}

(async () => {
  try {
    await connect();
    await migrate();
    process.exit(0);
  } catch (err) {
    console.error('❌ migrate-plan-entitlements failed:', err);
    process.exit(1);
  }
})();
