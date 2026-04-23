/**
 * migrate-interaction-platformid-compound-unique.js
 *
 * One-time migration: convert `interactions.platformId` from GLOBAL unique to
 * PER-ORGANIZATION unique. Without this fix, two tenants that share an external
 * thread id (e.g. a shared WhatsApp Business number or the same Instagram user
 * messaging two of our customers) will silently drop messages on duplicate-key
 * errors during webhook processing.
 *
 * What this script does:
 *   1. Runs a report of any cross-org duplicates that already exist (by platformId).
 *      If any are found, you must reconcile them manually before dropping the old
 *      unique index — otherwise the new compound index would fail to build.
 *   2. Drops the legacy global unique index `platformId_1`.
 *   3. Builds the new compound unique index `{ organization: 1, platformId: 1 }`.
 *   4. Verifies the new index exists.
 *
 * Safety:
 *   - Idempotent. Safe to re-run.
 *   - Does NOT modify data. If duplicates exist, the script aborts and prints them.
 *   - Uses collection.createIndex so it picks up any Mongoose schema-level options
 *     the next time the app connects.
 *
 * Usage:
 *   node scripts/migrate-interaction-platformid-compound-unique.js
 *   node scripts/migrate-interaction-platformid-compound-unique.js --report-only
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const mongoose = require('mongoose');

const MONGO_URI = process.env.MONGO_URI || process.env.MONGODB_URI;
const REPORT_ONLY = process.argv.includes('--report-only');

const LEGACY_INDEX_NAME = 'platformId_1';
const NEW_INDEX_NAME = 'organization_1_platformId_1';

async function main() {
  if (!MONGO_URI) {
    console.error('[migrate] MONGO_URI / MONGODB_URI is not set in .env');
    process.exit(1);
  }

  await mongoose.connect(MONGO_URI);
  console.log('[migrate] Connected to MongoDB');

  const db = mongoose.connection.db;
  const interactions = db.collection('interactions');

  try {
    // ── Step 1: Detect cross-org duplicates ────────────────────────────────
    console.log('\n[migrate] Scanning for cross-org duplicate platformIds…');
    const duplicates = await interactions
      .aggregate([
        {
          $group: {
            _id: '$platformId',
            orgs: { $addToSet: '$organization' },
            count: { $sum: 1 },
            ids: { $push: '$_id' }
          }
        },
        { $match: { 'orgs.1': { $exists: true } } },
        { $sort: { count: -1 } },
        { $limit: 100 }
      ])
      .toArray();

    if (duplicates.length > 0) {
      console.warn(`\n⚠️  Found ${duplicates.length} platformId(s) belonging to multiple organizations:`);
      for (const d of duplicates) {
        console.warn(`   platformId=${d._id}  orgs=[${d.orgs.join(', ')}]  documents=${d.count}`);
      }
      console.warn(
        '\n⚠️  The NEW compound unique index would succeed for these (each (org, platformId) pair is unique),'
      );
      console.warn(
        '   but this report tells you that cross-tenant collisions EXIST in your data and may need review.'
      );
      console.warn(
        '   The LEGACY global unique index should not have allowed this — these rows likely pre-date it.\n'
      );
    } else {
      console.log('[migrate] No cross-org duplicates found.');
    }

    // ── Step 2: Report duplicates WITHIN the same org on the same platformId ─
    const intraOrgDupes = await interactions
      .aggregate([
        {
          $group: {
            _id: { organization: '$organization', platformId: '$platformId' },
            count: { $sum: 1 },
            ids: { $push: '$_id' }
          }
        },
        { $match: { count: { $gt: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 100 }
      ])
      .toArray();

    if (intraOrgDupes.length > 0) {
      console.error(`\n❌ Found ${intraOrgDupes.length} duplicate (organization, platformId) pair(s):`);
      for (const d of intraOrgDupes) {
        console.error(
          `   org=${d._id.organization}  platformId=${d._id.platformId}  duplicates=${d.count}  ids=[${d.ids.join(', ')}]`
        );
      }
      console.error(
        '\n❌ These must be resolved before the new compound unique index can be built.'
      );
      console.error('   Delete or merge the duplicate rows, then re-run this migration.');
      process.exit(2);
    } else {
      console.log('[migrate] No intra-org duplicates — safe to proceed.');
    }

    if (REPORT_ONLY) {
      console.log('\n[migrate] --report-only flag set; exiting without changing indexes.');
      return;
    }

    // ── Step 3: List current indexes ──────────────────────────────────────
    const currentIndexes = await interactions.indexes();
    const indexNames = currentIndexes.map((i) => i.name);
    console.log('\n[migrate] Current indexes:', indexNames.join(', '));

    // ── Step 4: Drop legacy global unique index if it exists ──────────────
    if (indexNames.includes(LEGACY_INDEX_NAME)) {
      console.log(`[migrate] Dropping legacy index: ${LEGACY_INDEX_NAME}`);
      await interactions.dropIndex(LEGACY_INDEX_NAME);
      console.log(`[migrate] Dropped ${LEGACY_INDEX_NAME}`);
    } else {
      console.log(`[migrate] Legacy index ${LEGACY_INDEX_NAME} not found — nothing to drop.`);
    }

    // ── Step 5: Build new compound unique index ───────────────────────────
    if (indexNames.includes(NEW_INDEX_NAME)) {
      console.log(`[migrate] Compound index ${NEW_INDEX_NAME} already exists — skipping.`);
    } else {
      console.log(`[migrate] Building compound unique index: ${NEW_INDEX_NAME}`);
      await interactions.createIndex(
        { organization: 1, platformId: 1 },
        { unique: true, name: NEW_INDEX_NAME }
      );
      console.log(`[migrate] Created ${NEW_INDEX_NAME}`);
    }

    // ── Step 6: Verify ────────────────────────────────────────────────────
    const finalIndexes = await interactions.indexes();
    console.log(
      '\n[migrate] Final indexes:',
      finalIndexes.map((i) => `${i.name}${i.unique ? ' (unique)' : ''}`).join(', ')
    );

    console.log('\n✅ [migrate] Migration complete.');
  } catch (err) {
    console.error('\n❌ [migrate] Error:', err.message);
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
    console.log('[migrate] Disconnected from MongoDB');
  }
}

main();
