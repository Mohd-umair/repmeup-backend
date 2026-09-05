/**
 * Redis-backed campaign throughput metrics for ops / super-admin dashboards.
 */
const { getRedisClient } = require('../config/redis');
const {
  campaignSendQueue,
  campaignInboxQueue,
  webhookQueue
} = require('../config/queue');
const logger = require('../config/logger');

const PREFIX = 'campaign:metrics';
const DAY_TTL = 86400 * 2;

function dayKey(suffix) {
  const d = new Date().toISOString().slice(0, 10);
  return `${PREFIX}:${d}:${suffix}`;
}

async function incrMetric(suffix, amount = 1) {
  try {
    const client = getRedisClient();
    const key = dayKey(suffix);
    await client.incrBy(key, amount);
    await client.expire(key, DAY_TTL);
  } catch (err) {
    logger.debug('[CampaignMetrics] incr failed', { suffix, error: err.message });
  }
}

async function getMetric(suffix) {
  try {
    const client = getRedisClient();
    const val = await client.get(dayKey(suffix));
    return parseInt(val, 10) || 0;
  } catch {
    return 0;
  }
}

async function recordSendSuccess(orgId) {
  await incrMetric('sends:total');
  if (orgId) await incrMetric(`sends:org:${orgId}`);
}

async function recordSendFailure(orgId) {
  await incrMetric('sends:failed');
  if (orgId) await incrMetric(`sends:failed:org:${orgId}`);
}

async function recordMeta429(phoneNumberId) {
  await incrMetric('meta:429:total');
  if (phoneNumberId) await incrMetric(`meta:429:waba:${phoneNumberId}`);
}

async function recordBatchCompleted() {
  await incrMetric('batches:completed');
}

async function getRunningCampaignCount() {
  try {
    const client = getRedisClient();
    const val = await client.get(`${PREFIX}:running:campaigns`);
    return parseInt(val, 10) || 0;
  } catch {
    return 0;
  }
}

async function markCampaignRunning(campaignId) {
  try {
    const client = getRedisClient();
    const added = await client.sAdd(`${PREFIX}:running:set`, String(campaignId));
    if (added) await client.incr(`${PREFIX}:running:campaigns`);
    return added === 1;
  } catch {
    return false;
  }
}

async function markCampaignCompleted(campaignId) {
  try {
    const client = getRedisClient();
    const removed = await client.sRem(`${PREFIX}:running:set`, String(campaignId));
    if (removed) await client.decr(`${PREFIX}:running:campaigns`);
    const n = await client.get(`${PREFIX}:running:campaigns`);
    if (parseInt(n, 10) < 0) await client.set(`${PREFIX}:running:campaigns`, '0');
  } catch (err) {
    logger.debug('[CampaignMetrics] mark completed failed', { error: err.message });
  }
}

async function adjustRunningCampaigns(delta) {
  /** @deprecated use markCampaignRunning / markCampaignCompleted */
  try {
    const client = getRedisClient();
    const key = `${PREFIX}:running:campaigns`;
    if (delta > 0) await client.incrBy(key, delta);
    else await client.decrBy(key, Math.abs(delta));
    const n = await client.get(key);
    if (parseInt(n, 10) < 0) await client.set(key, '0');
  } catch (err) {
    logger.debug('[CampaignMetrics] running count adjust failed', { error: err.message });
  }
}

async function isHighVolumeBlast() {
  const running = await getRunningCampaignCount();
  return running >= 1;
}

async function getQueueCounts(queue) {
  try {
    const [waiting, active, delayed, failed] = await Promise.all([
      queue.getWaitingCount(),
      queue.getActiveCount(),
      queue.getDelayedCount(),
      queue.getFailedCount()
    ]);
    return { waiting, active, delayed, failed };
  } catch (err) {
    return { waiting: 0, active: 0, delayed: 0, failed: 0, error: err.message };
  }
}

async function getSnapshot() {
  const [sends, failed, meta429, batches, runningCampaigns] = await Promise.all([
    getMetric('sends:total'),
    getMetric('sends:failed'),
    getMetric('meta:429:total'),
    getMetric('batches:completed'),
    getRunningCampaignCount()
  ]);

  const [campaignSend, campaignInbox, webhook] = await Promise.all([
    getQueueCounts(campaignSendQueue),
    getQueueCounts(campaignInboxQueue),
    getQueueCounts(webhookQueue)
  ]);

  return {
    date: new Date().toISOString().slice(0, 10),
    sendsToday: sends,
    sendFailuresToday: failed,
    meta429Today: meta429,
    batchesCompletedToday: batches,
    runningCampaigns,
    queues: {
      campaignSend,
      campaignInbox,
      webhook
    },
    workerHint: {
      coreWorkerSkipsCampaigns: process.env.ENABLE_CAMPAIGN_IN_CORE_WORKER === 'false',
      dedicatedCampaignWorkerRecommended: true
    }
  };
}

module.exports = {
  recordSendSuccess,
  recordSendFailure,
  recordMeta429,
  recordBatchCompleted,
  adjustRunningCampaigns,
  markCampaignRunning,
  markCampaignCompleted,
  isHighVolumeBlast,
  getSnapshot,
  getMetric
};
