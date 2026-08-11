/**
 * Seed the 2026 pricing sheet lineup and migrate off the retired `pro` plan.
 *
 *   Starter  ₹1,499/mo  (₹6,000/yr offer)   planId: starter   tier 1
 *   Growth   ₹4,999/mo                      planId: growth    tier 2   ← old `pro` subs land here
 *   Pro      ₹12,999/mo                     planId: pro_max   tier 3
 *   Enterprise custom                       planId: enterprise tier 4
 *
 * `free` and `demo` are left in place (13 + 7 live subscriptions) but patched with the
 * new feature keys so they don't sit on fail-closed defaults. `free` is also taken off
 * the public pricing page, since the sheet has no free tier.
 *
 * Idempotent and re-runnable: a second run reports zero changes.
 *
 *   node scripts/seedPricingSheetPlans.js --dry-run     # report only, no writes
 *   node scripts/seedPricingSheetPlans.js               # apply app-side changes
 *   node scripts/seedPricingSheetPlans.js --fix-razorpay  # ALSO move live Razorpay
 *                                                          subscriptions to the new plan
 *
 * --fix-razorpay is opt-in on purpose: the six migrating orgs hold live Razorpay
 * subscriptions at ₹7,500, and moving them app-side does NOT change what Razorpay
 * charges. Read the printed report before you touch real billing.
 */
require('dotenv').config();
const mongoose = require('mongoose');

const {
  STARTER_2026,
  GROWTH_2026,
  PRO_MAX_2026,
  FREE_PATCH_2026,
  PLAN_MARKETING_2026
} = require('./pricingSheetEntitlements');
const { ENTERPRISE_ENTITLEMENTS } = require('./planTierEntitlements');

const DRY_RUN = process.argv.includes('--dry-run');
const FIX_RAZORPAY = process.argv.includes('--fix-razorpay');
/** Apply the app-side lineup + migration without touching Razorpay at all. */
const SKIP_RAZORPAY = process.argv.includes('--skip-razorpay');
/** Escape hatch for the test-key guard — only for a genuinely non-production database. */
const ALLOW_TEST_RAZORPAY = process.argv.includes('--allow-test-razorpay');

/**
 * Old planId → new planId.
 *
 * `pro` (₹7,500, 6 subs) → `growth` (₹4,999): a price drop, so nobody pays more.
 *
 * `business` is an ORPHAN — 2 subscriptions reference it but no Plan document exists,
 * which means entitlementsService silently falls those orgs back to the FREE plan.
 * They are two paying "Business" customers running on free-tier limits right now.
 * They move to `pro_max`, the nearest equivalent tier (and cheaper than the ₹16,499
 * Business was seeded at).
 */
const PLAN_MIGRATIONS = [
  { from: 'pro', to: 'growth' },
  { from: 'business', to: 'pro_max' }
];

/** Plans to deactivate once nothing references them. */
const RETIRING_PLAN_IDS = ['pro'];
const MIGRATION_REASON = 'pricing_2026_migration';

const PLAN_DEFS = [
  {
    planId: 'starter',
    name: 'Starter',
    tier: 1,
    price: 1499,
    priceAnnual: 6000,
    displayOrder: 1,
    entitlements: STARTER_2026,
    limitedOffer: { active: true, badge: 'LIMITED OFFER' }
  },
  {
    planId: 'growth',
    name: 'Growth',
    tier: 2,
    price: 4999,
    displayOrder: 2,
    entitlements: GROWTH_2026
  },
  {
    planId: 'pro_max',
    name: 'Pro',
    tier: 3,
    price: 12999,
    displayOrder: 3,
    entitlements: PRO_MAX_2026
  },
  {
    planId: 'enterprise',
    name: 'Enterprise',
    tier: 4,
    price: 'custom',
    billingCycle: 'custom',
    displayOrder: 4,
    entitlements: ENTERPRISE_ENTITLEMENTS,
    badge: 'CONTACT SALES'
  }
];

/** Derive the legacy limits block so old readers stay consistent with entitlements. */
function legacyLimitsFrom(entitlements) {
  const num = (key, fallback) => {
    const v = entitlements[key];
    return v && Number.isFinite(v.limit) ? v.limit : fallback;
  };
  return {
    maxAccounts: num('accounts.max', -1),
    maxUsers: num('users.max', -1),
    maxPostsPerMonth: num('posts.perMonth', -1),
    maxAutoRepliesPerMonth: num('credits.autoReply.monthly', -1),
    maxAICreditsPerMonth: num('credits.ai.monthly', -1),
    maxStorageGB: num('storage.gb', -1),
    maxAPICallsPerDay: num('api.calls.daily', -1)
  };
}

function buildPlanDoc(def) {
  const marketing = PLAN_MARKETING_2026[def.planId] || {};
  return {
    name: def.name,
    tier: def.tier,
    price: def.price,
    billingCycle: def.billingCycle || 'monthly',
    displayOrder: def.displayOrder,
    isActive: true,
    isPublic: true,
    entitlements: def.entitlements,
    limits: legacyLimitsFrom(def.entitlements),
    description: marketing.tagline || '',
    tagline: marketing.tagline || '',
    badge: marketing.badge || def.badge || '',
    cardStyle: marketing.cardStyle || 'light',
    inheritsFromPlanId: marketing.inheritsFromPlanId || '',
    headlineMetricKeys: marketing.headlineMetricKeys || [],
    cardBullets: marketing.cardBullets || [],
    entitlementNotes: marketing.entitlementNotes || {},
    limitedOffer: def.limitedOffer || { active: false },
    ...(def.priceAnnual !== undefined ? { priceAnnual: def.priceAnnual } : {}),
    ...(marketing.annualOfferLabel ? { annualOfferLabel: marketing.annualOfferLabel } : {})
  };
}

async function upsertPlans(Plan) {
  const summary = [];
  for (const def of PLAN_DEFS) {
    const doc = buildPlanDoc(def);
    const existing = await Plan.findOne({ planId: def.planId }).lean();
    if (DRY_RUN) {
      summary.push({ planId: def.planId, action: existing ? 'would update' : 'would create' });
      continue;
    }
    await Plan.findOneAndUpdate(
      { planId: def.planId },
      { $set: doc, $setOnInsert: { planId: def.planId } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    summary.push({ planId: def.planId, action: existing ? 'updated' : 'created' });
  }
  return summary;
}

/**
 * Patch the off-sheet plans with the new keys only — never replace their whole
 * entitlements object, which would wipe values other seeds own.
 */
async function patchOffSheetPlans(Plan) {
  const result = { free: 0, demo: 0 };

  /**
   * Feature keys contain dots ('channels.allowed'), and `Plan.entitlements` stores them
   * as LITERAL dotted keys on a Mixed field. A `$set` of `entitlements.channels.allowed`
   * does NOT write that key — MongoDB reads the dots as a path and silently builds
   * `entitlements: { channels: { allowed: … } }`, which the resolver never looks at.
   * So merge in JS and $set the whole object. (Same dotted-key trap as bucketService.)
   */
  const existing = await Plan.findOne({ planId: 'free' }).select('entitlements').lean();
  const merged = { ...(existing?.entitlements || {}) };
  for (const [key, value] of Object.entries(FREE_PATCH_2026)) {
    merged[key] = value;
  }

  // Drop the nested junk an earlier dotted-$set may have created, so the plan document
  // does not carry two contradictory copies of the same entitlement. Replacing the whole
  // `entitlements` object is what removes them — a $unset on the same path would conflict.
  let nestedRemoved = 0;
  for (const root of new Set(Object.keys(FREE_PATCH_2026).map((k) => k.split('.')[0]))) {
    if (merged[root] !== undefined) {
      delete merged[root];
      nestedRemoved += 1;
    }
  }

  if (!DRY_RUN) {
    // The sheet has no free tier — keep it working, take it off the pricing page.
    const r = await Plan.updateOne(
      { planId: 'free' },
      { $set: { entitlements: merged, isPublic: false } }
    );
    result.free = r.modifiedCount;
    result.freeNestedRemoved = nestedRemoved;
  }

  // `demo` is regenerated wholesale by src/scripts/seedDemoPlan.js (full access,
  // now including the enum/list branches). Flagged here rather than duplicated.
  const demo = await Plan.findOne({ planId: 'demo' }).select('_id').lean();
  result.demoNeedsReseed = !!demo;

  return result;
}

async function migrateOnePlan(from, to, Plan, Subscription, Organization, entitlementsService) {
  let target = await Plan.findOne({ planId: to }).lean();

  // On a dry run the target hasn't been written yet — report against what step 1 would create.
  if (!target && DRY_RUN) {
    const def = PLAN_DEFS.find((d) => d.planId === to);
    target = def ? { planId: def.planId, ...buildPlanDoc(def) } : null;
  }
  if (!target) throw new Error(`Migration target plan "${to}" not found`);

  const subs = await Subscription.find({ planId: from })
    .select('_id organization planId planName razorpaySubscriptionId')
    .lean();

  const report = [];
  for (const sub of subs) {
    report.push({
      organization: String(sub.organization),
      from: sub.planId,
      to,
      razorpaySubscriptionId: sub.razorpaySubscriptionId || null
    });

    if (DRY_RUN) continue;

    await Subscription.updateOne(
      { _id: sub._id, planId: from },   // guard: skip if already migrated
      {
        $set: {
          planId: target.planId,
          planName: target.name,
          tier: target.tier,
          limits: target.limits,
          features: target.features || []
        },
        $push: {
          planHistory: {
            planId: sub.planId,
            planName: sub.planName,
            changedAt: new Date(),
            reason: MIGRATION_REASON
          }
        }
      }
    );

    // Organization carries a denormalized copy that the app reads in places.
    await Organization.updateOne(
      { _id: sub.organization },
      { $set: { 'subscription.plan': target.planId } }
    );

    try {
      await entitlementsService.invalidateEntitlements(String(sub.organization));
    } catch (e) {
      console.warn(`   ! cache invalidation failed for ${sub.organization}: ${e.message}`);
    }
  }

  return report;
}

async function migrateAllPlans(Plan, Subscription, Organization, entitlementsService) {
  const all = [];
  for (const { from, to } of PLAN_MIGRATIONS) {
    all.push(...await migrateOnePlan(from, to, Plan, Subscription, Organization, entitlementsService));
  }
  return all;
}

async function retireOldPlans(Plan, Subscription) {
  const results = [];
  for (const planId of RETIRING_PLAN_IDS) {
    const remaining = await Subscription.countDocuments({ planId });
    if (remaining > 0) {
      results.push({ planId, retired: false, remaining });
      continue;
    }
    if (!DRY_RUN) {
      await Plan.updateOne({ planId }, { $set: { isActive: false, isPublic: false } });
    }
    results.push({ planId, retired: true, remaining: 0 });
  }
  return results;
}

/** Any subscription pointing at a planId with no Plan document silently resolves to Free. */
async function findOrphanedSubscriptions(Plan, Subscription) {
  const planIds = (await Plan.find().select('planId').lean()).map((p) => p.planId);
  const subPlanIds = await Subscription.distinct('planId');
  const orphanIds = subPlanIds.filter((p) => !planIds.includes(p));
  if (!orphanIds.length) return [];
  return Subscription.find({ planId: { $in: orphanIds } })
    .select('organization planId planName')
    .lean();
}

async function syncRazorpay(Plan) {
  const {
    hasRazorpayCredentials,
    syncPlanBillingOptions,
    needsNewRazorpayPlan,
    toAnnualLeg
  } = require('../src/services/razorpayPlanService');

  if (!hasRazorpayCredentials()) {
    return { skipped: true, reason: 'RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET not configured' };
  }

  if (SKIP_RAZORPAY) {
    return { skipped: true, reason: '--skip-razorpay passed (app-side changes only)' };
  }

  /**
   * Guard against the worst mistake this script could make: creating TEST-mode
   * Razorpay plans and writing their ids onto plan documents that real customers
   * check out against. A test plan id in a live database sends paying customers
   * into a checkout that takes no money.
   *
   * Running from a laptop with test keys against the production DB is the normal
   * way to hit this, so it is refused by default rather than warned about.
   */
  if ((process.env.RAZORPAY_KEY_ID || '').startsWith('rzp_test') && !ALLOW_TEST_RAZORPAY) {
    return {
      skipped: true,
      reason:
        'RAZORPAY_KEY_ID is a TEST key. Writing test plan ids into this database would '
        + 'break real checkouts. Re-run on the server with live keys, or pass '
        + '--allow-test-razorpay if this database is genuinely a test environment.'
    };
  }

  const results = [];
  for (const def of PLAN_DEFS) {
    if (def.price === 'custom') continue;
    const plan = await Plan.findOne({ planId: def.planId });

    // A dry run must not touch Razorpay. syncPlanBillingOptions CREATES plans at the
    // vendor, and skipping only the local save would still leave real orphaned plans
    // behind — so report intent and make no call at all.
    if (DRY_RUN) {
      // Razorpay plans are immutable, so any price change means a NEW plan is created.
      // needsNewRazorpayPlan is pure — it answers that without calling the vendor.
      const next = { planId: def.planId, ...buildPlanDoc(def) };
      const prev = plan ? plan.toObject() : null;
      results.push({
        planId: def.planId,
        monthly: needsNewRazorpayPlan(prev, next)
          ? `would CREATE new (was ${prev?.razorpayPlanId || 'none'})`
          : `reuse ${prev?.razorpayPlanId}`,
        annual: next.priceAnnual === undefined || next.priceAnnual === null || next.priceAnnual === ''
          ? 'n/a (no annual price)'
          : needsNewRazorpayPlan(prev ? toAnnualLeg(prev) : null, toAnnualLeg(next))
            ? `would CREATE new (was ${prev?.razorpayPlanIdAnnual || 'none'})`
            : `reuse ${prev?.razorpayPlanIdAnnual}`
      });
      continue;
    }

    if (!plan) continue;
    try {
      const sync = await syncPlanBillingOptions(plan, plan);
      {
        plan.razorpayPlanId = sync.monthly.razorpayPlanId || undefined;
        plan.priceInr = sync.monthly.priceInr || undefined;
        plan.razorpayPlanIdAnnual = sync.annual.razorpayPlanId || undefined;
        plan.priceAnnualInr = sync.annual.priceInr || undefined;
        await plan.save();
      }
      results.push({
        planId: def.planId,
        monthly: sync.monthly.razorpayPlanId,
        annual: sync.annual.razorpayPlanId
      });
    } catch (e) {
      results.push({ planId: def.planId, error: e.message });
    }
  }
  return { skipped: false, results };
}

/**
 * Move live Razorpay subscriptions onto the new plan at the end of the current cycle.
 * Opt-in only — this changes what customers are actually charged.
 */
async function fixRazorpaySubscriptions(Plan, Subscription) {
  const razorpay = require('../src/config/razorpay');

  // Same reasoning as syncRazorpay: a test-mode client cannot meaningfully reschedule
  // live subscriptions, and a half-applied billing change is worse than none.
  if ((process.env.RAZORPAY_KEY_ID || '').startsWith('rzp_test') && !ALLOW_TEST_RAZORPAY) {
    return { skipped: true, reason: 'RAZORPAY_KEY_ID is a TEST key — refusing to reschedule subscriptions.' };
  }

  const target = await Plan.findOne({ planId: MIGRATION_TARGET_PLAN_ID }).lean();
  if (!target?.razorpayPlanId) {
    return { skipped: true, reason: `${MIGRATION_TARGET_PLAN_ID} has no razorpayPlanId yet` };
  }

  const subs = await Subscription.find({
    planId: MIGRATION_TARGET_PLAN_ID,
    razorpaySubscriptionId: { $nin: [null, ''] }
  }).select('_id organization razorpaySubscriptionId').lean();

  const results = [];
  for (const sub of subs) {
    try {
      if (!DRY_RUN) {
        await razorpay.subscriptions.update(sub.razorpaySubscriptionId, {
          plan_id: target.razorpayPlanId,
          schedule_change_at: 'cycle_end'
        });
      }
      results.push({ organization: String(sub.organization), status: DRY_RUN ? 'would update' : 'scheduled at cycle end' });
    } catch (e) {
      results.push({ organization: String(sub.organization), error: e?.error?.description || e.message });
    }
  }
  return { skipped: false, results };
}

(async () => {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('MONGODB_URI not set');
    process.exit(1);
  }
  await mongoose.connect(uri);

  const Plan = require('../src/models/Plan');
  const Subscription = require('../src/models/Subscription');
  const Organization = require('../src/models/Organization');
  const entitlementsService = require('../src/services/entitlementsService');

  console.log(`\n=== 2026 pricing sheet seed ${DRY_RUN ? '(DRY RUN — no writes)' : ''} ===\n`);

  console.log('1. Upserting plans…');
  for (const row of await upsertPlans(Plan)) {
    console.log(`   ${row.planId.padEnd(12)} ${row.action}`);
  }

  console.log('\n2. Patching off-sheet plans (free / demo)…');
  const patched = await patchOffSheetPlans(Plan);
  console.log(`   free: ${DRY_RUN ? 'would patch' : `${patched.free} modified`} (also isPublic=false)`);
  if (patched.freeNestedRemoved) {
    console.log(`   free: removed ${patched.freeNestedRemoved} nested key(s) left by a dotted $set`);
  }
  if (patched.demoNeedsReseed) {
    console.log('   demo: re-run `node src/scripts/seedDemoPlan.js` to pick up the new enum/list keys');
  }

  const orphansBefore = await findOrphanedSubscriptions(Plan, Subscription);
  if (orphansBefore.length) {
    console.log('\n!  Orphaned subscriptions found (planId with no Plan document).');
    console.log('   These orgs currently resolve to FREE-tier entitlements:');
    for (const o of orphansBefore) {
      console.log(`   org ${String(o.organization)}  planId="${o.planId}" (${o.planName || '—'})`);
    }
  }

  console.log('\n3. Migrating subscriptions onto the new lineup…');
  const migration = await migrateAllPlans(Plan, Subscription, Organization, entitlementsService);
  if (!migration.length) {
    console.log('   nothing to migrate');
  } else {
    for (const r of migration) {
      console.log(`   org ${r.organization}  ${r.from} → ${r.to}  rzpSub=${r.razorpaySubscriptionId || '—'}`);
    }
  }

  console.log('\n4. Retiring superseded plans…');
  for (const r of await retireOldPlans(Plan, Subscription)) {
    console.log(r.retired
      ? `   ${r.planId}: retired (isActive=false, isPublic=false)`
      : `   ${r.planId}: left active — ${r.remaining} subscription(s) still reference it`);
  }

  console.log('\n5. Razorpay plan sync…');
  const rzp = await syncRazorpay(Plan);
  if (rzp.skipped) {
    console.log(`   skipped: ${rzp.reason}`);
  } else {
    for (const r of rzp.results) {
      console.log(r.error
        ? `   ${r.planId.padEnd(12)} ERROR ${r.error}`
        : `   ${r.planId.padEnd(12)} monthly=${r.monthly || '—'} annual=${r.annual || '—'}`);
    }
  }

  if (FIX_RAZORPAY) {
    console.log('\n6. Moving live Razorpay subscriptions to the new plan (cycle end)…');
    const fixed = await fixRazorpaySubscriptions(Plan, Subscription);
    if (fixed.skipped) {
      console.log(`   skipped: ${fixed.reason}`);
    } else {
      for (const r of fixed.results) {
        console.log(`   org ${r.organization}: ${r.error ? `ERROR ${r.error}` : r.status}`);
      }
    }
  } else if (migration.length) {
    console.log('\n6. Live Razorpay subscriptions NOT touched.');
    console.log(`   ${migration.length} org(s) are still billed on the old plan's Razorpay amount.`);
    console.log('   Review the report above, then re-run with --fix-razorpay to reschedule them.');
  }

  const counts = await Subscription.aggregate([{ $group: { _id: '$planId', n: { $sum: 1 } } }, { $sort: { _id: 1 } }]);
  console.log('\nSubscriptions by plan:');
  for (const c of counts) console.log(`   ${String(c._id).padEnd(12)} ${c.n}`);

  await mongoose.disconnect();
  console.log(`\nDone.${DRY_RUN ? ' (dry run — nothing was written)' : ''}\n`);
  process.exit(0);
})().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
