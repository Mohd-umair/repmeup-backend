/**
 * Fan-out campaign send work into idempotent batch jobs + completion coordination.
 */
const WhatsAppCampaign = require('../models/WhatsAppCampaign');
const WhatsAppCampaignRecipient = require('../models/WhatsAppCampaignRecipient');
const { campaignSendQueue, queueConfig } = require('../config/queue');
const campaignConfig = require('../config/campaignConfig');
const campaignMetrics = require('./campaignMetricsService');
const logger = require('../config/logger');

/**
 * Enqueue send-batch jobs for all pending recipients (or resume after pause).
 */
async function enqueueCampaignBatches(campaignId) {
  const campaign = await WhatsAppCampaign.findById(campaignId).select('status organization').lean();
  if (!campaign) {
    logger.warn('[CampaignDispatch] Campaign not found', { campaignId });
    return { enqueued: 0 };
  }
  if (campaign.status !== 'running') {
    logger.info('[CampaignDispatch] Skip enqueue — not running', { campaignId, status: campaign.status });
    return { enqueued: 0 };
  }

  const pendingIds = await WhatsAppCampaignRecipient.find({
    campaign: campaignId,
    status: 'pending'
  })
    .select('_id')
    .lean();

  if (pendingIds.length === 0) {
    await maybeCompleteCampaign(campaignId);
    return { enqueued: 0 };
  }

  const batchSize = campaignConfig.batchSize;
  let enqueued = 0;

  for (let i = 0; i < pendingIds.length; i += batchSize) {
    const chunk = pendingIds.slice(i, i + batchSize);
    const batchIndex = Math.floor(i / batchSize);
    await campaignSendQueue.add(
      {
        type: 'send-batch',
        campaignId: campaignId.toString(),
        batchIndex,
        recipientIds: chunk.map((r) => r._id.toString())
      },
      {
        ...queueConfig,
        jobId: `campaign-${campaignId}-batch-${batchIndex}`,
        priority: 5
      }
    );
    enqueued++;
  }

  await campaignMetrics.markCampaignRunning(campaignId);

  logger.info('[CampaignDispatch] Enqueued batch jobs', {
    campaignId,
    batches: enqueued,
    recipients: pendingIds.length
  });

  return { enqueued, recipients: pendingIds.length };
}

/**
 * After a batch finishes, mark campaign complete when no pending recipients remain.
 */
async function maybeCompleteCampaign(campaignId) {
  const pending = await WhatsAppCampaignRecipient.countDocuments({
    campaign: campaignId,
    status: 'pending'
  });

  if (pending > 0) return { completed: false, pending };

  const fresh = await WhatsAppCampaign.findById(campaignId).select('status').lean();
  if (!fresh || !['running', 'paused'].includes(fresh.status)) {
    return { completed: false, status: fresh?.status };
  }

  const finalStats = await WhatsAppCampaignRecipient.aggregate([
    { $match: { campaign: fresh._id } },
    { $group: { _id: '$status', count: { $sum: 1 } } }
  ]);
  const statMap = {};
  finalStats.forEach((s) => {
    statMap[s._id] = s.count;
  });

  await WhatsAppCampaign.findByIdAndUpdate(campaignId, {
    $set: {
      status: 'completed',
      finishedAt: new Date(),
      'stats.sent': statMap.sent || 0,
      'stats.failed': statMap.failed || 0,
      'stats.pending': statMap.pending || 0
    }
  });

  await campaignMetrics.markCampaignCompleted(campaignId);

  logger.info('[CampaignDispatch] Campaign completed', {
    campaignId,
    sent: statMap.sent || 0,
    failed: statMap.failed || 0
  });

  return { completed: true, sent: statMap.sent || 0, failed: statMap.failed || 0 };
}

/**
 * Re-enqueue batch jobs for running campaigns that still have pending recipients
 * (e.g. after transient Meta errors).
 */
async function retryPendingForRunningCampaigns() {
  const running = await WhatsAppCampaign.find({ status: 'running' }).select('_id').lean();
  let dispatched = 0;
  for (const { _id } of running) {
    const pending = await WhatsAppCampaignRecipient.countDocuments({
      campaign: _id,
      status: 'pending'
    });
    if (pending === 0) continue;
    const result = await enqueueCampaignBatches(_id.toString());
    if (result.enqueued > 0) dispatched++;
  }
  return { campaigns: running.length, dispatched };
}

module.exports = {
  enqueueCampaignBatches,
  maybeCompleteCampaign,
  retryPendingForRunningCampaigns
};
