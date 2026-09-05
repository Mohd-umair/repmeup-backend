/**
 * One-time migration: set paid plan `price` (INR rupees) and `priceInr` (paise) for Razorpay.
 * Safe to re-run — overwrites known planIds only.
 *
 *   npm run migrate:plans-inr
 *
 * Matches defaults in scripts/seedPlans.js and scripts/setup-razorpay-plans.js.
 */
require('dotenv').config();
const mongoose = require('mongoose');
const Plan = require('../src/models/Plan');

const INR_BY_PLAN_ID = {
  starter: { price: 2499, priceInr: 249900 },
  pro: { price: 6599, priceInr: 659900 },
  business: { price: 16499, priceInr: 1649900 }
};

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('Missing MONGODB_URI');
    process.exit(1);
  }
  await mongoose.connect(uri);
  console.log('Connected. Updating plans…\n');

  for (const [planId, vals] of Object.entries(INR_BY_PLAN_ID)) {
    const res = await Plan.updateOne(
      { planId },
      { $set: { price: vals.price, priceInr: vals.priceInr } }
    );
    console.log(`  ${planId}: matched ${res.matchedCount}, modified ${res.modifiedCount}`);
  }

  await mongoose.disconnect();
  console.log('\nDone. Re-run setup-razorpay-plans if Razorpay plan amounts must stay in sync.');
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
