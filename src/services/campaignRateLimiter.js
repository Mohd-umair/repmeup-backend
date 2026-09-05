/**
 * Per-WABA (phoneNumberId) token-bucket rate limiter in Redis.
 * Prevents self-DDoS and respects Meta throughput per phone number.
 */
const { getRedisClient } = require('../config/redis');
const campaignConfig = require('../config/campaignConfig');
const logger = require('../config/logger');

const BUCKET_PREFIX = 'waba:send:bucket:';

/**
 * Acquire one send token for phoneNumberId. Waits with short polling until available
 * or maxWaitMs exceeded (throws so job can retry with backoff).
 *
 * @param {string} phoneNumberId
 * @param {number} [maxWaitMs=30000]
 */
async function acquireSendToken(phoneNumberId, maxWaitMs = 30000) {
  if (!phoneNumberId) return;

  const rate = Math.max(1, campaignConfig.sendsPerSecond);
  const burst = rate * 2;
  const key = `${BUCKET_PREFIX}${phoneNumberId}`;
  const started = Date.now();

  while (Date.now() - started < maxWaitMs) {
    let allowed;
    try {
      allowed = await tryTakeToken(key, rate, burst);
    } catch (err) {
      // Fail CLOSED: if Redis is unavailable we cannot trust our throughput cap.
      // Throwing lets the batch job retry with backoff rather than blasting Meta
      // uncapped (which would trigger 429s and damage the WABA quality rating).
      logger.error('[CampaignRateLimiter] Redis unavailable — refusing send (fail-closed)', {
        phoneNumberId,
        error: err.message
      });
      const closed = new Error('Rate limiter unavailable (Redis) — sending paused for safety');
      closed.code = 'WABA_RATE_LIMITER_UNAVAILABLE';
      throw closed;
    }
    if (allowed) return;

    const waitMs = Math.min(250, Math.ceil(1000 / rate));
    await sleep(waitMs);
  }

  const err = new Error(`WABA rate limit timeout for ${phoneNumberId}`);
  err.code = 'WABA_RATE_LIMIT_TIMEOUT';
  throw err;
}

/**
 * Lua token bucket: returns 1 if token consumed, 0 if empty.
 */
async function tryTakeToken(key, rate, burst) {
  const client = getRedisClient();
  const script = `
    local key = KEYS[1]
    local rate = tonumber(ARGV[1])
    local burst = tonumber(ARGV[2])
    local now = tonumber(ARGV[3])
    local data = redis.call('HMGET', key, 'tokens', 'last')
    local tokens = tonumber(data[1])
    local last = tonumber(data[2])
    if tokens == nil then
      tokens = burst
      last = now
    else
      local delta = math.max(0, now - last)
      tokens = math.min(burst, tokens + delta * rate)
      last = now
    end
    if tokens >= 1 then
      tokens = tokens - 1
      redis.call('HMSET', key, 'tokens', tokens, 'last', last)
      redis.call('EXPIRE', key, 3600)
      return 1
    end
    redis.call('HMSET', key, 'tokens', tokens, 'last', last)
    redis.call('EXPIRE', key, 3600)
    return 0
  `;

  const now = Date.now() / 1000;
  const result = await client.eval(script, {
    keys: [key],
    arguments: [String(rate), String(burst), String(now)]
  });
  return result === 1;
}

const STATUS_CACHE_PREFIX = 'campaign:status:';
const STATUS_CACHE_TTL_MS = 2000;
/** Process-local memo behind the Redis cache, so a single batch doesn't even hit Redis 100×. */
const localStatusCache = new Map();

/**
 * Cheap, near-real-time campaign status lookup for the per-recipient interrupt check.
 *
 * Replaces a `WhatsAppCampaign.findById` per recipient (which melted the Mongo primary
 * under load) with a ~2s Redis-cached value plus an in-process memo. A pause/cancel
 * therefore takes effect within ~2s instead of instantly — an acceptable trade for
 * eliminating up to N (recipient-count) hot reads against a single document.
 *
 * @param {string} campaignId
 * @param {() => Promise<string|null>} loader - fetches the authoritative status from Mongo
 * @returns {Promise<string|null>}
 */
async function getCampaignStatusCached(campaignId, loader) {
  const now = Date.now();
  const memo = localStatusCache.get(campaignId);
  if (memo && now - memo.at < STATUS_CACHE_TTL_MS) return memo.status;

  const key = `${STATUS_CACHE_PREFIX}${campaignId}`;
  try {
    const client = getRedisClient();
    const cached = await client.get(key);
    if (cached !== null && cached !== undefined) {
      localStatusCache.set(campaignId, { status: cached, at: now });
      return cached;
    }
    const status = await loader();
    if (status) {
      await client.set(key, status, { PX: STATUS_CACHE_TTL_MS });
    }
    localStatusCache.set(campaignId, { status, at: now });
    return status;
  } catch (err) {
    // On Redis failure, fall back to the authoritative loader (correctness over speed).
    logger.warn('[CampaignRateLimiter] status cache miss — loading from DB', { error: err.message });
    const status = await loader();
    localStatusCache.set(campaignId, { status, at: now });
    return status;
  }
}

/** Invalidate the cached status immediately (call on pause/resume/cancel for instant effect). */
async function invalidateCampaignStatus(campaignId) {
  localStatusCache.delete(String(campaignId));
  try {
    await getRedisClient().del(`${STATUS_CACHE_PREFIX}${campaignId}`);
  } catch {
    /* best-effort */
  }
}

async function isWabaPaused(phoneNumberId) {
  if (!phoneNumberId) return false;
  try {
    const client = getRedisClient();
    const until = await client.get(`waba:paused:${phoneNumberId}`);
    if (!until) return false;
    if (Date.now() < parseInt(until, 10)) return true;
    await client.del(`waba:paused:${phoneNumberId}`);
    return false;
  } catch {
    return false;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {
  acquireSendToken,
  isWabaPaused,
  getCampaignStatusCached,
  invalidateCampaignStatus
};
