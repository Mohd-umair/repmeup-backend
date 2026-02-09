require('dotenv').config();
const mongoose = require('mongoose');
const PlatformConnection = require('../src/models/PlatformConnection');
const Organization = require('../src/models/Organization');

/**
 * Verify all organizations have proper user-level Facebook connections
 */

async function verifyAllUserConnections() {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ Connected to MongoDB\n');

    // Find all organizations with Facebook page connections
    const facebookPageConnections = await PlatformConnection.find({
      platform: 'facebook',
      isActive: true,
      platformPageId: { $ne: null } // Only page-level connections
    }).populate('organization');

    // Group by organization
    const orgMap = new Map();
    for (const conn of facebookPageConnections) {
      if (!orgMap.has(conn.organization._id.toString())) {
        orgMap.set(conn.organization._id.toString(), conn.organization);
      }
    }

    console.log(`📊 Organizations with active Facebook pages: ${orgMap.size}\n`);

    for (const [orgId, org] of orgMap.entries()) {
      console.log(`--- ${org.name} (${orgId}) ---`);
      
      // Check for user-level connection
      const userConnection = await PlatformConnection.findOne({
        organization: orgId,
        platform: 'facebook',
        platformPageId: null,
        'metadata.type': 'user_token',
        isActive: true
      });

      if (userConnection) {
        console.log(`✅ Valid user-level connection found`);
        console.log(`   Username: ${userConnection.platformUsername}`);
        console.log(`   User ID: ${userConnection.platformUserId}`);
        console.log(`   Purpose: ${userConnection.metadata.purpose}`);
        console.log(`   Uses Slot: ${userConnection.usesAccountSlot}`);
      } else {
        console.log(`❌ No valid user-level connection found!`);
        
        // Check if there's any connection with platformPageId = null
        const anyUserConn = await PlatformConnection.findOne({
          organization: orgId,
          platform: 'facebook',
          platformPageId: null
        });
        
        if (anyUserConn) {
          console.log(`   ⚠️  Found a user connection but it's not valid:`);
          console.log(`      isActive: ${anyUserConn.isActive}`);
          console.log(`      metadata.type: ${anyUserConn.metadata?.type}`);
        } else {
          console.log(`   ⚠️  No user-level connection exists at all`);
        }
      }
      console.log(``);
    }

    await mongoose.disconnect();
    console.log('✅ Disconnected from MongoDB');
  } catch (error) {
    console.error('❌ Script error:', error);
    process.exit(1);
  }
}

// Run the script
verifyAllUserConnections();
