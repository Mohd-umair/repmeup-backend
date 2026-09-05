/**
 * Setup Razorpay Plans (backfill)
 *
 * Creates a Razorpay Plan for each paid plan in the database that is missing
 * razorpayPlanId, using the shared razorpayPlanService.
 *
 * Run once (or whenever you add a new paid plan outside the admin UI):
 *   node scripts/setup-razorpay-plans.js
 *
 * Safe to re-run — skips plans that already have a razorpayPlanId.
 */

require('dotenv').config();
const mongoose = require('mongoose');
const Plan = require('../src/models/Plan');
const {
  syncPlanWithRazorpay,
  hasRazorpayCredentials,
  isPaidBillablePlan,
  extractRzpError
} = require('../src/services/razorpayPlanService');

async function connectDB() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('MongoDB connected');
}

async function main() {
  if (!hasRazorpayCredentials()) {
    console.error('RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET must be set in .env');
    process.exit(1);
  }

  await connectDB();

  const plans = await Plan.find({ isActive: true }).sort({ tier: 1 });
  const paidPlans = plans.filter(isPaidBillablePlan);

  if (paidPlans.length === 0) {
    console.log('No paid billable plans found in database.');
    process.exit(0);
  }

  console.log(`\nFound ${paidPlans.length} paid plan(s):\n`);

  for (const plan of paidPlans) {
    if (plan.razorpayPlanId) {
      console.log(`"${plan.name}" already linked → ${plan.razorpayPlanId} (skipping)`);
      continue;
    }

    try {
      console.log(`Creating Razorpay plan for "${plan.name}"...`);
      const sync = await syncPlanWithRazorpay(plan, null);
      plan.razorpayPlanId = sync.razorpayPlanId;
      plan.priceInr = sync.priceInr;
      await plan.save();
      console.log(`   Created: ${sync.razorpayPlanId}`);
      console.log(`   Amount:  ${sync.priceInr} paise\n`);
    } catch (err) {
      console.error(`   Failed for "${plan.name}":`, extractRzpError(err));
    }
  }

  console.log('\nDone. Paid plans should now have Razorpay plan IDs.\n');
  process.exit(0);
}

main().catch((err) => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
