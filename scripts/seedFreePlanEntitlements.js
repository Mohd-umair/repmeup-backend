/**
 * Seed / refresh the Free-plan entitlements object without touching existing
 * paid plans. Idempotent — re-running just overwrites the Free plan's
 * entitlements with the canonical values from the product spec.
 *
 * Why a dedicated script? `seedPlans.js` short-circuits when ANY plan exists,
 * which prevents shipping new free-tier values to environments that were
 * seeded before the entitlements engine landed. This script targets only
 * `planId: 'free'` and never modifies paid plans (they are admin-managed
 * end-to-end via the dynamic plans page).
 *
 * Run: node backend/scripts/seedFreePlanEntitlements.js
 */

require('dotenv').config();
const mongoose = require('mongoose');
const Plan = require('../src/models/Plan');
const { FEATURE_KEYS } = require('../src/config/featureCatalog');
const entitlementsService = require('../src/services/entitlementsService');
const Subscription = require('../src/models/Subscription');

/** Canonical Free-tier entitlements (matches the product spec, single source of truth). */
const FREE_ENTITLEMENTS = Object.freeze({
  [FEATURE_KEYS.USERS_MAX]:               { limit: 1 },
  [FEATURE_KEYS.CREDITS_AUTO_REPLY]:      { limit: 100 },
  [FEATURE_KEYS.CREDITS_POST_CREATION]:   { limit: 50 },
  [FEATURE_KEYS.INBOX_UNIQUE_CONTACTS]:   { limit: 200 },
  [FEATURE_KEYS.KB_ENTRIES_MAX]:          { limit: 2 },
  [FEATURE_KEYS.KB_UPLOAD_URL]:           { enabled: false },
  [FEATURE_KEYS.KB_UPLOAD_PDF]:           { enabled: true },
  [FEATURE_KEYS.POSTS_PLATFORMS_MAX]:     { limit: 1 },
  [FEATURE_KEYS.POSTS_AI_VARIANTS_MAX]:   { limit: 2 },
  [FEATURE_KEYS.POSTS_TRENDS]:            { enabled: false },
  [FEATURE_KEYS.POSTS_LOGO]:              { enabled: false },
  [FEATURE_KEYS.POSTS_SAVE_DRAFT]:        { enabled: false },
  [FEATURE_KEYS.INBOX_BUCKET_CHAT]:       { enabled: false },
  [FEATURE_KEYS.INBOX_BUCKET_CREATE]:     { enabled: false }
});

async function run() {
  if (!process.env.MONGODB_URI) {
    console.error('❌ MONGODB_URI is required (check your .env)');
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGODB_URI);
  console.log('✅ MongoDB connected');

  // Upsert: keep description / pricing / display fields, replace entitlements
  // outright so removed keys don't linger.
  const update = {
    $set: {
      planId: 'free',
      name: 'Free',
      tier: 0,
      price: 0,
      billingCycle: 'monthly',
      isActive: true,
      isPublic: true,
      displayOrder: 1,
      entitlements: FREE_ENTITLEMENTS
    },
    $setOnInsert: {
      description: 'Perfect for individuals getting started with social media management',
      limits: {
        maxAccounts: 1,
        maxUsers: 1,
        maxPostsPerMonth: 50,
        maxAutoRepliesPerMonth: 100,
        maxAICreditsPerMonth: 100,
        maxStorageGB: 1,
        maxAPICallsPerDay: 100
      },
      features: ['basic_posting', 'single_inbox', 'manual_replies', 'basic_analytics']
    }
  };

  const before = await Plan.findOne({ planId: 'free' }).lean();
  const result = await Plan.findOneAndUpdate({ planId: 'free' }, update, {
    upsert: true,
    new: true,
    setDefaultsOnInsert: true
  });

  console.log(before ? '🔁 Updated existing Free plan entitlements' : '🆕 Inserted Free plan');
  console.log('   keys:', Object.keys(FREE_ENTITLEMENTS).length);

  // Bust the entitlements cache for every org currently on the Free plan so
  // their next /api/entitlements call sees the fresh values.
  const subs = await Subscription.find({ planId: 'free' }).select('organization').lean();
  let invalidated = 0;
  for (const s of subs) {
    try {
      await entitlementsService.invalidateEntitlements(String(s.organization));
      invalidated++;
    } catch (err) {
      console.warn('   - invalidation failed for org', s.organization, err.message);
    }
  }
  if (subs.length) console.log(`🧹 Invalidated entitlements cache for ${invalidated}/${subs.length} Free-plan orgs`);

  console.log('\n📋 Result snapshot:');
  console.log(JSON.stringify(
    {
      planId: result.planId,
      name: result.name,
      entitlements:
        result.entitlements && typeof result.entitlements === 'object' && !(result.entitlements instanceof Map)
          ? result.entitlements
          : result.entitlements instanceof Map
            ? Object.fromEntries(result.entitlements)
            : {}
    },
    null,
    2
  ));

  await mongoose.disconnect();
  process.exit(0);
}

run().catch((err) => {
  console.error('❌ seedFreePlanEntitlements failed:', err);
  process.exit(1);
});
