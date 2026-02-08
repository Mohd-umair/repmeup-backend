/**
 * One-time script: set usesAccountSlot = false for Facebook user-level connections.
 * These are used only to list/select pages and should not count toward plan limit.
 * Run: node scripts/fixFacebookUserTokenSlots.js
 */

require('dotenv').config();
const mongoose = require('mongoose');
const PlatformConnection = require('../src/models/PlatformConnection');

async function run() {
  await mongoose.connect(process.env.MONGODB_URI);
  const result = await PlatformConnection.updateMany(
    {
      platform: 'facebook',
      $or: [
        { 'metadata.type': 'user_token' },
        { platformPageId: null, 'metadata.type': { $exists: false } }
      ]
    },
    { $set: { usesAccountSlot: false } }
  );
  console.log('Updated Facebook user-level (non-counting) connections:', result.modifiedCount);
  process.exit(0);
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
