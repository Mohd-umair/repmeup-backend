/**
 * Campaign Send Job
 *
 * Job types on `campaign-send` queue:
 *  1. { type: 'schedule-poller' }  — every 30s; due scheduled → running + batch fan-out
 *  2. { type: 'send-batch', campaignId, batchIndex, recipientIds[] }
 *  3. { type: 'send', campaignId } — legacy; fans out batches
 */

const WhatsAppCampaign = require('../models/WhatsAppCampaign');
const WhatsAppCampaignRecipient = require('../models/WhatsAppCampaignRecipient');
const PlatformConnection = require('../models/PlatformConnection');
const WhatsAppTemplate = require('../models/WhatsAppTemplate');
const whatsappService = require('../integrations/whatsapp/whatsappService');
const { buildRecipientComponents } = require('../utils/whatsappCampaignBuilder');
const { campaignSendQueue, campaignInboxQueue, queueConfig } = require('../config/queue');
const campaignConfig = require('../config/campaignConfig');
const campaignDispatch = require('../services/campaignDispatchService');
const campaignRateLimiter = require('../services/campaignRateLimiter');
const campaignGovernance = require('../services/campaignGovernanceService');
const campaignMetrics = require('../services/campaignMetricsService');
const logger = require('../config/logger');
const archiveInteractionReplies = require('./archiveInteractionReplies');

// ─── Schedule poller ──────────────────────────────────────────────────────────

async function runSchedulePoller() {
  const now = new Date();
  const dueCampaigns = await WhatsAppCampaign.find({
    status: 'scheduled',
    scheduledAt: { $lte: now }
  })
    .select('_id')
    .lean();

  if (dueCampaigns.length === 0) return { dispatched: 0 };

  let dispatched = 0;
  for (const { _id } of dueCampaigns) {
    const updated = await WhatsAppCampaign.findOneAndUpdate(
      { _id, status: 'scheduled' },
      { $set: { status: 'running', startedAt: new Date() } },
      { new: true }
    );
    if (!updated) continue;

    await campaignDispatch.enqueueCampaignBatches(_id.toString());
    dispatched++;
    logger.info('[Campaign] Dispatched scheduled campaign batches', { campaignId: _id });
  }

  return { dispatched };
}

// ─── Shared campaign context ──────────────────────────────────────────────────

async function loadCampaignContext(campaignId) {
  const campaign = await WhatsAppCampaign.findById(campaignId).lean();
  if (!campaign) return { error: 'not_found' };

  if (campaign.status !== 'running') {
    return { campaign, skipped: true, status: campaign.status };
  }

  const connection = await PlatformConnection.findById(campaign.connection)
    .select('accessToken platformData platformUserId platform organization')
    .lean();

  if (!connection) {
    await WhatsAppCampaign.findByIdAndUpdate(campaignId, {
      $set: { status: 'failed', finishedAt: new Date() }
    });
    return { error: 'connection_not_found' };
  }

  const { name: templateName, languageCode } = campaign.templateSnapshot || {};
  if (!templateName) {
    await WhatsAppCampaign.findByIdAndUpdate(campaignId, {
      $set: { status: 'failed', finishedAt: new Date() }
    });
    return { error: 'missing_template' };
  }

  const phoneNumberId =
    connection.platformData?.phoneNumberId || connection.platformUserId || '';

  const organizationId = String(campaign.organization || connection.organization);
  const templateLabel = `[Campaign] ${campaign.name} — template: ${templateName}`;

  const dbTemplate =
    campaign.templateSnapshot?.definition ||
    (campaign.templateRef
      ? await WhatsAppTemplate.findById(campaign.templateRef).lean().catch(() => null)
      : null);

  return {
    campaign,
    connection,
    templateName,
    languageCode,
    phoneNumberId,
    organizationId,
    templateLabel,
    dbTemplate
  };
}

// ─── Batch sender ─────────────────────────────────────────────────────────────

async function runCampaignSendBatch(campaignId, recipientIds) {
  const ctx = await loadCampaignContext(campaignId);
  if (ctx.error) return { failed: true, reason: ctx.error };
  if (ctx.skipped) return { skipped: true, status: ctx.status };

  const {
    campaign,
    connection,
    templateName,
    languageCode,
    phoneNumberId,
    organizationId,
    templateLabel,
    dbTemplate
  } = ctx;

  if (phoneNumberId && (await campaignRateLimiter.isWabaPaused(phoneNumberId))) {
    logger.info('[Campaign] WABA paused — delaying batch', { campaignId, phoneNumberId });
    throw new Error('WABA paused due to Meta rate limits — batch will retry');
  }

  const recipients = await WhatsAppCampaignRecipient.find({
    _id: { $in: recipientIds },
    campaign: campaignId,
    status: 'pending'
  })
    .select('_id phone recipientName templateParams sendAttempts')
    .lean();

  let sentCount = 0;
  let failedCount = 0;
  const inboxItems = [];

  for (const recipient of recipients) {
    const fresh = await WhatsAppCampaign.findById(campaignId).select('status').lean();
    if (!fresh || fresh.status === 'paused' || fresh.status === 'cancelled') {
      return { sentCount, failedCount, interrupted: true, status: fresh?.status };
    }

    try {
      if (phoneNumberId) {
        await campaignRateLimiter.acquireSendToken(phoneNumberId);
      }

      const components = dbTemplate
        ? buildRecipientComponents(dbTemplate, campaign, recipient)
        : [];

      const result = await whatsappService.sendTemplateMessage(
        connection,
        recipient.phone,
        templateName,
        languageCode || 'en',
        components
      );

      if (!result?.messageId) {
        throw new Error('WhatsApp API did not return a message id');
      }

      await WhatsAppCampaignRecipient.findOneAndUpdate(
        { _id: recipient._id, status: 'pending' },
        {
          $set: {
            status: 'sent',
            sentAt: new Date(),
            messageId: result.messageId,
            deliveryStatus: 'sent',
            deliveryStatusAt: new Date()
          }
        }
      );
      sentCount++;
      await campaignMetrics.recordSendSuccess(organizationId);

      if (phoneNumberId) {
        inboxItems.push({
          recipientPhone: recipient.phone,
          recipientName: recipient.recipientName || recipient.phone,
          messageId: result.messageId,
          components
        });
      }
    } catch (err) {
      if (campaignGovernance.isRateLimitError(err) && phoneNumberId) {
        await campaignGovernance.recordRateLimitError(phoneNumberId, campaignId);
      }

      const attempts = (recipient.sendAttempts || 0) + 1;
      const transient = campaignGovernance.isTransientSendError(err);

      if (transient && attempts < campaignConfig.maxSendAttempts) {
        await WhatsAppCampaignRecipient.findByIdAndUpdate(recipient._id, {
          $set: {
            sendAttempts: attempts,
            errorMessage: String(err.message || 'transient error').substring(0, 500)
          }
        });
        logger.warn('[Campaign] Transient send failure — will retry', {
          campaignId,
          phone: recipient.phone,
          attempts
        });
        continue;
      }

      await WhatsAppCampaignRecipient.findByIdAndUpdate(recipient._id, {
        $set: {
          status: 'failed',
          sendAttempts: attempts,
          errorMessage: String(err.message || 'Unknown error').substring(0, 500),
          deliveryStatus: 'failed',
          deliveryStatusAt: new Date()
        }
      });
      failedCount++;
      await campaignMetrics.recordSendFailure(organizationId);

      logger.warn('[Campaign] Failed to send to recipient', {
        campaignId,
        phone: recipient.phone,
        error: err.message
      });
    }
  }

  if (sentCount || failedCount) {
    await WhatsAppCampaign.findByIdAndUpdate(campaignId, {
      $inc: {
        'stats.sent': sentCount,
        'stats.failed': failedCount,
        'stats.pending': -(sentCount + failedCount)
      }
    });
  }

  if (inboxItems.length) {
    await campaignInboxQueue.add(
      {
        organizationId,
        phoneNumberId,
        connectionId: String(connection._id),
        campaignId: String(campaignId),
        campaignName: campaign.name,
        templateName,
        languageCode,
        templateLabel,
        dbTemplate,
        items: inboxItems
      },
      { ...queueConfig, removeOnComplete: 100 }
    );
  }

  await campaignMetrics.recordBatchCompleted();
  await campaignDispatch.maybeCompleteCampaign(campaignId);

  return { sentCount, failedCount, inboxQueued: inboxItems.length };
}

// ─── Job entry point ──────────────────────────────────────────────────────────

module.exports = async function processCampaign(job) {
  const { type, campaignId, recipientIds } = job.data || {};

  if (type === 'schedule-poller') {
    return await runSchedulePoller();
  }

  if (type === 'interaction-archive') {
    return await archiveInteractionReplies();
  }

  if (type === 'retry-pending') {
    return await campaignDispatch.retryPendingForRunningCampaigns();
  }

  if (type === 'send-batch' && campaignId && Array.isArray(recipientIds)) {
    return await runCampaignSendBatch(campaignId, recipientIds);
  }

  if (type === 'send' && campaignId) {
    logger.info('[Campaign] Legacy send job — fanning out batches', { campaignId });
    return await campaignDispatch.enqueueCampaignBatches(campaignId);
  }

  logger.warn('[Campaign] Unknown job type', { type, jobId: job.id });
  return { skipped: true };
};
