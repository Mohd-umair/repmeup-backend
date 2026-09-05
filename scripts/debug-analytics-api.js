/**
 * debug-analytics-api.js
 * Directly tests the analytics service (same as controller, bypassing HTTP)
 * Run: node scripts/debug-analytics-api.js
 */

require('dotenv').config();
const mongoose = require('mongoose');
const analyticsService = require('../src/services/analyticsService');

async function run() {
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
  await mongoose.connect(uri);
  console.log('✅ Connected to:', mongoose.connection.host);

  // Mirror exactly what the controller does
  const endDate   = new Date();
  endDate.setSeconds(0, 0); // roundToMinute
  const startDate = new Date(endDate.getTime() - 30 * 24 * 60 * 60 * 1000);

  console.log('\n📅 Date range:', startDate.toISOString(), '→', endDate.toISOString());

  // Get all orgs that have interactions
  const Interaction = require('../src/models/Interaction');
  const orgs = await Interaction.distinct('organization');
  console.log(`🏢 Orgs with interactions: ${orgs.length}\n`);

  for (const orgId of orgs) {
    console.log('─'.repeat(60));
    console.log('Testing org:', String(orgId));

    try {
      const dashboard = await analyticsService.getDashboardData(
        orgId,
        { startDate, endDate },
        { preset: '30days' }
      );

      console.log('✅ API Response shape:');
      console.log('  totalInteractions:', dashboard.overview?.totalInteractions?.value);
      console.log('  responseRate:', dashboard.overview?.responseRate?.value);
      console.log('  timeSeries.length:', dashboard.timeSeries?.length);
      console.log('  timeSeries[0..2]:', JSON.stringify(dashboard.timeSeries?.slice(0, 3)));
      console.log('  sentimentBreakdown:', JSON.stringify(dashboard.sentimentBreakdown));
      console.log('  aiVsHuman:', JSON.stringify(dashboard.aiVsHuman));
      console.log('  platformMetrics.length:', dashboard.platformMetrics?.length);
      console.log('  intentBreakdown.total:', dashboard.intentBreakdown?.total);
    } catch (err) {
      console.error('❌ getDashboardData failed:', err.message);
    }
  }

  await mongoose.disconnect();
  console.log('\n✅ Done');
}

run().catch(err => {
  console.error('❌ Error:', err.message);
  process.exit(1);
});
