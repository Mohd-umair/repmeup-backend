require('dotenv').config();
const mongoose = require('mongoose');
const Plan = require('../src/models/Plan');
const Subscription = require('../src/models/Subscription');

async function updatePlansWithAICredits() {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ Connected to MongoDB');

    // Update each plan with AI credit limits
    const planUpdates = [
      { planId: 'free', maxAICreditsPerMonth: 100 },
      { planId: 'starter', maxAICreditsPerMonth: 500 },
      { planId: 'pro', maxAICreditsPerMonth: 2000 },
      { planId: 'business', maxAICreditsPerMonth: 10000 },
      { planId: 'enterprise', maxAICreditsPerMonth: -1 }
    ];

    console.log('\n📝 Updating plans with AI credits...');
    for (const update of planUpdates) {
      const result = await Plan.updateOne(
        { planId: update.planId },
        { $set: { 'limits.maxAICreditsPerMonth': update.maxAICreditsPerMonth } }
      );
      console.log(`  ✅ ${update.planId}: ${update.maxAICreditsPerMonth} credits/month (${result.modifiedCount} updated)`);
    }

    // Now update all subscriptions to match their plan's limits
    console.log('\n📝 Updating subscriptions with AI credit limits...');
    
    const subscriptions = await Subscription.find({});
    console.log(`Found ${subscriptions.length} subscriptions to update`);

    for (const subscription of subscriptions) {
      const plan = await Plan.findOne({ planId: subscription.planId });
      
      if (!plan) {
        console.log(`  ⚠️  No plan found for subscription with planId: ${subscription.planId}`);
        continue;
      }

      // Update subscription limits to match plan
      subscription.limits.maxAICreditsPerMonth = plan.limits.maxAICreditsPerMonth;
      
      // Ensure usage field exists
      if (!subscription.usage.aiCreditsThisMonth) {
        subscription.usage.aiCreditsThisMonth = 0;
      }

      await subscription.save();
      
      console.log(`  ✅ Org ${subscription.organization}: ${plan.planId} plan, ${plan.limits.maxAICreditsPerMonth} credits/month`);
    }

    // Verify the problematic organization
    console.log('\n🔍 Checking specific organization: 69864350c54ce899bcbbf832');
    const problemSub = await Subscription.findOne({ organization: '69864350c54ce899bcbbf832' });
    if (problemSub) {
      console.log('  Plan:', problemSub.planName);
      console.log('  AI Credits Limit:', problemSub.limits.maxAICreditsPerMonth);
      console.log('  AI Credits Usage:', problemSub.usage.aiCreditsThisMonth);
    } else {
      console.log('  ❌ No subscription found!');
    }

    console.log('\n✅ Migration complete!');
    process.exit(0);
  } catch (error) {
    console.error('❌ Error:', error);
    process.exit(1);
  }
}

updatePlansWithAICredits();
