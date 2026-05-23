/**
 * Verify Razorpay plan linkage for all paid plans in MongoDB.
 *
 * Checks each plan's razorpayPlanId against the Razorpay API (uses current
 * RAZORPAY_KEY_ID mode — test or live must match the plan IDs in DB).
 *
 *   node scripts/verify-razorpay-plans.js
 */

require('dotenv').config();
const mongoose = require('mongoose');
const razorpay = require('../src/config/razorpay');
const Plan = require('../src/models/Plan');
const { isPaidBillablePlan, extractRzpError, hasRazorpayCredentials } = require('../src/services/razorpayPlanService');

async function main() {
  if (!hasRazorpayCredentials()) {
    console.error('RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET must be set.');
    process.exit(1);
  }

  const mode = (process.env.RAZORPAY_KEY_ID || '').startsWith('rzp_live_') ? 'LIVE' : 'TEST';
  console.log(`\nRazorpay mode: ${mode} (${process.env.RAZORPAY_KEY_ID})\n`);

  await mongoose.connect(process.env.MONGODB_URI);

  const plans = await Plan.find({ isActive: true }).sort({ tier: 1 }).lean();
  let issues = 0;

  for (const plan of plans) {
    if (!isPaidBillablePlan(plan)) {
      console.log(`[skip] ${plan.planId} — not billable via Razorpay (${plan.price}/${plan.billingCycle})`);
      continue;
    }

    const rzpId = plan.razorpayPlanId;
    if (!rzpId) {
      console.log(`[MISSING] ${plan.planId} (${plan.name}) — no razorpayPlanId in DB`);
      issues++;
      continue;
    }

    if (!rzpId.startsWith('plan_')) {
      console.log(`[INVALID] ${plan.planId} — razorpayPlanId "${rzpId}" must start with plan_`);
      issues++;
      continue;
    }

    try {
      const remote = await razorpay.plans.fetch(rzpId);
      const amount = remote?.item?.amount;
      const rupees = amount != null ? (amount / 100).toFixed(2) : '?';
      console.log(`[OK] ${plan.planId} → ${rzpId} (₹${rupees}/${remote?.period || '?'})`);
    } catch (err) {
      console.log(`[NOT FOUND] ${plan.planId} → ${rzpId}`);
      console.log(`         ${extractRzpError(err)}`);
      console.log(`         Fix: update Plan.razorpayPlanId in MongoDB or re-save plan in admin.\n`);
      issues++;
    }
  }

  await mongoose.disconnect();

  if (issues > 0) {
    console.log(`\n${issues} issue(s) found. Plan IDs must exist in Razorpay ${mode} mode.\n`);
    process.exit(1);
  }

  console.log('\nAll paid plans are linked to valid Razorpay plans.\n');
  process.exit(0);
}

main().catch((err) => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
