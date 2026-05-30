/**
 * Backfill Interaction.respondedAt / firstResponseTime from ProductOrder rows
 * (comment-to-DM flows that responded without updating the Interaction doc).
 *
 * Run: node scripts/backfill-interaction-response-times.js
 */
require('dotenv').config();
const mongoose = require('mongoose');
const Interaction = require('../src/models/Interaction');
const ProductOrder = require('../src/models/ProductOrder');

async function run() {
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!uri) throw new Error('MONGODB_URI is not set');

  await mongoose.connect(uri);
  console.log('Connected to MongoDB');

  const orders = await ProductOrder.find({
    commentInteractionId: { $exists: true, $ne: null },
    status: { $nin: ['cancelled'] }
  })
    .select('commentInteractionId organization createdAt')
    .lean();

  let updated = 0;
  let skipped = 0;

  for (const order of orders) {
    const interaction = await Interaction.findOne({
      _id: order.commentInteractionId,
      organization: order.organization,
      respondedAt: null
    }).select('platformCreatedAt createdAt replies respondedAt').lean();

    if (!interaction) {
      skipped += 1;
      continue;
    }
    if ((interaction.replies || []).length > 0) {
      skipped += 1;
      continue;
    }

    const platformAt = interaction.platformCreatedAt || interaction.createdAt;
    const respondedAt = order.createdAt || new Date();
    const update = {
      respondedAt,
      status: 'replied'
    };
    if (platformAt) {
      update.firstResponseTime = new Date(respondedAt).getTime() - new Date(platformAt).getTime();
    }

    await Interaction.updateOne({ _id: interaction._id }, { $set: update });
    updated += 1;
  }

  console.log(`Backfill complete. Updated: ${updated}, skipped: ${skipped}`);
  await mongoose.disconnect();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
