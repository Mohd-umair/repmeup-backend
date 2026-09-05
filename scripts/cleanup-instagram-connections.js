/**
 * One-time cleanup script: remove ALL Instagram connections for all orgs,
 * so every org starts fresh with the new ISUID-based flow.
 *
 * Run on the server ONCE after deploying the fix, then reconnect Instagram.
 *
 *   cd /home/repmeup/ORM/repmeup-backend
 *   node scripts/cleanup-instagram-connections.js
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

  // Show current state
  const all = await PlatformConnection.find({ platform: 'instagram' })
    .select('_id organization platformUserId platformUsername accessToken metadata')
    .lean();

  console.log(`\nFound ${all.length} total Instagram connection(s):`);
  all.forEach(c => {
    const prefix = c.accessToken?.substring(0, 6) || '???';
    const scopedId = c.metadata?.igLoginScopedId || '-';
    console.log(`  ${c._id}  @${c.platformUsername || '?'}  userId=${c.platformUserId}  scopedId=${scopedId}  token=${prefix}...  org=${c.organization}`);
  });

  // Delete ALL Instagram connections. After this:
  // - Reconnect via Instagram Login → saveConnection stores ISUID correctly
  // - First webhook triggers $expr self-heal → platformUserId updated to global ID
  // - All subsequent webhooks match by primary key
  if (all.length === 0) {
    console.log('\nNo Instagram connections to remove.');
  } else {
    console.log(`\nDeleting all ${all.length} Instagram connection(s)...`);
    const result = await PlatformConnection.deleteMany({ platform: 'instagram' });
    console.log(`Deleted ${result.deletedCount} connection(s).`);
  }

  await mongoose.disconnect();
  console.log('\nDone.\n');
  console.log('Next steps:');
  console.log('  1. Restart the backend: pm2 restart orm-api');
  console.log('  2. Go to Settings and reconnect Instagram via "Direct Login"');
  console.log('  3. Send a test DM — the first webhook will self-heal the connection');
  console.log('     and update platformUserId to the real global IG Business Account ID');
  console.log('  4. All subsequent webhooks will match instantly by primary key');
}

main().catch(err => {
  console.error('Cleanup failed:', err.message);
  process.exit(1);
});
