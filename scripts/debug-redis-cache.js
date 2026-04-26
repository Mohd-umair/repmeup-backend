/**
 * debug-redis-cache.js
 * Run: node scripts/debug-redis-cache.js
 * Shows: all analytics entries in Redis cache
 */

require('dotenv').config();
const { createClient } = require('redis');

async function run() {
  const REDIS_URL = process.env.REDIS_URL || process.env.REDIS_URI || 'redis://localhost:6379';
  const client = createClient({ url: REDIS_URL });

  client.on('error', err => console.error('Redis error:', err));
  await client.connect();
  console.log('✅ Redis connected');

  const keys = await client.keys('analytics:*');
  console.log(`\n📊 Found ${keys.length} analytics cache entries\n`);

  for (const key of keys) {
    try {
      const ttl = await client.ttl(key);
      const val = await client.get(key);
      const parsed = JSON.parse(val);
      console.log('Key:', key);
      console.log('  TTL remaining:', ttl, 'seconds');
      console.log('  timeSeries.length:', parsed?.timeSeries?.length ?? 'N/A');
      console.log('  totalInteractions:', parsed?.overview?.totalInteractions?.value ?? 'N/A');
      console.log('  sentimentBreakdown:', JSON.stringify(parsed?.sentimentBreakdown ?? 'N/A'));
      console.log('');
    } catch (e) {
      console.log('Key:', key, '— parse error:', e.message);
    }
  }

  if (keys.length > 0) {
    console.log('\n🧹 Flushing all analytics cache entries...');
    await client.del(keys);
    console.log('✅ Cache cleared! Next dashboard load will fetch fresh data from MongoDB.');
  }

  await client.disconnect();
}

run().catch(err => {
  console.error('❌ Error:', err.message);
  process.exit(1);
});
