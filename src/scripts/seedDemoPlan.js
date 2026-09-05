/**
 * Seed (or refresh) the full-access "demo" Plan that demo/trial workspaces run on.
 *
 * Why a dedicated plan: real tier plans (e.g. Enterprise) may legitimately have
 * some features disabled (we found automation.autoReply.enabled / agents.enabled
 * = false on Enterprise). A demo must showcase EVERYTHING, so it gets its own
 * plan with every boolean feature enabled and every limit unlimited (-1).
 *
 * AI credits stay unlimited at the plan level; per-demo credit caps are applied
 * on the Subscription (demoCreditsCap) so each demo can be capped individually.
 *
 * Idempotent: upserts by planId 'demo'. Safe to re-run after catalog changes.
 *
 *   node src/scripts/seedDemoPlan.js
 */
require('dotenv').config();
const mongoose = require('mongoose');
const { CATALOG } = require('../config/featureCatalog');

const DEMO_PLAN_ID = 'demo';

/** Build an entitlements map granting every feature (booleans on, limits unlimited). */
function buildFullAccessEntitlements() {
  const entitlements = {};
  for (const entry of CATALOG) {
    if (entry.kind === 'boolean') {
      entitlements[entry.key] = { enabled: true };
    } else if (entry.kind === 'limit') {
      entitlements[entry.key] = { limit: -1 }; // -1 = unlimited
    } else if (entry.kind === 'enum') {
      // Top rung of the ladder — enumOptions is ordered ascending by capability.
      // Falling back to defaultValue here would hand demos the LOWEST rung.
      const opts = entry.enumOptions || [];
      entitlements[entry.key] = { value: opts.length ? opts[opts.length - 1] : entry.defaultValue };
    } else if (entry.kind === 'list') {
      // Every allowed member, not the (empty) default.
      entitlements[entry.key] = { value: entry.enumOptions ? [...entry.enumOptions] : [] };
    } else {
      entitlements[entry.key] = { value: entry.defaultValue ?? null };
    }
  }
  return entitlements;
}

async function run() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('MONGODB_URI not set');
    process.exit(1);
  }
  await mongoose.connect(uri);
  const Plan = require('../models/Plan');

  const entitlements = buildFullAccessEntitlements();

  const doc = {
    planId: DEMO_PLAN_ID,
    name: 'Demo (Full Access)',
    description: 'Internal trial plan — every feature enabled, unlimited limits. Used by demo workspaces only.',
    tier: 99,               // above all real tiers; never a self-serve upgrade target
    price: 0,
    billingCycle: 'monthly',
    // Legacy limits view (some old callers read these directly) — all unlimited.
    limits: {
      maxAccounts: -1,
      maxUsers: -1,
      maxPostsPerMonth: -1,
      maxAutoRepliesPerMonth: -1,
      maxAICreditsPerMonth: -1,
      maxStorageGB: -1,
      maxAPICallsPerDay: -1
    },
    entitlements,
    // Boolean features list kept in sync for any legacy `plan.features` reader.
    features: CATALOG.filter((e) => e.kind === 'boolean').map((e) => e.key),
    isActive: true,
    isPublic: false         // hidden from public pricing / upgrade flows
  };

  const result = await Plan.findOneAndUpdate(
    { planId: DEMO_PLAN_ID },
    { $set: doc },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  const boolCount = CATALOG.filter((e) => e.kind === 'boolean').length;
  const limitCount = CATALOG.filter((e) => e.kind === 'limit').length;
  console.log(`✅ Demo plan upserted: planId=${result.planId}, tier=${result.tier}`);
  console.log(`   ${boolCount} boolean features enabled, ${limitCount} limits set to unlimited.`);

  await mongoose.disconnect();
  process.exit(0);
}

run().catch((e) => {
  console.error('seedDemoPlan failed:', e.message);
  process.exit(1);
});
