/**
 * Meta error governance: 429 tracking, WABA auto-pause, transient send classification.
 */
const PlatformConnection = require('../models/PlatformConnection');
const WhatsAppCampaign = require('../models/WhatsAppCampaign');
const { getRedisClient } = require('../config/redis');
const campaignConfig = require('../config/campaignConfig');
const campaignMetrics = require('./campaignMetricsService');
const logger = require('../config/logger');

function isTransientSendError(err) {
  if (!err) return false;
  const status = err.httpStatus || err.status;
  if (status === 429) return true;
  if (status >= 500 && status < 600) return true;
  const code = err.metaCode || err.code;
  if (code === 130429 || code === '130429') return true;
  const msg = String(err.message || '').toLowerCase();
  return msg.includes('timeout') || msg.includes('econnreset') || msg.includes('socket');
}

function isRateLimitError(err) {
  const status = err?.httpStatus || err?.status;
  if (status === 429) return true;
  const code = err?.metaCode || err?.code;
  return code === 130429 || code === '130429';
}

/**
 * Record Meta 429; pause WABA + running campaigns when threshold exceeded.
 */
async function recordRateLimitError(phoneNumberId, campaignId) {
  if (!phoneNumberId) return;

  await campaignMetrics.recordMeta429(phoneNumberId);

  try {
    const client = getRedisClient();
    const windowKey = `waba:429:${phoneNumberId}:${Math.floor(Date.now() / 1000 / campaignConfig.waba429WindowSec)}`;
    const count = await client.incr(windowKey);
    await client.expire(windowKey, campaignConfig.waba429WindowSec * 2);

    if (count >= campaignConfig.waba429Threshold) {
      await pauseWaba(phoneNumberId, campaignId, 'meta_rate_limit');
    }
  } catch (err) {
    logger.warn('[CampaignGovernance] 429 tracking failed', { error: err.message });
  }
}

async function pauseWaba(phoneNumberId, campaignId, reason) {
  const pauseUntil = Date.now() + campaignConfig.wabaPauseMs;
  try {
    const client = getRedisClient();
    await client.set(`waba:paused:${phoneNumberId}`, String(pauseUntil), { EX: Math.ceil(campaignConfig.wabaPauseMs / 1000) + 60 });
  } catch (err) {
    logger.warn('[CampaignGovernance] failed to set WABA pause flag', { error: err.message });
  }

  await PlatformConnection.updateMany(
    {
      platform: 'whatsapp',
      $or: [
        { 'platformData.phoneNumberId': String(phoneNumberId) },
        { platformUserId: String(phoneNumberId) }
      ]
    },
    {
      $set: {
        'platformData.campaignPausedUntil': new Date(pauseUntil),
        'platformData.campaignPauseReason': reason
      }
    }
  );

  if (campaignId) {
    await WhatsAppCampaign.findByIdAndUpdate(campaignId, {
      $set: { status: 'paused', pauseReason: reason }
    });
    // Invalidate cached status so in-flight batches see the pause within the same tick.
    try {
      await require('./campaignRateLimiter').invalidateCampaignStatus(campaignId);
    } catch {
      /* best-effort */
    }
  }

  logger.warn('[CampaignGovernance] WABA paused due to rate limits', {
    phoneNumberId,
    campaignId,
    reason,
    pauseUntil: new Date(pauseUntil).toISOString()
  });
}

/**
 * Update WABA tier metadata (from admin or periodic Meta sync).
 */
async function updateWabaMetadata(connectionId, { messagingTier, qualityRating } = {}) {
  const update = {};
  if (messagingTier) update['platformData.wabaMessagingTier'] = messagingTier;
  if (qualityRating) update['platformData.wabaQualityRating'] = qualityRating;
  if (!Object.keys(update).length) return null;
  return PlatformConnection.findByIdAndUpdate(connectionId, { $set: update }, { new: true }).lean();
}

module.exports = {
  isTransientSendError,
  isRateLimitError,
  recordRateLimitError,
  pauseWaba,
  updateWabaMetadata
};
