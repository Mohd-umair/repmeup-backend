/**
 * unsubscribe-instagram-login.js
 *
 * One-time script to revoke Meta webhook subscriptions for all Instagram Login
 * connections that are currently disconnected/inactive in the database.
 *
 * Usage:
 *   node scripts/unsubscribe-instagram-login.js
 *
 * This is needed when an Instagram Login account was disconnected through the UI
 * BEFORE the automatic unsubscribe logic was added. Without running this, Meta
 * will keep delivering webhooks for those accounts indefinitely.
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const mongoose = require('mongoose');
const axios = require('axios');

const MONGO_URI = process.env.MONGO_URI || process.env.MONGODB_URI;
const IG_GRAPH = 'https://graph.instagram.com';

async function unsubscribeAccount(igUserId, accessToken, username) {
  try {
    const res = await axios.delete(`${IG_GRAPH}/${igUserId}/subscribed_apps`, {
      params: { access_token: accessToken },
      timeout: 10000
    });
    if (res.data?.success) {
      console.log(`  ✅ Unsubscribed @${username || igUserId}`);
      return true;
    }
    console.warn(`  ⚠️  Unexpected response for @${username || igUserId}:`, res.data);
    return false;
  } catch (err) {
    const msg = err.response?.data?.error?.message || err.message;
    const code = err.response?.data?.error?.code;
    if (code === 190) {
      console.log(`  ℹ️  @${username || igUserId}: token already expired — no active subscription to remove`);
    } else {
      console.warn(`  ❌ @${username || igUserId}: ${msg}`);
    }
    return false;
  }
}

async function main() {
  if (!MONGO_URI) {
    console.error('❌ MONGO_URI / MONGODB_URI not set in .env');
    process.exit(1);
  }

  await mongoose.connect(MONGO_URI);
  console.log('✅ MongoDB connected\n');

  const PlatformConnection = require('../src/models/PlatformConnection');

  // Find all Instagram Login connections — both active and inactive
  const all = await PlatformConnection.find({
    platform: 'instagram',
    $or: [
      { 'metadata.connectionType': 'instagram_login' },
      { accessToken: { $regex: /^IGAA/ } }
    ]
  }).lean();

  if (all.length === 0) {
    console.log('No Instagram Login connections found.');
    await mongoose.disconnect();
    return;
  }

  console.log(`Found ${all.length} Instagram Login connection(s):\n`);

  const inactive = all.filter(c => !c.isActive || c.status !== 'connected');
  const active   = all.filter(c =>  c.isActive && c.status === 'connected');

  console.log(`  Active   (will keep subscribed): ${active.length}`);
  console.log(`  Inactive (will be unsubscribed):  ${inactive.length}\n`);

  for (const conn of active) {
    console.log(`  ✔  Keeping @${conn.platformUsername || conn.platformUserId} [active]`);
  }

  if (inactive.length === 0) {
    console.log('\nNothing to unsubscribe.');
    await mongoose.disconnect();
    return;
  }

  console.log('\nUnsubscribing inactive accounts...');
  let successCount = 0;
  for (const conn of inactive) {
    const isuid = conn.metadata?.igLoginScopedId || conn.platformUserId;
    const username = conn.platformUsername || isuid;
    process.stdout.write(`  → @${username} (ISUID: ${isuid})... `);
    const ok = await unsubscribeAccount(isuid, conn.accessToken, username);
    if (ok) successCount++;
  }

  console.log(`\nDone. Unsubscribed ${successCount}/${inactive.length} account(s).`);
  await mongoose.disconnect();
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
