/**
 * Add 'shopify' to channels.allowed on every active Plan, then bust entitlements cache.
 *
 * Run after deploying Shopify integration so existing orgs can connect without
 * re-seeding the full pricing sheet:
 *
 *   node backend/scripts/patchShopifyChannel.js
 *   node backend/scripts/patchShopifyChannel.js --dry-run
 */
require('dotenv').config();
const mongoose = require('mongoose');
const Plan = require('../src/models/Plan');
const cacheService = require('../src/services/cacheService');
const { FEATURE_KEYS } = require('../src/config/featureCatalog');

const CHANNEL_KEY = FEATURE_KEYS.CHANNELS_ALLOWED;
const DRY_RUN = process.argv.includes('--dry-run');

function readChannels(entitlements) {
  const raw = entitlements?.[CHANNEL_KEY];
  if (!raw) return [];
  if (Array.isArray(raw.value)) return raw.value;
  if (Array.isArray(raw)) return raw;
  return [];
}

async function main() {
  if (!process.env.MONGODB_URI) {
    console.error('MONGODB_URI is not set');
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGODB_URI);
  console.log('Connected to MongoDB');

  const plans = await Plan.find({}).select('planId name entitlements isActive').lean();
  let patched = 0;

  for (const plan of plans) {
    const entitlements = plan.entitlements && typeof plan.entitlements === 'object'
      ? { ...plan.entitlements }
      : {};
    const channels = readChannels(entitlements);

    if (channels.includes('shopify')) {
      console.log(`  skip ${plan.planId} — shopify already allowed`);
      continue;
    }

    const next = [...channels, 'shopify'];
    entitlements[CHANNEL_KEY] = { value: next };

    console.log(`  patch ${plan.planId} (${plan.name || 'unnamed'}): [${channels.join(', ')}] → [${next.join(', ')}]`);

    if (!DRY_RUN) {
      await Plan.updateOne({ _id: plan._id }, { $set: { entitlements } });
    }
    patched += 1;
  }

  if (!DRY_RUN && patched > 0) {
    const cleared = await cacheService.delPattern('entitlements:*');
    console.log(`Cleared ${cleared} entitlements cache key(s)`);
  }

  console.log(DRY_RUN
    ? `\nDry run complete — ${patched} plan(s) would be patched`
    : `\nDone — patched ${patched} plan(s)`);

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
