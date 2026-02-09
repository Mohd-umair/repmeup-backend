require('dotenv').config();
const mongoose = require('mongoose');
const PlatformConnection = require('../src/models/PlatformConnection');
const Organization = require('../src/models/Organization');

/**
 * Script to fix missing Facebook user-level connections
 * Creates user-level connections from existing page connections
 */

async function fixFacebookUserConnections() {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ Connected to MongoDB');

    // Find all organizations with Facebook page connections but no user-level connection
    const facebookPageConnections = await PlatformConnection.find({
      platform: 'facebook',
      isActive: true,
      platformPageId: { $ne: null } // Only page-level connections
    }).populate('organization');

    console.log(`\n📊 Found ${facebookPageConnections.length} Facebook page connections`);

    // Group by organization
    const orgMap = new Map();
    for (const conn of facebookPageConnections) {
      if (!orgMap.has(conn.organization._id.toString())) {
        orgMap.set(conn.organization._id.toString(), {
          organization: conn.organization,
          createdBy: conn.createdBy,
          connections: []
        });
      }
      orgMap.get(conn.organization._id.toString()).connections.push(conn);
    }

    console.log(`\n🏢 Organizations with Facebook pages: ${orgMap.size}`);

    let created = 0;
    let existing = 0;
    let skipped = 0;

    for (const [orgId, data] of orgMap.entries()) {
      console.log(`\n--- Organization: ${data.organization.name} (${orgId}) ---`);
      
      // Check if user-level connection exists
      const userConnection = await PlatformConnection.findOne({
        organization: orgId,
        platform: 'facebook',
        platformPageId: null,
        isActive: true
      });

      if (userConnection) {
        console.log(`  ✅ User-level connection already exists`);
        
        // Ensure it has the correct metadata
        if (!userConnection.metadata?.type) {
          userConnection.metadata = {
            ...userConnection.metadata,
            type: 'user_token',
            purpose: 'page_management'
          };
          await userConnection.save();
          console.log(`  📝 Updated metadata on existing connection`);
        }
        
        existing++;
        continue;
      }

      // No user-level connection found - need to create one
      // Use the first page connection as a template
      const firstPage = data.connections[0];
      
      if (!firstPage.accessToken) {
        console.log(`  ⚠️  Skipped - no access token available`);
        skipped++;
        continue;
      }

      try {
        // Try to get user info from Facebook API
        const axios = require('axios');
        let userInfo;
        
        try {
          const response = await axios.get(`https://graph.facebook.com/v18.0/me`, {
            params: {
              fields: 'id,name,email',
              access_token: firstPage.accessToken
            }
          });
          userInfo = response.data;
          console.log(`  📱 Fetched user info from Facebook: ${userInfo.name}`);
        } catch (apiError) {
          console.log(`  ⚠️  Could not fetch user info from API (token might be expired)`);
          // Use placeholder values if API fails
          userInfo = {
            id: firstPage.platformUserId || 'unknown',
            name: firstPage.platformUsername || 'Facebook User',
            email: firstPage.platformEmail || null
          };
        }

        // Create user-level connection
        const newConnection = await PlatformConnection.create({
          organization: orgId,
          createdBy: data.createdBy,
          platform: 'facebook',
          platformUserId: userInfo.id,
          platformUsername: userInfo.name,
          platformDisplayName: userInfo.name,
          platformEmail: userInfo.email,
          platformPageId: null, // User-level connection
          accessToken: firstPage.accessToken,
          tokenExpiresAt: firstPage.tokenExpiresAt || new Date(Date.now() + 60 * 24 * 60 * 60 * 1000),
          scopes: ['pages_show_list', 'pages_read_engagement'],
          status: 'connected',
          isActive: true,
          usesAccountSlot: false, // Does not count toward limit
          metadata: {
            type: 'user_token',
            purpose: 'page_management',
            createdVia: 'migration_script'
          }
        });

        console.log(`  ✅ Created user-level connection for: ${userInfo.name}`);
        created++;
      } catch (error) {
        console.error(`  ❌ Error creating user connection:`, error.message);
        skipped++;
      }
    }

    console.log(`\n\n📊 Summary:`);
    console.log(`   ✅ Created: ${created}`);
    console.log(`   📝 Already existed: ${existing}`);
    console.log(`   ⚠️  Skipped: ${skipped}`);
    console.log(`   📈 Total: ${created + existing + skipped}`);

    await mongoose.disconnect();
    console.log('\n✅ Disconnected from MongoDB');
  } catch (error) {
    console.error('❌ Script error:', error);
    process.exit(1);
  }
}

// Run the script
fixFacebookUserConnections();
