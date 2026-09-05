#!/usr/bin/env node
/**
 * Staged campaign load test helper (Phase 0).
 *
 * Usage:
 *   node scripts/stagedCampaignLoadTest.js --orgId=<id> --campaignId=<id>
 *   node scripts/stagedCampaignLoadTest.js --metrics-only
 *
 * Prints queue depths + Redis metrics. Does NOT send messages — use the app UI
 * to launch campaigns at 500 → 5k → 20k recipient tiers while monitoring.
 */
require('dotenv').config();
const connectDB = require('../src/config/database');
const { connectRedis } = require('../src/config/redis');
const campaignMetrics = require('../src/services/campaignMetricsService');

async function main() {
  const metricsOnly = process.argv.includes('--metrics-only');

  await connectDB();
  await connectRedis();

  const snapshot = await campaignMetrics.getSnapshot();

  console.log('\n=== Campaign ops snapshot ===');
  console.log(JSON.stringify(snapshot, null, 2));

  if (metricsOnly) {
    process.exit(0);
  }

  console.log('\n=== Staged load test checklist ===');
  console.log('1. Ensure worker.js AND campaignWorker.js are running (or ENABLE_CAMPAIGN_IN_CORE_WORKER=true locally)');
  console.log('2. Bull Board: http://localhost:3000/admin/queues (campaign-send, campaign-inbox, webhook-processing)');
  console.log('3. Super-admin metrics: GET /api/super-admin/campaign-metrics');
  console.log('4. Launch test campaigns: 500 → 5k → 20k recipients per org');
  console.log('5. Watch meta429Today, queue depths, and MongoDB connection count');
  console.log('6. Production: pm2 start ecosystem.medium.config.js --env production (includes orm-campaign-worker)\n');

  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
