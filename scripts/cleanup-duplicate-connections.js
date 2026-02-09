/**
 * Clean up duplicate Facebook/Instagram connections
 * Keep only user-level connections and let users reconnect pages via Page Manager
 */

require('dotenv').config();
const mongoose = require('mongoose');
const PlatformConnection = require('../src/models/PlatformConnection');

async function cleanup() {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ Connected to MongoDB\n');

    // Find all Facebook/Instagram connections
    const connections = await PlatformConnection.find({ 
      platform: { $in: ['facebook', 'instagram'] }
    }).sort({ createdAt: -1 });

    console.log(`📊 Found ${connections.length} Facebook/Instagram connections\n`);

    // Group by organization
    const byOrg = {};
    connections.forEach(conn => {
      const orgId = conn.organization.toString();
      if (!byOrg[orgId]) byOrg[orgId] = [];
      byOrg[orgId].push(conn);
    });

    let totalRemoved = 0;
    let totalKept = 0;

    for (const [orgId, orgConnections] of Object.entries(byOrg)) {
      console.log(`\n🏢 Organization: ${orgId}`);
      console.log(`   Total connections: ${orgConnections.length}`);

      // Find user-level connection (platformPageId is null)
      const userLevel = orgConnections.find(c => 
        !c.platformPageId && c.metadata?.type === 'user_token'
      );

      if (userLevel) {
        console.log(`   ✅ User-level connection exists: ${userLevel._id}`);
        console.log(`      Platform: ${userLevel.platform}`);
        console.log(`      Keep this one for Page Manager\n`);
        totalKept++;
      } else {
        console.log(`   ⚠️  No user-level connection found`);
        console.log(`      User will need to reconnect Facebook/Instagram\n`);
      }

      // Remove all page-level connections (users will reconnect via Page Manager)
      const pageLevelConnections = orgConnections.filter(c => 
        c._id.toString() !== userLevel?._id.toString()
      );

      if (pageLevelConnections.length > 0) {
        console.log(`   🗑️  Removing ${pageLevelConnections.length} page-level connections:`);
        
        for (const conn of pageLevelConnections) {
          console.log(`      - ${conn.platform}: ${conn.platformUsername} (${conn._id})`);
          console.log(`        platformPageId: ${conn.platformPageId || 'null'}`);
          console.log(`        metadata: ${JSON.stringify(conn.metadata)}`);
          
          // Delete it
          await PlatformConnection.findByIdAndDelete(conn._id);
          totalRemoved++;
        }
      }
    }

    console.log('\n' + '='.repeat(60));
    console.log('✅ Cleanup Complete!');
    console.log(`   Kept: ${totalKept} user-level connections`);
    console.log(`   Removed: ${totalRemoved} page-level connections`);
    console.log('\n📝 Next Steps:');
    console.log('   1. Users should go to Settings → Page Manager');
    console.log('   2. They will see all available Facebook Pages and Instagram accounts');
    console.log('   3. They can click "Connect" on the ones they want to use');
    console.log('='.repeat(60));

    await mongoose.disconnect();
  } catch (error) {
    console.error('❌ Error:', error);
    await mongoose.disconnect();
    process.exit(1);
  }
}

cleanup();
