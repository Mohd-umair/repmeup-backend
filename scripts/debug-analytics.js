/**
 * debug-analytics.js
 * Run: node scripts/debug-analytics.js
 * Shows: exactly what the analytics aggregations return for each org
 */

require('dotenv').config();
const mongoose = require('mongoose');
const Interaction = require('../src/models/Interaction');

async function run() {
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
  await mongoose.connect(uri);
  console.log('✅ Connected to:', mongoose.connection.host);

  const endDate   = new Date();
  const startDate = new Date(endDate.getTime() - 30 * 24 * 60 * 60 * 1000);

  console.log('\n📅 Date range:', startDate.toISOString(), '→', endDate.toISOString());

  // ── 1. All distinct orgs in Interaction collection ──────────────────────
  const orgs = await Interaction.distinct('organization');
  console.log(`\n🏢 Found ${orgs.length} organization(s) with interactions\n`);

  for (const orgId of orgs) {
    const matchFilter = {
      organization: orgId,
      platformCreatedAt: { $gte: startDate, $lte: endDate },
    };

    const total = await Interaction.countDocuments(matchFilter);
    const totalAll = await Interaction.countDocuments({ organization: orgId });

    // Sample: check platformCreatedAt field values
    const sample = await Interaction
      .find({ organization: orgId })
      .sort({ createdAt: -1 })
      .limit(5)
      .select('platformCreatedAt createdAt platform status sentiment replies')
      .lean();

    const timeSeries = await Interaction.aggregate([
      { $match: matchFilter },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$platformCreatedAt' } },
          interactions: { $sum: 1 },
          responses: {
            $sum: {
              $cond: [{ $gt: [{ $size: { $ifNull: ['$replies', []] } }, 0] }, 1, 0],
            },
          },
        },
      },
      { $sort: { _id: 1 } },
      { $project: { date: '$_id', interactions: 1, responses: 1, _id: 0 } },
    ]);

    console.log('─'.repeat(60));
    console.log(`Org: ${orgId}`);
    console.log(`  Total interactions (all time):     ${totalAll}`);
    console.log(`  Total interactions (last 30 days): ${total}`);
    console.log(`  Time series rows:                  ${timeSeries.length}`);
    if (timeSeries.length > 0) {
      console.log('  Time series sample (first 5):');
      timeSeries.slice(0, 5).forEach(r => console.log('    ', r));
    }
    console.log('\n  Latest 5 interactions (platformCreatedAt check):');
    sample.forEach(s => {
      console.log(`    platformCreatedAt: ${s.platformCreatedAt} | createdAt: ${s.createdAt} | platform: ${s.platform} | replies: ${s.replies?.length ?? 0} | sentiment: ${s.sentiment}`);
    });

    // ── Check for interactions with null/missing platformCreatedAt ───────
    const nullPlatformDate = await Interaction.countDocuments({
      organization: orgId,
      $or: [{ platformCreatedAt: null }, { platformCreatedAt: { $exists: false } }],
    });
    if (nullPlatformDate > 0) {
      console.log(`\n  ⚠️  ${nullPlatformDate} interactions have NULL/missing platformCreatedAt!`);
    }
  }

  await mongoose.disconnect();
  console.log('\n✅ Done');
}

run().catch(err => {
  console.error('❌ Error:', err);
  process.exit(1);
});
