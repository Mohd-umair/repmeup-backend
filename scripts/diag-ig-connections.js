/**
 * Throwaway diagnostic: inspect Instagram (and Facebook) PlatformConnections to
 * understand why IG avatars don't resolve. Prints token kind (EAA vs IGAA),
 * connection type, page/account ids — NO full tokens, NO secrets.
 *
 * Run from backend root:  node scripts/diag-ig-connections.js
 */
require('dotenv').config();
const mongoose = require('mongoose');

(async () => {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('MONGODB_URI not set in env');
    process.exit(1);
  }
  await mongoose.connect(uri);
  const PlatformConnection = require('../src/models/PlatformConnection');

  const conns = await PlatformConnection.find(
    { platform: { $in: ['instagram', 'facebook'] } },
    {
      platform: 1,
      isActive: 1,
      status: 1,
      platformPageId: 1,
      platformUserId: 1,
      accessToken: 1,
      'metadata.connectionType': 1,
      'platformData.businessAccountId': 1,
      organization: 1
    }
  ).lean();

  const tokenKind = (t) => {
    if (!t) return 'NONE';
    if (t.startsWith('IGAA')) return 'IGAA (Instagram Login — CANNOT fetch customer pics)';
    if (t.startsWith('EAA')) return 'EAA (Facebook Login — can fetch pics)';
    return 'other/' + t.slice(0, 4);
  };

  console.log(`\nFound ${conns.length} instagram/facebook connection(s):\n`);
  for (const c of conns) {
    console.log('─'.repeat(60));
    console.log('platform        :', c.platform);
    console.log('org             :', String(c.organization));
    console.log('isActive/status :', c.isActive, '/', c.status);
    console.log('connectionType  :', c.metadata?.connectionType || '(unset)');
    console.log('platformPageId  :', c.platformPageId || '(none)');
    console.log('platformUserId  :', c.platformUserId || '(none)');
    console.log('businessAccount :', c.platformData?.businessAccountId || '(none)');
    console.log('token kind      :', tokenKind(c.accessToken));
  }
  console.log('─'.repeat(60));

  await mongoose.disconnect();
  process.exit(0);
})().catch((e) => {
  console.error('diag failed:', e.message);
  process.exit(1);
});
