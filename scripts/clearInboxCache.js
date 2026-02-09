require('dotenv').config();
const Redis = require('ioredis');

/**
 * Clear all inbox cache to force fresh queries
 */

async function clearInboxCache() {
  try {
    const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');
    
    console.log('🔍 Searching for inbox cache keys...');
    
    // Find all interactions:* keys
    const keys = await redis.keys('interactions:*');
    
    console.log(`📊 Found ${keys.length} cache keys\n`);
    
    if (keys.length === 0) {
      console.log('✅ No cache to clear!');
      await redis.quit();
      return;
    }
    
    // Delete all keys
    const result = await redis.del(...keys);
    
    console.log(`✅ Deleted ${result} cache keys\n`);
    console.log(`🎉 Inbox cache cleared! Fresh queries will now use updated sentiment data.`);
    
    await redis.quit();
  } catch (error) {
    console.error('❌ Error:', error);
    process.exit(1);
  }
}

clearInboxCache();
