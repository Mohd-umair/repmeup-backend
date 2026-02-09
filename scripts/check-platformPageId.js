/**
 * Diagnostic script to check platformPageId in database vs Mongoose model
 */

require('dotenv').config();
const mongoose = require('mongoose');
const PlatformConnection = require('../src/models/PlatformConnection');

async function checkPlatformPageId() {
  try {
    console.log('🔍 Checking platformPageId field...\n');
    
    // Connect to MongoDB
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ Connected to MongoDB\n');

    // Check 1: Raw MongoDB query (bypasses Mongoose schema)
    console.log('📊 Check 1: Raw MongoDB data');
    console.log('=' .repeat(60));
    const rawConnections = await mongoose.connection.db
      .collection('platformconnections')
      .find({ platform: 'facebook' })
      .toArray();
    
    for (const conn of rawConnections) {
      console.log(`\nPage: ${conn.platformUsername || 'Unknown'}`);
      console.log(`  _id: ${conn._id}`);
      console.log(`  platformUserId: ${conn.platformUserId}`);
      console.log(`  platformPageId (raw): ${conn.platformPageId}`);
      console.log(`  platformData.pageId: ${conn.platformData?.pageId}`);
    }

    // Check 2: Mongoose query (uses schema)
    console.log('\n\n📊 Check 2: Mongoose Model data');
    console.log('=' .repeat(60));
    const modelConnections = await PlatformConnection.find({ platform: 'facebook' });
    
    for (const conn of modelConnections) {
      console.log(`\nPage: ${conn.platformUsername || 'Unknown'}`);
      console.log(`  _id: ${conn._id}`);
      console.log(`  platformUserId: ${conn.platformUserId}`);
      console.log(`  platformPageId (model): ${conn.platformPageId}`);
      console.log(`  platformData.pageId: ${conn.platformData?.pageId}`);
    }

    // Check 3: Schema definition
    console.log('\n\n📊 Check 3: Schema Definition');
    console.log('=' .repeat(60));
    const schemaFields = Object.keys(PlatformConnection.schema.paths);
    console.log('Schema has these top-level fields:');
    const relevantFields = schemaFields.filter(f => 
      f.includes('platform') || f.includes('Page') || f.includes('User')
    );
    relevantFields.forEach(field => {
      console.log(`  - ${field}: ${PlatformConnection.schema.paths[field].instance}`);
    });
    
    if (!schemaFields.includes('platformPageId')) {
      console.log('\n⚠️  WARNING: platformPageId NOT found in schema!');
      console.log('   The schema file may not have been updated correctly.');
    } else {
      console.log('\n✅ platformPageId is defined in the schema');
    }

    // Check 4: Test creating a connection object
    console.log('\n\n📊 Check 4: Test Reading Connection');
    console.log('=' .repeat(60));
    const testConn = await PlatformConnection.findOne({ 
      platform: 'facebook',
      platformUsername: 'Repmeup'
    });
    
    if (testConn) {
      console.log('Found connection for Repmeup:');
      console.log(`  platformPageId: ${testConn.platformPageId}`);
      console.log(`  Type: ${typeof testConn.platformPageId}`);
      console.log(`  Is undefined: ${testConn.platformPageId === undefined}`);
      console.log(`  Has property: ${testConn.hasOwnProperty('platformPageId')}`);
      
      // Try to access it different ways
      console.log('\nDifferent access methods:');
      console.log(`  testConn.platformPageId: ${testConn.platformPageId}`);
      console.log(`  testConn['platformPageId']: ${testConn['platformPageId']}`);
      console.log(`  testConn.get('platformPageId'): ${testConn.get('platformPageId')}`);
      console.log(`  testConn.toObject().platformPageId: ${testConn.toObject().platformPageId}`);
      
      // Check the raw document
      console.log('\nRaw document _doc:');
      console.log(`  testConn._doc.platformPageId: ${testConn._doc.platformPageId}`);
    }

    console.log('\n\n✅ Diagnostic complete!\n');
    
  } catch (error) {
    console.error('❌ Error:', error.message);
    console.error(error);
  } finally {
    await mongoose.disconnect();
    console.log('Disconnected from MongoDB');
  }
}

checkPlatformPageId();
