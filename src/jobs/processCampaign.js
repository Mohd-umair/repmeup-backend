/**
 * Campaign Send Job
 *
 * Handles two job types dispatched to the `campaign-send` Bull queue:
 *
 *  1. { type: 'schedule-poller' }   — repeatable job (every 30s); finds
 *     campaigns whose scheduledAt has passed and enqueues a 'send' job.
 *
 *  2. { type: 'send', campaignId }  — processes one campaign in batches:
 *     fetches pending recipients → sends template → marks sent/failed →
 *     updates campaign.stats → transitions status on completion.
 */

const WhatsAppCampaign = require('../models/WhatsAppCampaign');
const WhatsAppCampaignRecipient = require('../models/WhatsAppCampaignRecipient');
const PlatformConnection = require('../models/PlatformConnection');
const whatsappService = require('../integrations/whatsapp/whatsappService');
const { campaignSendQueue, queueConfig } = require('../config/queue');
const logger = require('../config/logger');

const BATCH_SIZE = 50;

// ─── Schedule poller ──────────────────────────────────────────────────────────

async function runSchedulePoller() {
  const now = new Date();
  const dueCampaigns = await WhatsAppCampaign.find({
    status: 'scheduled',
    scheduledAt: { $lte: now }
  }).select('_id').lean();

  if (dueCampaigns.length === 0) return { dispatched: 0 };

  let dispatched = 0;
  for (const { _id } of dueCampaigns) {
    // Atomically transition scheduled → running so only one worker picks it up
    const updated = await WhatsAppCampaign.findOneAndUpdate(
      { _id, status: 'scheduled' },
      { $set: { status: 'running', startedAt: new Date() } },
      { new: true }
    );
    if (!updated) continue; // another worker already picked it up

    await campaignSendQueue.add(
      { type: 'send', campaignId: _id.toString() },
      { ...queueConfig, jobId: `campaign-send-${_id}` }
    );
    dispatched++;
    logger.info('[Campaign] Dispatched scheduled campaign', { campaignId: _id });
  }

  return { dispatched };
}

// ─── Campaign sender ──────────────────────────────────────────────────────────

async function runCampaignSend(campaignId) {
  const campaign = await WhatsAppCampaign.findById(campaignId).lean();
  if (!campaign) {
    logger.warn('[Campaign] Campaign not found', { campaignId });
    return { skipped: true };
  }

  // Only process if in running state
  if (!['running'].includes(campaign.status)) {
    logger.info('[Campaign] Campaign not in running state, skipping', { campaignId, status: campaign.status });
    return { skipped: true, status: campaign.status };
  }

  const connection = await PlatformConnection.findById(campaign.connection)
    .select('accessToken platformData platformUserId platform')
    .lean();

  if (!connection) {
    await WhatsAppCampaign.findByIdAndUpdate(campaignId, {
      $set: { status: 'failed', finishedAt: new Date() }
    });
    logger.error('[Campaign] PlatformConnection not found', { campaignId });
    return { failed: true, reason: 'connection_not_found' };
  }

  const { name: templateName, languageCode, components } = campaign.templateSnapshot || {};
  if (!templateName) {
    await WhatsAppCampaign.findByIdAndUpdate(campaignId, {
      $set: { status: 'failed', finishedAt: new Date() }
    });
    logger.error('[Campaign] Missing templateSnapshot', { campaignId });
    return { failed: true, reason: 'missing_template_snapshot' };
  }

  let sentCount = 0;
  let failedCount = 0;
  let hasMore = true;

  while (hasMore) {
    // Re-check campaign status between batches (allow pause/cancel mid-run)
    const fresh = await WhatsAppCampaign.findById(campaignId).select('status').lean();
    if (!fresh || fresh.status === 'paused' || fresh.status === 'cancelled') {
      logger.info('[Campaign] Campaign interrupted', { campaignId, status: fresh?.status });
      return { sentCount, failedCount, interrupted: true };
    }

    const batch = await WhatsAppCampaignRecipient.find({
      campaign: campaignId,
      status: 'pending'
    })
      .select('_id phone recipientName')
      .limit(BATCH_SIZE)
      .lean();

    if (batch.length === 0) {
      hasMore = false;
      break;
    }

    for (const recipient of batch) {
      try {
        const result = await whatsappService.sendTemplateMessage(
          connection,
          recipient.phone,
          templateName,
          languageCode || 'en',
          components || []
        );

        await WhatsAppCampaignRecipient.findByIdAndUpdate(recipient._id, {
          $set: { status: 'sent', sentAt: new Date(), messageId: result.messageId || null }
        });
        sentCount++;
      } catch (err) {
        const errMsg = err.message || 'Unknown error';
        await WhatsAppCampaignRecipient.findByIdAndUpdate(recipient._id, {
          $set: { status: 'failed', errorMessage: errMsg.substring(0, 500) }
        });
        failedCount++;
        logger.warn('[Campaign] Failed to send to recipient', {
          campaignId,
          phone: recipient.phone,
          error: errMsg
        });
      }
    }

    // Update running stats after each batch
    await WhatsAppCampaign.findByIdAndUpdate(campaignId, {
      $inc: {
        'stats.sent': sentCount,
        'stats.failed': failedCount,
        'stats.pending': -(sentCount + failedCount)
      }
    });

    // Reset batch counters (we incremented the DB totals above)
    sentCount = 0;
    failedCount = 0;
  }

  // Mark campaign complete
  const finalStats = await WhatsAppCampaignRecipient.aggregate([
    { $match: { campaign: campaign._id } },
    { $group: { _id: '$status', count: { $sum: 1 } } }
  ]);
  const statMap = {};
  finalStats.forEach(s => { statMap[s._id] = s.count; });

  await WhatsAppCampaign.findByIdAndUpdate(campaignId, {
    $set: {
      status: 'completed',
      finishedAt: new Date(),
      'stats.sent': statMap.sent || 0,
      'stats.failed': statMap.failed || 0,
      'stats.pending': statMap.pending || 0
    }
  });

  logger.info('[Campaign] Completed', {
    campaignId,
    sent: statMap.sent || 0,
    failed: statMap.failed || 0
  });

  return { completed: true, sent: statMap.sent || 0, failed: statMap.failed || 0 };
}

// ─── Job entry point ──────────────────────────────────────────────────────────

module.exports = async function processCampaign(job) {
  const { type, campaignId } = job.data || {};

  if (type === 'schedule-poller') {
    return await runSchedulePoller();
  }

  if (type === 'send' && campaignId) {
    return await runCampaignSend(campaignId);
  }

  logger.warn('[Campaign] Unknown job type', { type, jobId: job.id });
  return { skipped: true };
};
