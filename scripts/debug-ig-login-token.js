/**
 * debug-ig-login-token.js
 *
 * Inspect an Instagram Login (IGAA) connection end-to-end:
 *   1. GET /me                  → token identity (ISUID, user_id, username)
 *   2. GET /me/subscribed_apps  → which Meta apps are webhook-subscribed
 *   3. GET /debug_token         → token scopes, expiry, validity (via app token)
 *   4. POST /{ISUID}/messages   → dry-run send to a recipient ID (optional)
 *
 * Usage:
 *   Inspect the token stored on a connection in MongoDB:
 *     node scripts/debug-ig-login-token.js --username rep_me_up
 *     node scripts/debug-ig-login-token.js --id <connectionId>
 *
 *   Inspect a raw IGAA token pasted on the CLI (no DB lookup — useful for the
 *   token you just generated inside Meta's "Step 2: Generate access tokens"):
 *     node scripts/debug-ig-login-token.js --token IGAAxxx...
 *
 *   Reproduce the send that throws 2534037:
 *     node scripts/debug-ig-login-token.js --username rep_me_up --recipient 934610485923900
 *     node scripts/debug-ig-login-token.js --token IGAAxxx... --recipient 934610485923900
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const mongoose = require('mongoose');
const axios = require('axios');

const MONGO_URI = process.env.MONGO_URI || process.env.MONGODB_URI;
const IG_GRAPH = 'https://graph.instagram.com/v23.0';
const FB_GRAPH = 'https://graph.facebook.com/v23.0';

const APP_ID = process.env.INSTAGRAM_LOGIN_APP_ID;
const APP_SECRET = process.env.INSTAGRAM_LOGIN_APP_SECRET;

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const val = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
      out[key] = val;
    }
  }
  return out;
}

async function safeGet(url, params, label) {
  try {
    const res = await axios.get(url, { params, timeout: 10000 });
    console.log(`\n✅ ${label}`);
    console.log(JSON.stringify(res.data, null, 2));
    return { ok: true, data: res.data };
  } catch (err) {
    const body = err.response?.data || { message: err.message };
    console.log(`\n❌ ${label}`);
    console.log(JSON.stringify(body, null, 2));
    return { ok: false, error: body };
  }
}

async function safePost(url, body, params, label) {
  try {
    const res = await axios.post(url, body, { params, timeout: 10000 });
    console.log(`\n✅ ${label}`);
    console.log(JSON.stringify(res.data, null, 2));
    return { ok: true, data: res.data };
  } catch (err) {
    const body = err.response?.data || { message: err.message };
    console.log(`\n❌ ${label}`);
    console.log(JSON.stringify(body, null, 2));
    return { ok: false, error: body };
  }
}

async function main() {
  const args = parseArgs(process.argv);

  if (!args.username && !args.id && !args.token) {
    console.error('Usage:');
    console.error('  node scripts/debug-ig-login-token.js --username <ig_username> [--recipient <id>]');
    console.error('  node scripts/debug-ig-login-token.js --id <connectionId>      [--recipient <id>]');
    console.error('  node scripts/debug-ig-login-token.js --token <IGAA...>        [--recipient <id>]');
    process.exit(1);
  }

  let token = null;
  let isuid = null;

  if (args.token) {
    token = String(args.token);
    if (!token.startsWith('IGAA')) {
      console.warn(`⚠️  Token doesn't start with 'IGAA'. Instagram Login tokens start with IGAA; you may have pasted a Facebook-Login token.`);
    }
    console.log('─────────────────────────────────────────────────────');
    console.log('Using raw token from --token argument (no DB lookup)');
    console.log(`  accessToken prefix  : ${token.substring(0, 6)}…  length=${token.length}`);
    console.log('─────────────────────────────────────────────────────');
    // ISUID will be resolved via /me below before any send attempt.
  } else {
    if (!MONGO_URI) {
      console.error('❌ MONGO_URI is not set in .env');
      process.exit(1);
    }

    await mongoose.connect(MONGO_URI);
    const PlatformConnection = require('../src/models/PlatformConnection');

    const query = {
      platform: 'instagram',
      accessToken: { $regex: /^IGAA/ },
      isActive: true
    };
    if (args.id) query._id = args.id;
    if (args.username) query.platformUsername = args.username;

    const conn = await PlatformConnection.findOne(query).lean();
    if (!conn) {
      console.error(`❌ No active IGAA connection found for query: ${JSON.stringify(query)}`);
      await mongoose.disconnect();
      process.exit(1);
    }

    console.log('─────────────────────────────────────────────────────');
    console.log(`Connection: @${conn.platformUsername}`);
    console.log(`  _id                 : ${conn._id}`);
    console.log(`  organizationId      : ${conn.organizationId}`);
    console.log(`  platformUserId      : ${conn.platformUserId}      (global IGBAID — matches webhook entry.id)`);
    console.log(`  platformPageId      : ${conn.platformPageId}`);
    console.log(`  metadata.igLoginScopedId (ISUID): ${conn.metadata?.igLoginScopedId || '(missing)'}`);
    console.log(`  connectionType      : ${conn.metadata?.connectionType || '(missing)'}`);
    console.log(`  accessToken prefix  : ${conn.accessToken.substring(0, 6)}…  length=${conn.accessToken.length}`);
    console.log('─────────────────────────────────────────────────────');

    token = conn.accessToken;
    isuid = conn.metadata?.igLoginScopedId || conn.platformUserId;
  }

  // 1) /me — confirm token identity
  const meRes = await safeGet(
    `${IG_GRAPH}/me`,
    { fields: 'id,user_id,username,account_type', access_token: token },
    'GET /me   (token identity)'
  );

  if (!isuid && meRes.ok && meRes.data?.id) {
    isuid = String(meRes.data.id);
    console.log(`\nℹ️  Resolved ISUID from /me: ${isuid}`);
  }

  // 2) /me/subscribed_apps — which app(s) are subscribed
  await safeGet(
    `${IG_GRAPH}/me/subscribed_apps`,
    { access_token: token },
    'GET /me/subscribed_apps   (this app\'s subscription for this IG account)'
  );

  // 3) /debug_token — scopes, expiry, app ID the token was issued for
  if (APP_ID && APP_SECRET) {
    await safeGet(
      `${FB_GRAPH}/debug_token`,
      {
        input_token: token,
        access_token: `${APP_ID}|${APP_SECRET}`
      },
      'GET /debug_token   (scopes + expiry + app_id)'
    );
  } else {
    console.log('\n⚠️  Skipping /debug_token — INSTAGRAM_LOGIN_APP_ID / INSTAGRAM_LOGIN_APP_SECRET not set in .env');
  }

  // 4) Dry-run send — reproduces the 2534037 path
  if (args.recipient) {
    if (!isuid) {
      console.log('\n❌ Cannot send — ISUID could not be resolved from /me.');
    } else {
      await safePost(
        `${IG_GRAPH}/${isuid}/messages`,
        {
          recipient: { id: String(args.recipient) },
          message: { text: `[debug] Test message at ${new Date().toISOString()}` }
        },
        { access_token: token },
        `POST /${isuid}/messages   (dry-run send to ${args.recipient})`
      );
    }
  } else {
    console.log('\nℹ️  Add --recipient <IGSID> to attempt a real send.');
  }

  try { await mongoose.disconnect(); } catch (_) {}
}

main().catch(async (err) => {
  console.error('Fatal:', err.message);
  try { await mongoose.disconnect(); } catch (_) {}
  process.exit(1);
});
