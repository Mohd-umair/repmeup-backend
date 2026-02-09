/**
 * Quick diagnostic: Check Google Business Profile connection
 */
require('dotenv').config();
const mongoose = require('mongoose');
const PlatformConnection = require('./src/models/PlatformConnection');
const Organization = require('./src/models/Organization');

async function checkGoogle() {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ Connected to MongoDB\n');

    const googleConn = await PlatformConnection.findOne({
      platform: 'google',
      isActive: true
    }).populate('organization', 'name');

    if (!googleConn) {
      console.log('❌ No active Google connection found!');
      process.exit(1);
    }

    console.log('📊 GOOGLE CONNECTION DETAILS:');
    console.log('═'.repeat(80));
    console.log('Connection ID:', googleConn._id);
    console.log('Organization:', googleConn.organization?.name);
    console.log('Username:', googleConn.platformUsername);
    console.log('Email:', googleConn.platformEmail);
    console.log('Status:', googleConn.status);
    console.log('Active:', googleConn.isActive);
    console.log('\n📦 Platform Data:');
    console.log(JSON.stringify(googleConn.platformData, null, 2));
    
    if (googleConn.platformData?.locationIds?.length > 0) {
      console.log('\n✅ HAS LOCATIONS:', googleConn.platformData.locationIds);
    } else {
      console.log('\n❌ NO LOCATIONS FOUND!');
      if (googleConn.platformData?.error) {
        console.log('Error during setup:', googleConn.platformData.error);
      }
      if (googleConn.platformData?.note) {
        console.log('Note:', googleConn.platformData.note);
      }
    }

    console.log('\n═'.repeat(80));
    process.exit(0);
  } catch (error) {
    console.error('❌ Error:', error);
    process.exit(1);
  }
}

checkGoogle();
