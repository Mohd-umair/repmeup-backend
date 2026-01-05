const { getRedisClient } = require('../config/redis');

class CacheService {
  constructor() {
    this.defaultTTL = 3600; // 1 hour
  }

  /**
   * Get value from cache
   */
  async get(key) {
    try {
      const redis = getRedisClient();
      const data = await redis.get(key);
      return data ? JSON.parse(data) : null;
    } catch (error) {
      console.error('Cache get error:', error);
      return null;
    }
  }

  /**
   * Set value in cache
   */
  async set(key, value, ttl = this.defaultTTL) {
    try {
      const redis = getRedisClient();
      await redis.setEx(key, ttl, JSON.stringify(value));
      return true;
    } catch (error) {
      console.error('Cache set error:', error);
      return false;
    }
  }

  /**
   * Delete key from cache
   */
  async del(key) {
    try {
      const redis = getRedisClient();
      await redis.del(key);
      return true;
    } catch (error) {
      console.error('Cache delete error:', error);
      return false;
    }
  }

  /**
   * Check if key exists
   */
  async exists(key) {
    try {
      const redis = getRedisClient();
      const result = await redis.exists(key);
      return result === 1;
    } catch (error) {
      console.error('Cache exists error:', error);
      return false;
    }
  }

  /**
   * Delete keys matching pattern
   */
  async delPattern(pattern) {
    try {
      const redis = getRedisClient();
      const keys = await redis.keys(pattern);
      if (keys.length > 0) {
        await redis.del(keys);
      }
      return true;
    } catch (error) {
      console.error('Cache delete pattern error:', error);
      return false;
    }
  }

  /**
   * Increment value
   */
  async increment(key, amount = 1) {
    try {
      const redis = getRedisClient();
      return await redis.incrBy(key, amount);
    } catch (error) {
      console.error('Cache increment error:', error);
      return 0;
    }
  }

  /**
   * Cache wrapper for functions
   */
  async wrap(key, fn, ttl = this.defaultTTL) {
    try {
      // Try to get from cache
      const cached = await this.get(key);
      if (cached !== null) {
        return cached;
      }

      // If not in cache, execute function
      const result = await fn();
      
      // Save to cache
      await this.set(key, result, ttl);
      
      return result;
    } catch (error) {
      console.error('Cache wrap error:', error);
      // If caching fails, just return the function result
      return await fn();
    }
  }

  /**
   * Generate cache key for user data
   */
  userKey(userId) {
    return `user:${userId}`;
  }

  /**
   * Generate cache key for organization data
   */
  orgKey(orgId) {
    return `org:${orgId}`;
  }

  /**
   * Generate cache key for interactions
   */
  interactionsKey(orgId, filters = {}) {
    const filterStr = Object.entries(filters)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}:${v}`)
      .join(':');
    return `interactions:${orgId}${filterStr ? ':' + filterStr : ''}`;
  }

  /**
   * Generate cache key for analytics
   */
  analyticsKey(orgId, type, date) {
    return `analytics:${orgId}:${type}:${date}`;
  }
}

module.exports = new CacheService();

