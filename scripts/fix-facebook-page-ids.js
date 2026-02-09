/**
 * Script to fix Facebook platformPageId if missing
 * Run with: node scripts/fix-facebook-page-ids.js
 */

const mongoose = require('mongoose');
require('dotenv').config();

// Import models
const PlatformConnection = require('../src/models/PlatformConnection');

async function fixFacebookPageIds() {
  try {
    console.log('🔄 Connecting to MongoDB...');
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ Connected to MongoDB\n');

    // Find all Facebook connections where platformPageId is missing or different from platformUserId
    const connections = await PlatformConnection.find({
      platform: 'facebook',
      status: 'connected'
    });

    console.log(`📊 Found ${connections.length} Facebook connections\n`);

    if (connections.length === 0) {
      console.log('✅ No Facebook connections found.');
      process.exit(0);
    }

    let updated = 0;
    let alreadyCorrect = 0;

    for (const conn of connections) {
      try {
        if (!conn.platformPageId) {
          // platformPageId is missing - set it to platformUserId
          console.log(`🔧 Fixing connection ${conn._id} (${conn.platformUsername})`);
          console.log(`   Setting platformPageId: ${conn.platformUserId}`);
          
          conn.platformPageId = conn.platformUserId;
          await conn.save();
          
          console.log(`✅ Updated connection for: ${conn.platformUsername}\n`);
          updated++;
        } else if (conn.platformPageId !== conn.platformUserId) {
          // platformPageId exists but different from platformUserId
          console.log(`⚠️  Connection ${conn._id} (${conn.platformUsername})`);
          console.log(`   platformUserId: ${conn.platformUserId}`);
          console.log(`   platformPageId: ${conn.platformPageId}`);
          console.log(`   Setting platformPageId to match platformUserId`);
          
          conn.platformPageId = conn.platformUserId;
          await conn.save();
          
          console.log(`✅ Updated connection for: ${conn.platformUsername}\n`);
          updated++;
        } else {
          console.log(`✅ Connection ${conn._id} (${conn.platformUsername}) is already correct\n`);
          alreadyCorrect++;
        }
      } catch (error) {
        console.error(`❌ Error processing connection ${conn._id}:`, error.message);
        console.log('');
      }
    }

    console.log('\n📊 Summary:');
    console.log(`   Total connections: ${connections.length}`);
    console.log(`   ✅ Updated: ${updated}`);
    console.log(`   ✅ Already correct: ${alreadyCorrect}`);

    process.exit(0);
  } catch (error) {
    console.error('❌ Script failed:', error);
    process.exit(1);
  }
}

// Run the script
fixFacebookPageIds();
