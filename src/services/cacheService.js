const crypto = require('crypto');
const { getRedisClient } = require('../config/redis');

/**
 * Recursively canonicalize a value so two equivalent objects produce the same JSON string.
 *   - Object keys are sorted alphabetically
 *   - Array elements are sorted (stringified) so [a,b] and [b,a] hash the same
 *   - Date instances are normalized to ISO strings
 *   - undefined values are dropped
 *
 * Used by analyticsHashKey so cache hits don't depend on filter argument order.
 */
function canonicalize(value) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) {
    return value
      .map(canonicalize)
      .filter((v) => v !== undefined)
      .sort((a, b) => {
        const sa = JSON.stringify(a);
        const sb = JSON.stringify(b);
        return sa < sb ? -1 : sa > sb ? 1 : 0;
      });
  }
  if (typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value).sort()) {
      const v = canonicalize(value[k]);
      if (v !== undefined) out[k] = v;
    }
    return out;
  }
  return value;
}

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

  /**
   * Stable cache key for an analytics endpoint that takes filter inputs.
   *
   * Hashes the canonicalized filter object (sorted keys, sorted arrays) so that
   *   { platforms: ['instagram','facebook'] }  and  { platforms: ['facebook','instagram'] }
   * produce the SAME key.
   *
   * Key shape: analytics:{orgId}:{type}:{12-char hash}
   *
   * @param {string|object} orgId
   * @param {string} type    - endpoint identifier, e.g. 'dashboard' | 'engagement' | 'platform:instagram'
   * @param {object} filters - any JSON-serializable filter object (dateRange, platforms[], types[], …)
   */
  analyticsHashKey(orgId, type, filters = {}) {
    const canonical = JSON.stringify(canonicalize(filters));
    const hash = crypto.createHash('sha256').update(canonical).digest('hex').substring(0, 12);
    return `analytics:${String(orgId)}:${type}:${hash}`;
  }

  /**
   * Drop every cached analytics entry for an organization.
   * Call this from any write path that materially changes analytics output
   * (new interactions, replies, post publishing) when you need invalidation
   * tighter than the natural TTL.
   *
   * Implementation note: uses KEYS under the hood — fine for the small number
   * of cached analytics keys per org, NOT suitable to call in a tight loop.
   *
   * @param {string} orgId
   */
  async invalidateAnalytics(orgId) {
    return this.delPattern(`analytics:${String(orgId)}:*`);
  }

  /**
   * Generate cache key for resolved entitlements (plan + limits + usage).
   * Used by services/entitlementsService.js.
   */
  entitlementsKey(orgId) {
    return `entitlements:${orgId}`;
  }

  // ── JWT Revocation ──────────────────────────────────────────────────────────

  /**
   * Derive a short, stable Redis key from a raw JWT string.
   * Using a SHA-256 hash avoids storing the full token value in Redis.
   */
  _tokenHash(token) {
    return `jwt:bl:${crypto.createHash('sha256').update(token).digest('hex')}`;
  }

  /**
   * Add a token to the revocation blacklist.
   * TTL is set to the token's remaining lifetime so Redis auto-expires the entry
   * when the token would have expired anyway — no manual cleanup needed.
   *
   * @param {string} token       - Raw JWT string
   * @param {number} expiresAt   - Unix timestamp (seconds) from the token's `exp` claim
   */
  async blacklistToken(token, expiresAt) {
    try {
      const ttl = Math.max(1, expiresAt - Math.floor(Date.now() / 1000));
      const redis = getRedisClient();
      await redis.setEx(this._tokenHash(token), ttl, '1');
      return true;
    } catch (error) {
      console.error('Cache blacklistToken error:', error);
      return false;
    }
  }

  /**
   * Returns true if the token has been revoked (is in the blacklist).
   * On Redis error, returns false (fail-open) to avoid locking users out
   * due to a transient Redis outage.
   *
   * @param {string} token - Raw JWT string
   * @returns {Promise<boolean>}
   */
  async isTokenBlacklisted(token) {
    try {
      const redis = getRedisClient();
      const result = await redis.exists(this._tokenHash(token));
      return result === 1;
    } catch (error) {
      console.error('Cache isTokenBlacklisted error:', error);
      return false; // fail-open: Redis outage should not lock users out
    }
  }
}

module.exports = new CacheService();

