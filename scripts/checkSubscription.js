require('dotenv').config();
const mongoose = require('mongoose');
const Subscription = require('../src/models/Subscription');

async function check() {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ Connected to MongoDB');
    
    const orgId = '69864350c54ce899bcbbf832';
    console.log(`\n🔍 Checking subscription for org: ${orgId}`);
    
    const subscription = await Subscription.findOne({ organization: orgId });
    
    if (!subscription) {
      console.log('❌ No subscription found for this organization!');
    } else {
      console.log('✅ Subscription found:');
      console.log('  Plan:', subscription.planName);
      console.log('  Limits:', JSON.stringify(subscription.limits, null, 2));
      console.log('  Usage:', JSON.stringify(subscription.usage, null, 2));
    }
    
    process.exit(0);
  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
}

check();
