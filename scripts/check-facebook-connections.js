/**
 * Check what Facebook connections exist
 */

require('dotenv').config();
const mongoose = require('mongoose');
const PlatformConnection = require('../src/models/PlatformConnection');

async function checkConnections() {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ Connected to MongoDB\n');

    const connections = await PlatformConnection.find({ 
      platform: 'facebook' 
    }).sort({ createdAt: -1 });

    console.log(`Found ${connections.length} Facebook connections:\n`);

    connections.forEach((conn, index) => {
      console.log(`${index + 1}. ${conn.platformUsername || 'Unnamed'}`);
      console.log(`   ID: ${conn._id}`);
      console.log(`   platformUserId: ${conn.platformUserId}`);
      console.log(`   platformPageId: ${conn.platformPageId || 'null (user-level)'}`);
      console.log(`   status: ${conn.status}`);
      console.log(`   isActive: ${conn.isActive}`);
      console.log(`   metadata: ${JSON.stringify(conn.metadata)}`);
      console.log(`   created: ${conn.createdAt}`);
      console.log('');
    });

    const userLevel = connections.find(c => !c.platformPageId);
    if (userLevel) {
      console.log('✅ User-level connection EXISTS - Page Manager should work!');
    } else {
      console.log('❌ No user-level connection found');
      console.log('   You need to RECONNECT Facebook/Instagram to save the user token');
      console.log('\n   Steps:');
      console.log('   1. Go to Settings → Platforms');
      console.log('   2. Disconnect Facebook/Instagram');
      console.log('   3. Reconnect');
    }

    await mongoose.disconnect();
  } catch (error) {
    console.error('Error:', error);
  }
}

checkConnections();
