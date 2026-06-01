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
    const allowed = await tryTakeToken(key, rate, burst);
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

  try {
    const now = Date.now() / 1000;
    const result = await client.eval(script, {
      keys: [key],
      arguments: [String(rate), String(burst), String(now)]
    });
    return result === 1;
  } catch (err) {
    logger.warn('[CampaignRateLimiter] Redis eval failed — allowing send', { error: err.message });
    return true;
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
  isWabaPaused
};
