/**
 * Setup Razorpay Plans
 *
 * Creates a Razorpay Plan for each paid plan in the database and saves
 * the resulting razorpayPlanId back to the Plan document.
 *
 * Run once (or whenever you add a new paid plan):
 *   node scripts/setup-razorpay-plans.js
 *
 * Safe to re-run — skips plans that already have a razorpayPlanId.
 *
 * INR pricing (edit amounts to match Plan.price in rupees × 100 = paise):
 *   starter  $29  → ₹2499  (249900 paise)
 *   pro      $79  → ₹6599  (659900 paise)
 *   business $199 → ₹16499 (1649900 paise)
 */

require('dotenv').config();
const mongoose = require('mongoose');
const Razorpay = require('razorpay');
const Plan = require('../src/models/Plan');

// ─── INR prices in paise (1 INR = 100 paise) ────────────────────────────────
// Edit these values to match your desired INR pricing
const INR_PRICES = {
  starter:  249900,   // ₹2,499/mo
  pro:      659900,   // ₹6,599/mo
  business: 1649900   // ₹16,499/mo
};

// ─── DB Connection ───────────────────────────────────────────────────────────
async function connectDB() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('✅ MongoDB connected');
}

// ─── Main ────────────────────────────────────────────────────────────────────
async function main() {
  if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) {
    console.error('❌ RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET must be set in .env');
    process.exit(1);
  }

  const rzp = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET
  });

  await connectDB();

  // Get all paid plans (price is a number > 0)
  const plans = await Plan.find({ isActive: true }).sort({ tier: 1 });
  const paidPlans = plans.filter(p => typeof p.price === 'number' && p.price > 0);

  if (paidPlans.length === 0) {
    console.log('⚠️  No paid plans found in database. Run seed:plans first.');
    process.exit(0);
  }

  console.log(`\n📋 Found ${paidPlans.length} paid plan(s):\n`);

  for (const plan of paidPlans) {
    const priceInr = INR_PRICES[plan.planId];

    if (!priceInr) {
      console.log(`⚠️  Skipping "${plan.name}" — no INR price defined in INR_PRICES map.`);
      continue;
    }

    if (plan.razorpayPlanId) {
      console.log(`✅ "${plan.name}" already linked → ${plan.razorpayPlanId} (skipping)`);
      continue;
    }

    try {
      console.log(`🔄 Creating Razorpay plan for "${plan.name}" (₹${priceInr / 100}/mo)...`);

      const rzpPlan = await rzp.plans.create({
        period: 'monthly',
        interval: 1,
        item: {
          name: `RepMeUp ${plan.name} Plan`,
          amount: priceInr,
          currency: 'INR',
          description: `RepMeUp ${plan.name} — monthly subscription`
        },
        notes: {
          planId: plan.planId,
          planName: plan.name,
          tier: String(plan.tier)
        }
      });

      // Save back to our Plan document
      plan.razorpayPlanId = rzpPlan.id;
      plan.priceInr = priceInr;
      await plan.save();

      console.log(`   ✅ Created: ${rzpPlan.id}`);
      console.log(`   💰 Amount:  ₹${priceInr / 100}/mo`);
      console.log(`   🔗 Saved razorpayPlanId to DB\n`);
    } catch (err) {
      console.error(`   ❌ Failed for "${plan.name}":`, err.error?.description || err.message);
    }
  }

  console.log('\n🎉 Done! All paid plans are now configured for Razorpay billing.');
  console.log('\n📝 Next: set your real RAZORPAY_KEY_ID in environment.ts on the frontend,');
  console.log('   then test the checkout flow from the Plans & Billing page.\n');

  process.exit(0);
}

main().catch(err => {
  console.error('❌ Fatal error:', err.message);
  process.exit(1);
});
