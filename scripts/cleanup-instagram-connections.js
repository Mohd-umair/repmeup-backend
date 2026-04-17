/**
 * One-time cleanup script: remove stale Facebook Login Instagram connections
 * that block the Instagram Login self-heal (E11000 duplicate key error).
 *
 * Run on the server ONCE, then reconnect Instagram via Settings.
 *
 *   node backend/scripts/cleanup-instagram-connections.js
 */

'use strict';

const mongoose = require('mongoose');
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('Connected to MongoDB');

  const PlatformConnection = mongoose.model(
    'PlatformConnection',
    new mongoose.Schema({}, { strict: false, collection: 'platformconnections' })
  );

  // Find all Instagram connections
  const all = await PlatformConnection.find({ platform: 'instagram' })
    .select('_id organization platformUserId platformUsername accessToken')
    .lean();

  console.log(`Found ${all.length} total Instagram connection(s):`);
  all.forEach(c => {
    const prefix = c.accessToken?.substring(0, 6) || '???';
    console.log(`  ${c._id}  @${c.platformUsername || '?'}  userId=${c.platformUserId}  token=${prefix}...  org=${c.organization}`);
  });

  // Delete non-IGAA connections that share an org+username with an IGAA connection.
  // These are the stale Facebook Login connections that cause duplicate key errors.
  const igaaConns = all.filter(c => c.accessToken?.startsWith('IGAA'));
  const staleIds = [];

  for (const igaa of igaaConns) {
    const stales = all.filter(c =>
      !c.accessToken?.startsWith('IGAA') &&
      String(c.organization) === String(igaa.organization) &&
      c.platformUsername === igaa.platformUsername
    );
    for (const s of stales) staleIds.push(s._id);
  }

  if (staleIds.length === 0) {
    console.log('\nNo stale connections to remove.');
  } else {
    console.log(`\nRemoving ${staleIds.length} stale connection(s)...`);
    const result = await PlatformConnection.deleteMany({ _id: { $in: staleIds } });
    console.log(`Deleted ${result.deletedCount} stale connection(s).`);
  }

  await mongoose.disconnect();
  console.log('\nDone. Now reconnect Instagram in Settings to get a fresh connection.');
}

main().catch(err => {
  console.error('Cleanup failed:', err.message);
  process.exit(1);
});
