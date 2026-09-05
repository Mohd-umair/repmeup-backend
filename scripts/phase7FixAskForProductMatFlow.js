/**
 * Phase 7 — immediate mitigation for the specific flow diagnosed in Phase 0.
 *
 * Flow "ask for Product- Mat" (org 69e117559f8545939fd331e3) was the confirmed source of
 * the reported 6-10x duplicate replies. Root cause (NOT a webhook race — confirmed via
 * live enrollment history): its `wait.user_reply` node had `timeoutSec: 5` (customer had
 * only 5 SECONDS to reply before the flow "gave up" and completed), combined with very
 * broad single-word keywords (want/need/help/product/price/schedule/detail) and no
 * frequency cap — so almost any later message from the same contact re-matched a keyword
 * and re-ran the whole flow from the top.
 *
 * This script (confirmed with the customer):
 *   1. Sets the wait node's timeoutSec to 300 (5 minutes) instead of 5 seconds.
 *   2. Sets settings.frequencyCap = 1 / frequencyCapWindowDays = 1, so this flow can
 *      enroll the same contact at most once per 24 hours regardless of how many times
 *      their messages match a keyword.
 *
 * Usage: node backend/scripts/phase7FixAskForProductMatFlow.js
 *        node backend/scripts/phase7FixAskForProductMatFlow.js --dry-run
 */
require('dotenv').config();
const mongoose = require('mongoose');
const AutomationFlow = require('../src/models/AutomationFlow');

const FLOW_ID = '6a9bed22b66735af411d67a4';
const DRY_RUN = process.argv.includes('--dry-run');

async function main() {
  if (!process.env.MONGODB_URI) {
    console.error('MONGODB_URI is not set');
    process.exit(1);
  }
  await mongoose.connect(process.env.MONGODB_URI);

  const flow = await AutomationFlow.findById(FLOW_ID);
  if (!flow) {
    console.error(`Flow ${FLOW_ID} not found`);
    process.exit(1);
  }

  console.log(`[phase7] Flow: "${flow.name}" (org ${flow.organization})`);
  console.log('[phase7] BEFORE settings:', JSON.stringify(flow.settings));

  const waitNode = flow.nodes.find((n) => n.type === 'wait.user_reply');
  if (!waitNode) {
    console.error('[phase7] No wait.user_reply node found — aborting, nothing changed.');
    process.exit(1);
  }
  console.log('[phase7] BEFORE wait node timeoutSec:', waitNode.config?.timeoutSec);

  if (DRY_RUN) {
    console.log('[phase7] --dry-run: would set timeoutSec=300, frequencyCap=1, frequencyCapWindowDays=1. No changes made.');
    await mongoose.disconnect();
    return;
  }

  waitNode.config.timeoutSec = 300; // 5 minutes (was 5 seconds)
  flow.settings.frequencyCap = 1;
  flow.settings.frequencyCapWindowDays = 1; // 1 enrollment per contact per 24h
  flow.markModified('nodes');
  flow.markModified('settings');
  await flow.save();

  const reloaded = await AutomationFlow.findById(FLOW_ID).lean();
  console.log('[phase7] AFTER settings:', JSON.stringify(reloaded.settings));
  console.log('[phase7] AFTER wait node timeoutSec:', reloaded.nodes.find((n) => n.type === 'wait.user_reply')?.config?.timeoutSec);

  await mongoose.disconnect();
  console.log('[phase7] done');
}

main().catch((err) => {
  console.error('[phase7] error', err);
  process.exit(1);
});
