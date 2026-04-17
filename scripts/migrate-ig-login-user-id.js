/**
 * migrate-ig-login-user-id.js
 *
 * One-time migration for existing Instagram Login (IGAA) connections.
 *
 * Context:
 *   Earlier versions of saveConnection() stored only the app-scoped Instagram
 *   User ID (ISUID) from `graph.instagram.com/me?fields=id`. Meta's webhooks
 *   carry the GLOBAL Instagram Business Account ID in `entry.id`, so matching
 *   webhooks against platformUserId required fragile self-healing fallbacks.
 *
 *   saveConnection() now requests `user_id` too (the global ID) and stores it
 *   as platformUserId. This script backfills that field for every existing
 *   active IGAA connection so webhook routing becomes deterministic without
 *   forcing users to reconnect.
 *
 * Usage:
 *   node scripts/migrate-ig-login-user-id.js
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const mongoose = require('mongoose');
const axios = require('axios');

const MONGO_URI = process.env.MONGO_URI || process.env.MONGODB_URI;
const IG_GRAPH = 'https://graph.instagram.com';

async function fetchGlobalId(accessToken) {
  const res = await axios.get(`${IG_GRAPH}/me`, {
    params: { fields: 'id,user_id,username', access_token: accessToken },
    timeout: 10000
  });
  return {
    isuid: res.data?.id ? String(res.data.id) : null,
    globalId: res.data?.user_id ? String(res.data.user_id) : null,
    username: res.data?.username || null
  };
}

async function main() {
  if (!MONGO_URI) {
    console.error('MONGO_URI / MONGODB_URI not set in .env');
    process.exit(1);
  }

  await mongoose.connect(MONGO_URI);
  console.log('MongoDB connected\n');

  const PlatformConnection = require('../src/models/PlatformConnection');

  const connections = await PlatformConnection.find({
    platform: 'instagram',
    accessToken: { $regex: /^IGAA/ },
    isActive: true
  });

  if (connections.length === 0) {
    console.log('No active Instagram Login (IGAA) connections to migrate.');
    await mongoose.disconnect();
    return;
  }

  console.log(`Found ${connections.length} active Instagram Login connection(s).\n`);

  let migrated = 0;
  let skipped = 0;
  let failed = 0;

  for (const conn of connections) {
    const label = `@${conn.platformUsername || conn._id}`;
    process.stdout.write(`  ${label}... `);

    try {
      const { isuid, globalId, username } = await fetchGlobalId(conn.accessToken);

      if (!globalId) {
        console.log('FAIL — user_id missing from /me response (requires Meta API v21+)');
        failed++;
        continue;
      }

      const alreadyMigrated = String(conn.platformUserId) === globalId
        && conn.metadata?.igLoginScopedId
        && String(conn.metadata.igLoginScopedId) === isuid;

      if (alreadyMigrated) {
        console.log('already migrated — skipping');
        skipped++;
        continue;
      }

      // Drop any OTHER connection in the same org that already holds the global
      // ID (left over from a previous self-heal attempt). The unique index
      // (org+platform+platformUserId) would otherwise block the save.
      const stale = await PlatformConnection.deleteMany({
        organization: conn.organization,
        platform: 'instagram',
        platformUserId: globalId,
        _id: { $ne: conn._id }
      });

      conn.platformUserId = globalId;
      conn.platformPageId = globalId;
      if (!conn.platformData) conn.platformData = {};
      conn.platformData.businessAccountId = globalId;
      if (!conn.metadata) conn.metadata = {};
      if (!conn.metadata.igLoginScopedId) conn.metadata.igLoginScopedId = isuid;
      if (!conn.metadata.connectionType) conn.metadata.connectionType = 'instagram_login';
      await conn.save();

      const extra = stale.deletedCount ? ` (removed ${stale.deletedCount} stale row)` : '';
      console.log(`OK — platformUserId=${globalId}, ISUID=${isuid}${extra}`);
      migrated++;
    } catch (err) {
      const msg = err.response?.data?.error?.message || err.message;
      console.log(`FAIL — ${msg}`);
      failed++;
    }
  }

  console.log(`\nDone. Migrated: ${migrated}, Skipped: ${skipped}, Failed: ${failed}`);
  await mongoose.disconnect();
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
