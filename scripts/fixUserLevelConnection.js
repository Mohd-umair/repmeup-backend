require('dotenv').config();
const mongoose = require('mongoose');
const PlatformConnection = require('../src/models/PlatformConnection');

/**
 * Fix the user-level Facebook connection for organization 69864350c54ce899bcbbf832
 */

async function fixUserLevelConnection() {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ Connected to MongoDB\n');

    // Find the problematic user-level connection
    const connection = await PlatformConnection.findById('69864a82ac392abbf8283974');
    
    if (!connection) {
      console.log('❌ Connection not found');
      return;
    }

    console.log('📝 Current state:');
    console.log(`   ID: ${connection._id}`);
    console.log(`   Username: ${connection.platformUsername}`);
    console.log(`   Is Active: ${connection.isActive}`);
    console.log(`   Status: ${connection.status}`);
    console.log(`   Uses Account Slot: ${connection.usesAccountSlot}`);
    console.log(`   Metadata Type: ${connection.metadata?.type}`);
    console.log(`   Metadata Purpose: ${connection.metadata?.purpose}`);

    // Update the connection
    connection.isActive = true;
    connection.status = 'connected';
    connection.usesAccountSlot = false; // User-level tokens don't count toward limit
    connection.metadata = {
      ...connection.metadata,
      type: 'user_token',
      purpose: 'page_management'
    };

    await connection.save();

    console.log('\n✅ Updated to:');
    console.log(`   Is Active: ${connection.isActive}`);
    console.log(`   Status: ${connection.status}`);
    console.log(`   Uses Account Slot: ${connection.usesAccountSlot}`);
    console.log(`   Metadata Type: ${connection.metadata.type}`);
    console.log(`   Metadata Purpose: ${connection.metadata.purpose}`);

    await mongoose.disconnect();
    console.log('\n✅ Disconnected from MongoDB');
    console.log('\n🎉 Fix complete! Try opening the Facebook page selector modal now.');
  } catch (error) {
    console.error('❌ Script error:', error);
    process.exit(1);
  }
}

// Run the script
fixUserLevelConnection();
