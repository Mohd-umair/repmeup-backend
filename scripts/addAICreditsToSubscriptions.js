const mongoose = require('mongoose');
const Subscription = require('../src/models/Subscription');

// Load environment variables
require('dotenv').config();

// MongoDB connection
const MONGODB_URI = process.env.MONGODB_URI;

/**
 * Add aiCreditsThisMonth field to existing subscriptions
 */
async function addAICreditsToSubscriptions() {
  try {
    console.log('🔌 Connecting to MongoDB...');
    await mongoose.connect(MONGODB_URI);
    console.log('✅ Connected to MongoDB');

    // Update all subscriptions that don't have aiCreditsThisMonth
    const result = await Subscription.updateMany(
      { 'usage.aiCreditsThisMonth': { $exists: false } },
      { 
        $set: { 
          'usage.aiCreditsThisMonth': 0 
        } 
      }
    );

    console.log(`✅ Updated ${result.modifiedCount} subscriptions with aiCreditsThisMonth field`);

    // Also update subscriptions that don't have maxAICreditsPerMonth in limits
    const result2 = await Subscription.updateMany(
      { 'limits.maxAICreditsPerMonth': { $exists: false } },
      { 
        $set: { 
          'limits.maxAICreditsPerMonth': 500  // Default to 500 credits
        } 
      }
    );

    console.log(`✅ Updated ${result2.modifiedCount} subscriptions with maxAICreditsPerMonth field`);

    // Show current subscriptions
    const subscriptions = await Subscription.find({}).select('organization limits.maxAICreditsPerMonth usage.aiCreditsThisMonth');
    console.log('\n📊 Current Subscriptions:');
    subscriptions.forEach(sub => {
      console.log(`  Org: ${sub.organization}`);
      console.log(`  Limit: ${sub.limits?.maxAICreditsPerMonth || 'N/A'} credits/month`);
      console.log(`  Usage: ${sub.usage?.aiCreditsThisMonth || 0} credits used`);
      console.log('  ---');
    });

    console.log('\n✅ Migration complete!');
    process.exit(0);
  } catch (error) {
    console.error('❌ Error:', error);
    process.exit(1);
  }
}

// Run the migration
addAICreditsToSubscriptions();
