#!/usr/bin/env node
/**
 * Reconcile Entitlements — drift report for Organization / Subscription / Plan.
 *
 * Before `entitlementsService` became the single read path, plan limits were
 * stored in THREE places:
 *   1. Plan.limits                 — catalog (authoritative for definitions)
 *   2. Subscription.limits         — snapshot copied at upgrade time (drifts)
 *   3. Organization.limits         — legacy embedded copy (drifts + field-name mismatch)
 *
 * This script walks every org and reports:
 *   A. Orgs with NO Subscription document             → they fall back to legacy limits
 *   B. Subscriptions whose planId doesn't exist in Plan → stuck on a deleted plan
 *   C. Subscription.limits that drift from the referenced Plan.limits
 *   D. Organization.limits that drift from the referenced Plan.limits
 *
 * By default the script only reports. Pass --fix to:
 *   - Re-sync Subscription.limits from Plan.limits (for subs with a valid plan)
 *   - Invalidate the entitlements cache for every org it touches
 *
 * Usage:
 *   node scripts/reconcile-entitlements.js          # dry-run (report only)
 *   node scripts/reconcile-entitlements.js --fix    # apply fixes
 */

const mongoose = require('mongoose');
require('dotenv').config();

const Organization = require('../src/models/Organization');
const Subscription = require('../src/models/Subscription');
const Plan = require('../src/models/Plan');
const entitlementsService = require('../src/services/entitlementsService');

const APPLY_FIXES = process.argv.includes('--fix');

// Fields we compare between Subscription.limits and Plan.limits.
const COMPARED_LIMIT_FIELDS = [
  'maxAccounts',
  'maxUsers',
  'maxPostsPerMonth',
  'maxAutoRepliesPerMonth',
  'maxAICreditsPerMonth'
];

function diffLimits(a = {}, b = {}, fields = COMPARED_LIMIT_FIELDS) {
  const diffs = {};
  for (const f of fields) {
    if ((a[f] ?? null) !== (b[f] ?? null)) {
      diffs[f] = { have: a[f], expected: b[f] };
    }
  }
  return Object.keys(diffs).length ? diffs : null;
}

async function main() {
  await mongoose.connect(process.env.MONGO_URI || process.env.MONGODB_URI);
  console.log(`\n🔍 Entitlements reconciliation  (mode: ${APPLY_FIXES ? 'FIX' : 'DRY-RUN'})\n`);

  const [orgs, subs, plans] = await Promise.all([
    Organization.find({}).select('_id name limits subscription').lean(),
    Subscription.find({}).lean(),
    Plan.find({}).lean()
  ]);

  const subByOrg = new Map(subs.map((s) => [s.organization.toString(), s]));
  const planById = new Map(plans.map((p) => [p.planId, p]));

  const report = {
    orgsMissingSubscription: [],
    subsWithUnknownPlan: [],
    subLimitsDrift: [],
    orgLegacyLimitsDrift: []
  };

  let fixed = 0;

  for (const org of orgs) {
    const orgId = org._id.toString();
    const sub = subByOrg.get(orgId);

    if (!sub) {
      report.orgsMissingSubscription.push({ orgId, name: org.name });
      continue;
    }

    const plan = planById.get(sub.planId);
    if (!plan) {
      report.subsWithUnknownPlan.push({ orgId, name: org.name, planId: sub.planId });
      continue;
    }

    const subDrift = diffLimits(sub.limits, plan.limits);
    if (subDrift) {
      report.subLimitsDrift.push({
        orgId,
        name: org.name,
        planId: plan.planId,
        diffs: subDrift
      });

      if (APPLY_FIXES) {
        await Subscription.updateOne(
          { _id: sub._id },
          {
            $set: {
              limits: plan.limits,
              planName: plan.name,
              tier: plan.tier,
              features: plan.features || []
            }
          }
        );
        await entitlementsService.invalidateEntitlements(orgId);
        fixed += 1;
      }
    }

    // Legacy Organization.limits is not structurally equivalent to Plan.limits
    // (it uses maxPlatformConnections / maxInteractionsPerMonth). We only flag
    // the fields that ARE comparable so the report stays honest.
    if (org.limits) {
      const legacyDrift = {};
      if (org.limits.maxPlatformConnections !== plan.limits.maxAccounts) {
        legacyDrift.maxPlatformConnections = {
          have: org.limits.maxPlatformConnections,
          expectedFromPlanMaxAccounts: plan.limits.maxAccounts
        };
      }
      if (org.limits.maxUsers !== plan.limits.maxUsers) {
        legacyDrift.maxUsers = {
          have: org.limits.maxUsers,
          expectedFromPlanMaxUsers: plan.limits.maxUsers
        };
      }
      if (org.limits.maxAICreditsPerMonth !== plan.limits.maxAICreditsPerMonth) {
        legacyDrift.maxAICreditsPerMonth = {
          have: org.limits.maxAICreditsPerMonth,
          expectedFromPlan: plan.limits.maxAICreditsPerMonth
        };
      }
      if (Object.keys(legacyDrift).length) {
        report.orgLegacyLimitsDrift.push({
          orgId,
          name: org.name,
          planId: plan.planId,
          diffs: legacyDrift
        });
      }
    }
  }

  console.log('─'.repeat(80));
  console.log(`📋 Orgs with NO Subscription doc:        ${report.orgsMissingSubscription.length}`);
  console.log(`📋 Subs pointing at an unknown planId:   ${report.subsWithUnknownPlan.length}`);
  console.log(`📋 Subscription.limits drift vs Plan:    ${report.subLimitsDrift.length}`);
  console.log(`📋 Organization.limits drift vs Plan:    ${report.orgLegacyLimitsDrift.length}`);
  console.log('─'.repeat(80));

  if (report.orgsMissingSubscription.length) {
    console.log('\n⚠️  Orgs with no Subscription (fallback to legacy Organization.limits):');
    report.orgsMissingSubscription.slice(0, 20).forEach((o) => {
      console.log(`   • ${o.orgId}  ${o.name}`);
    });
    if (report.orgsMissingSubscription.length > 20) {
      console.log(`   … and ${report.orgsMissingSubscription.length - 20} more`);
    }
  }

  if (report.subsWithUnknownPlan.length) {
    console.log('\n⚠️  Subscriptions referencing a planId that is not in Plan collection:');
    report.subsWithUnknownPlan.forEach((s) => {
      console.log(`   • ${s.orgId}  ${s.name}  planId=${s.planId}`);
    });
  }

  if (report.subLimitsDrift.length) {
    console.log('\n⚠️  Subscription.limits drift vs Plan.limits:');
    report.subLimitsDrift.slice(0, 10).forEach((d) => {
      console.log(`   • ${d.orgId}  ${d.name}  plan=${d.planId}`);
      Object.entries(d.diffs).forEach(([k, v]) => {
        console.log(`       - ${k}: have=${v.have}  expected=${v.expected}`);
      });
    });
    if (report.subLimitsDrift.length > 10) {
      console.log(`   … and ${report.subLimitsDrift.length - 10} more`);
    }
  }

  if (report.orgLegacyLimitsDrift.length) {
    console.log('\nℹ️  Organization.limits drift vs Plan.limits (informational — legacy fields):');
    console.log(`   ${report.orgLegacyLimitsDrift.length} orgs affected. entitlementsService will`);
    console.log('   serve the correct limit from Plan automatically; these legacy fields are read');
    console.log('   only when no Subscription exists.');
  }

  if (APPLY_FIXES) {
    console.log(`\n✅ Applied fixes to ${fixed} subscription(s). Entitlements cache invalidated.`);
  } else {
    console.log('\nℹ️  Re-run with --fix to resync Subscription.limits from Plan.limits.');
  }

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error('❌ Reconciliation failed:', err);
  process.exit(1);
});
