/**
 * Reconcile the AI-conversation usage bucket against the window ledger.
 *
 * `credits.aiConversations.monthly` is an incrementing bucket (fast, on the hot path);
 * AiConversationWindow is the durable record of what was actually charged. They should
 * agree. A drift means a consume() succeeded while the window write failed, or vice
 * versa — worth knowing before a customer notices.
 *
 * Read-only by default. `--fix` rewrites each drifted bucket to the ledger count,
 * which is the authoritative side.
 *
 *   node scripts/reconcileAiConversations.js
 *   node scripts/reconcileAiConversations.js --fix
 *   node scripts/reconcileAiConversations.js --month 2026-07
 */
require('dotenv').config();
const mongoose = require('mongoose');

const FIX = process.argv.includes('--fix');
const monthArgIndex = process.argv.indexOf('--month');
const MONTH_ARG = monthArgIndex > -1 ? process.argv[monthArgIndex + 1] : null;

(async () => {
  const uri = process.env.MONGODB_URI;
  if (!uri) { console.error('MONGODB_URI not set'); process.exit(1); }
  await mongoose.connect(uri);

  const Subscription = require('../src/models/Subscription');
  const AiConversationWindow = require('../src/models/AiConversationWindow');
  const bucketService = require('../src/services/bucketService');
  const entitlementsService = require('../src/services/entitlementsService');
  const { monthKeyUTC } = require('../src/services/creditPeriodService');
  const { FEATURE_KEYS } = require('../src/config/featureCatalog');

  const periodMonthKey = MONTH_ARG || monthKeyUTC(new Date());
  console.log(`\nReconciling AI conversations for ${periodMonthKey}${FIX ? ' (--fix)' : ' (read-only)'}\n`);

  // Charged windows per org for the period — the authoritative side.
  const ledger = await AiConversationWindow.aggregate([
    { $match: { periodMonthKey, charged: true } },
    { $group: { _id: '$organization', windows: { $sum: 1 } } }
  ]);
  const ledgerByOrg = new Map(ledger.map((r) => [String(r._id), r.windows]));

  const subs = await Subscription.find({}).select('organization planId').lean();
  let checked = 0;
  let drifted = 0;
  let fixed = 0;

  for (const sub of subs) {
    const orgId = String(sub.organization);
    const expected = ledgerByOrg.get(orgId) || 0;
    const bucket = await bucketService.getBucket(orgId, FEATURE_KEYS.CREDITS_AI_CONVERSATIONS);
    const actual = bucket.used || 0;
    checked += 1;

    // Only report orgs that have activity on either side.
    if (expected === 0 && actual === 0) continue;
    if (expected === actual) continue;

    drifted += 1;
    console.log(`  org ${orgId} (${sub.planId}): bucket=${actual} ledger=${expected} drift=${actual - expected}`);

    if (FIX) {
      await bucketService.reset(orgId, FEATURE_KEYS.CREDITS_AI_CONVERSATIONS);
      if (expected > 0) {
        await bucketService.consume(orgId, FEATURE_KEYS.CREDITS_AI_CONVERSATIONS, expected);
      }
      await entitlementsService.invalidateEntitlements(orgId);
      fixed += 1;
    }
  }

  console.log(`\nChecked ${checked} subscription(s) · ${drifted} drifted${FIX ? ` · ${fixed} corrected` : ''}`);
  if (drifted && !FIX) console.log('Re-run with --fix to align the buckets to the ledger.\n');

  await mongoose.disconnect();
  process.exit(0);
})().catch((err) => {
  console.error('Reconcile failed:', err);
  process.exit(1);
});
