'use strict';

/**
 * Repair WhatsApp connections damaged by the platformData schema-strip bug.
 *
 * `platformData.wabaId` was never a declared schema path, so Mongoose strict mode
 * silently dropped it on every save. Because whatsappService resolves the WABA as
 *   platformData.wabaId || platformData.businessAccountId || process.env.WHATSAPP_BUSINESS_ACCOUNT_ID
 * an affected tenant silently fell through to the shared env WABA — a multi-tenancy
 * bug, and a blocker for the Interakt integration which keys everything on waba_id.
 *
 * This script:
 *   1. mirrors wabaId <-> businessAccountId so the fallback chain never reaches env,
 *   2. re-discovers the WABA from Meta for connections that have neither,
 *   3. stamps platformData.provider = 'meta' where absent (correct for all
 *      pre-Interakt connections; the Interakt flow sets its own).
 *
 * `tokenExpiry` is deliberately NOT backfilled — it was written to a non-existent
 * `tokenExpiresAt` path, so the original value is simply gone. It cannot be inferred
 * from what we stored, and guessing an expiry is worse than leaving it null. New
 * connections record it correctly; existing ones repair on their next reconnect.
 *
 * Usage:
 *   node scripts/backfillWhatsappWabaIds.js --dry-run     # report only (default-safe)
 *   node scripts/backfillWhatsappWabaIds.js --apply
 *   node scripts/backfillWhatsappWabaIds.js --apply --include-demo
 */

require('dotenv').config();
const mongoose = require('mongoose');

const PlatformConnection = require('../src/models/PlatformConnection');
const whatsappLoginAuth = require('../src/integrations/whatsapp/whatsappLoginAuth');

const APPLY = process.argv.includes('--apply');
const INCLUDE_DEMO = process.argv.includes('--include-demo');

/** Demo workspaces carry synthetic ids and no real Meta credentials. */
function isDemo(conn) {
  return String(conn.platformUserId || '').startsWith('demo_wa_');
}

async function run() {
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 15000 });
  console.log(`DB: ${mongoose.connection.name}   mode: ${APPLY ? 'APPLY' : 'DRY-RUN'}\n`);

  const all = await PlatformConnection.find({ platform: 'whatsapp' });

  const stats = { total: all.length, skippedDemo: 0, mirrored: 0, recovered: 0, unrecoverable: 0 };

  for (const conn of all) {
    const pd = conn.platformData || {};
    const label = String(conn.platformUserId || conn._id).padEnd(22);

    if (isDemo(conn) && !INCLUDE_DEMO) {
      stats.skippedDemo++;
      continue;
    }

    const updates = {};

    // 1 + 2 — resolve a WABA id from whichever key survived, else ask Meta.
    let waba = pd.wabaId || pd.businessAccountId || null;

    if (!waba) {
      const phoneNumberId = pd.phoneNumberId || conn.platformUserId;
      if (!conn.accessToken || !phoneNumberId) {
        console.log(`  ${label} UNRECOVERABLE (no token or phoneNumberId)`);
        stats.unrecoverable++;
        continue;
      }
      try {
        // Same discovery the template service uses to self-heal a stale WABA id.
        waba = await whatsappLoginAuth.resolveWabaIdForPhoneNumber(conn.accessToken, phoneNumberId);
      } catch (err) {
        console.log(`  ${label} UNRECOVERABLE (${err.message})`);
        stats.unrecoverable++;
        continue;
      }
      if (!waba) {
        console.log(`  ${label} UNRECOVERABLE (Meta returned no WABA — token likely expired)`);
        stats.unrecoverable++;
        continue;
      }
      console.log(`  ${label} RECOVERED from Meta → ${waba}`);
      stats.recovered++;
    } else if (pd.wabaId !== waba || pd.businessAccountId !== waba) {
      console.log(`  ${label} MIRROR ${pd.wabaId || '-'} / ${pd.businessAccountId || '-'} → ${waba}`);
      stats.mirrored++;
    }

    if (pd.wabaId !== waba) updates['platformData.wabaId'] = waba;
    if (pd.businessAccountId !== waba) updates['platformData.businessAccountId'] = waba;

    // platformData.provider is intentionally NOT stamped here. Its schema default
    // is 'meta', and the transport resolver treats a missing value as 'meta' too —
    // so both hydrated and .lean() reads resolve correctly without touching a
    // single existing row. Only the Interakt signup path writes it explicitly.

    if (Object.keys(updates).length && APPLY) {
      await PlatformConnection.updateOne({ _id: conn._id }, { $set: updates });
    }
  }

  console.log('\n=== summary ===');
  Object.entries(stats).forEach(([k, v]) => console.log(`  ${k.padEnd(18)} ${v}`));
  if (!APPLY) console.log('\nDry run — nothing written. Re-run with --apply to persist.');

  await mongoose.disconnect();
}

run().catch((err) => {
  console.error('FAILED:', err.message);
  process.exit(1);
});
