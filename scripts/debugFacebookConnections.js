require('dotenv').config();
const mongoose = require('mongoose');
const PlatformConnection = require('../src/models/PlatformConnection');
const Organization = require('../src/models/Organization');

/**
 * Debug Facebook connections to see what's actually in the database
 */

async function debugFacebookConnections() {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ Connected to MongoDB\n');

    // Get organization with issue
    const org = await Organization.findById('69864350c54ce899bcbbf832');
    console.log(`📍 Organization: ${org.name} (${org._id})\n`);

    // Find ALL Facebook connections for this org
    const allConnections = await PlatformConnection.find({
      organization: org._id,
      platform: 'facebook'
    }).sort({ createdAt: -1 });

    console.log(`📊 Total Facebook connections: ${allConnections.length}\n`);

    for (const conn of allConnections) {
      console.log(`---`);
      console.log(`ID: ${conn._id}`);
      console.log(`Platform User ID: ${conn.platformUserId}`);
      console.log(`Platform Page ID: ${conn.platformPageId}`);
      console.log(`Platform Username: ${conn.platformUsername}`);
      console.log(`Platform Display Name: ${conn.platformDisplayName}`);
      console.log(`Is Active: ${conn.isActive}`);
      console.log(`Status: ${conn.status}`);
      console.log(`Uses Account Slot: ${conn.usesAccountSlot}`);
      console.log(`Metadata:`, JSON.stringify(conn.metadata, null, 2));
      console.log(`Created At: ${conn.createdAt}`);
      console.log(``);
    }

    // Find user-level connections (platformPageId = null)
    const userLevelConnections = allConnections.filter(c => c.platformPageId === null);
    console.log(`\n👤 User-level connections (platformPageId = null): ${userLevelConnections.length}`);
    
    if (userLevelConnections.length > 0) {
      userLevelConnections.forEach(conn => {
        console.log(`  - ${conn._id}: ${conn.platformUsername} (${conn.platformUserId})`);
        console.log(`    metadata.type: ${conn.metadata?.type || 'NOT SET'}`);
        console.log(`    isActive: ${conn.isActive}`);
      });
    }

    // Find page-level connections (platformPageId not null)
    const pageLevelConnections = allConnections.filter(c => c.platformPageId !== null);
    console.log(`\n📄 Page-level connections: ${pageLevelConnections.length}`);
    
    if (pageLevelConnections.length > 0) {
      pageLevelConnections.forEach(conn => {
        console.log(`  - ${conn._id}: ${conn.platformUsername} (Page: ${conn.platformPageId})`);
        console.log(`    isActive: ${conn.isActive}, status: ${conn.status}`);
      });
    }

    await mongoose.disconnect();
    console.log('\n✅ Disconnected from MongoDB');
  } catch (error) {
    console.error('❌ Script error:', error);
    process.exit(1);
  }
}

// Run the script
debugFacebookConnections();
