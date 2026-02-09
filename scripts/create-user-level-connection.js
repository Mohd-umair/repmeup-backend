/**
 * Temporarily create a user-level connection from an existing page connection
 * This is just for testing - the proper way is to reconnect
 */

require('dotenv').config();
const mongoose = require('mongoose');
const PlatformConnection = require('../src/models/PlatformConnection');

async function createUserLevel() {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ Connected to MongoDB\n');

    // Find an existing Facebook page connection
    const pageConnection = await PlatformConnection.findOne({ 
      platform: 'facebook',
      platformPageId: { $ne: null }
    });

    if (!pageConnection) {
      console.log('❌ No Facebook page connections found');
      console.log('   Please connect Facebook first');
      await mongoose.disconnect();
      return;
    }

    console.log(`Found page connection: ${pageConnection.platformUsername}`);

    // Check if user-level already exists
    const existing = await PlatformConnection.findOne({
      organization: pageConnection.organization,
      platform: 'facebook',
      platformPageId: null
    });

    if (existing) {
      console.log('✅ User-level connection already exists!');
      await mongoose.disconnect();
      return;
    }

    // Create user-level connection (clone the page connection but with platformPageId = null)
    const userLevel = await PlatformConnection.create({
      organization: pageConnection.organization,
      createdBy: pageConnection.createdBy,
      platform: 'facebook',
      platformUserId: pageConnection.platformUserId,
      platformUsername: pageConnection.platformUsername,
      platformDisplayName: pageConnection.platformDisplayName,
      platformEmail: pageConnection.platformEmail,
      platformPageId: null, // This makes it user-level
      accessToken: pageConnection.accessToken, // Using same token (may not work for all APIs)
      tokenExpiresAt: pageConnection.tokenExpiresAt,
      scopes: pageConnection.scopes,
      status: 'connected',
      isActive: true,
      metadata: {
        type: 'user_token',
        purpose: 'page_management',
        note: 'Temporary - reconnect for proper user token'
      }
    });

    console.log(`✅ Created temporary user-level connection`);
    console.log(`   Note: This uses a page token, not a user token`);
    console.log(`   For proper functionality, disconnect and reconnect Facebook`);

    await mongoose.disconnect();
  } catch (error) {
    console.error('Error:', error);
    await mongoose.disconnect();
  }
}

createUserLevel();
