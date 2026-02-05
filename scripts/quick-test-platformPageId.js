/**
 * Quick test to verify platformPageId is accessible
 */

require('dotenv').config();
const mongoose = require('mongoose');

async function quickTest() {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ Connected to MongoDB\n');

    // Load model AFTER connection
    const PlatformConnection = require('../src/models/PlatformConnection');

    // Find a Facebook connection
    const conn = await PlatformConnection.findOne({ 
      platform: 'facebook',
      platformUsername: 'Repmeup'
    });

    if (!conn) {
      console.log('❌ No Facebook connection found for Repmeup');
      process.exit(1);
    }

    console.log('Found connection:');
    console.log(`  platformUsername: ${conn.platformUsername}`);
    console.log(`  platformUserId: ${conn.platformUserId}`);
    console.log(`  platformPageId: ${conn.platformPageId}`);
    console.log(`  platformPageId is undefined: ${conn.platformPageId === undefined}`);
    
    if (conn.platformPageId) {
      console.log('\n✅ SUCCESS! platformPageId is accessible via Mongoose');
    } else {
      console.log('\n❌ FAIL! platformPageId is still undefined');
      console.log('\nPossible issues:');
      console.log('1. Schema file not uploaded to server');
      console.log('2. Backend not restarted properly');
      console.log('3. Node module cache issue');
      
      // Check raw document
      console.log('\nChecking raw MongoDB document:');
      const raw = await mongoose.connection.db
        .collection('platformconnections')
        .findOne({ _id: conn._id });
      console.log(`  Raw platformPageId: ${raw.platformPageId}`);
      
      if (raw.platformPageId) {
        console.log('\n⚠️  Field EXISTS in MongoDB but NOT accessible via Mongoose!');
        console.log('   → Schema definition issue or caching problem');
      }
    }

    await mongoose.disconnect();
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

quickTest();
