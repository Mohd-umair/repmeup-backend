/**
 * Backfill: move existing demo workspaces onto the full-access 'demo' plan.
 *
 * Demos created before the dedicated demo plan existed mirror a real tier plan
 * (e.g. Enterprise) which may have some features disabled. This repoints every
 * non-converted demo Subscription to the 'demo' plan and refreshes the legacy
 * limits view + the org's embedded plan, then invalidates entitlements.
 *
 * Idempotent. Run after seedDemoPlan.js:
 *   node src/scripts/seedDemoPlan.js
 *   node src/scripts/backfillDemoPlan.js
 */
require('dotenv').config();
const mongoose = require('mongoose');

(async () => {
  const uri = process.env.MONGODB_URI;
  if (!uri) { console.error('MONGODB_URI not set'); process.exit(1); }
  await mongoose.connect(uri);

  const Plan = require('../models/Plan');
  const Subscription = require('../models/Subscription');
  const Organization = require('../models/Organization');
  const entitlementsService = require('../services/entitlementsService');

  const demoPlan = await Plan.findOne({ planId: 'demo', isActive: true }).lean();
  if (!demoPlan) {
    console.error("No active 'demo' plan found. Run: node src/scripts/seedDemoPlan.js first.");
    process.exit(1);
  }

  // Only non-converted demos (converted = already a paid customer, leave alone).
  const demos = await Subscription.find({
    isDemo: true,
    demoStatus: { $ne: 'converted' }
  }).select('_id organization planId').lean();

  console.log(`Found ${demos.length} demo subscription(s) to backfill.`);
  let moved = 0;

  for (const sub of demos) {
    if (sub.planId === 'demo') continue; // already on the demo plan
    try {
      await Subscription.updateOne(
        { _id: sub._id },
        {
          $set: {
            planId: demoPlan.planId,
            planName: demoPlan.name,
            tier: demoPlan.tier,
            limits: demoPlan.limits,
            features: demoPlan.features
          },
          $push: {
            planHistory: {
              planId: sub.planId,
              planName: sub.planId,
              changedAt: new Date(),
              reason: 'demo_plan_backfill'
            }
          }
        }
      );
      // Keep the org's embedded (legacy) plan in sync.
      await Organization.updateOne(
        { _id: sub.organization },
        { $set: { 'subscription.plan': 'demo' } }
      );
      try { await entitlementsService.invalidateEntitlements(sub.organization); } catch (_) { /* non-fatal */ }
      moved++;
    } catch (err) {
      console.warn(`  ! failed for org ${sub.organization}: ${err.message}`);
    }
  }

  console.log(`✅ Backfill complete: ${moved} demo workspace(s) moved to the demo plan.`);
  await mongoose.disconnect();
  process.exit(0);
})().catch((e) => {
  console.error('backfillDemoPlan failed:', e.message);
  process.exit(1);
});
