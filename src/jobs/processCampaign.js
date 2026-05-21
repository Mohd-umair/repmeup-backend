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
const Interaction = require('../models/Interaction');
const WhatsAppTemplate = require('../models/WhatsAppTemplate');
const whatsappService = require('../integrations/whatsapp/whatsappService');
const { generateChatRef } = require('../utils/chatRefHelper');
const { buildWhatsAppTemplatePreview } = require('../utils/whatsappTemplatePreview');
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

// ─── Inbox thread upsert ──────────────────────────────────────────────────────

/**
 * Upsert the Interaction conversation thread for a campaign-sent template message.
 *
 * Uses the same dm_<phoneNumberId>_<recipientPhone> platformId convention as
 * inbound webhooks so replies from the customer land in the correct thread.
 *
 * The outbound message is appended to `replies[]` (same array used by agent replies)
 * so inbox-detail shows it as a sent bubble with the template label and wamid.
 */
async function _upsertCampaignThread({
  organizationId,
  phoneNumberId,
  recipientPhone,
  recipientName,
  connectionId,
  messageId,
  templateLabel,
  templateName,
  languageCode,
  components,
  dbTemplate,
  campaignId,
  campaignName
}) {
  const threadPlatformId = `dm_${String(phoneNumberId)}_${String(recipientPhone)}`;
  const now = new Date();

  const existing = await Interaction
    .findOne({ platformId: threadPlatformId, organization: organizationId })
    .select('_id chatRef')
    .lean();

  let chatRefData = null;
  if (!existing || !existing.chatRef) {
    chatRefData = await generateChatRef(organizationId).catch(() => null);
  }

  const setFields = {
    organization: organizationId,
    platform: 'whatsapp',
    platformConnection: connectionId,
    type: 'dm',
    threadId: String(recipientPhone),
    'metadata.phoneNumberId': String(phoneNumberId),
    // Keep content fresh with the most recent campaign message label
    content: templateLabel,
    author: {
      platformId: String(recipientPhone),
      name: recipientName,
      username: recipientPhone
    },
    platformCreatedAt: now
  };

  const setOnInsertFields = {
    source: 'campaign',
    status: 'unread',
    isRead: false
  };

  if (!existing && chatRefData?.chatRef) {
    setOnInsertFields.chatNumber = chatRefData.chatNumber;
    setOnInsertFields.chatRef = chatRefData.chatRef;
  } else if (existing && !existing.chatRef && chatRefData?.chatRef) {
    setFields.chatNumber = chatRefData.chatNumber;
    setFields.chatRef = chatRefData.chatRef;
  }

  await Interaction.findOneAndUpdate(
    { platformId: threadPlatformId, organization: organizationId },
    { $set: setFields, $setOnInsert: setOnInsertFields },
    { upsert: true }
  );

  // Build the rich inbox preview using the template definition from DB
  const preview = buildWhatsAppTemplatePreview(
    { name: templateName, languageCode, components: components || [] },
    dbTemplate || null
  );
  // Tag the preview with campaign metadata for traceability in the inbox
  preview.campaignId = String(campaignId);
  preview.campaignName = campaignName;

  // Append outbound campaign message to replies[]
  // Guard: don't duplicate the same wamid if the job retries
  const wamidGuard = messageId
    ? { 'replies.platformResponseId': { $ne: messageId } }
    : {};

  await Interaction.updateOne(
    { platformId: threadPlatformId, organization: organizationId, ...wamidGuard },
    {
      $push: {
        replies: {
          content: preview.bodyText || templateLabel,
          sentAt: now,
          platformResponseId: messageId || null,
          wasAutoGenerated: false,
          status: 'sent',
          messageType: 'whatsapp_template',
          whatsappTemplatePreview: preview
        }
      }
    }
  );
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
    .select('accessToken platformData platformUserId platform organization')
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

  // Resolve the phone number id — needed to build the inbox thread key
  const phoneNumberId =
    connection.platformData?.phoneNumberId ||
    connection.platformUserId || '';

  // Org id is on the campaign (or on the connection)
  const organizationId = String(campaign.organization || connection.organization);

  // Human-readable label for the campaign message in the inbox thread
  const templateLabel = `[Campaign] ${campaign.name} — template: ${templateName}`;

  // Load the WhatsApp template doc once so the preview builder can use its component definitions
  const dbTemplate = campaign.templateRef
    ? await WhatsAppTemplate.findById(campaign.templateRef).lean().catch(() => null)
    : null;

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
          $set: {
            status: 'sent',
            sentAt: new Date(),
            messageId: result.messageId || null,
            deliveryStatus: 'sent',
            deliveryStatusAt: new Date()
          }
        });
        sentCount++;

        // ── Inbox thread upsert ───────────────────────────────────────────
        // Create / update the conversation thread so the outbound template
        // message is visible in the inbox and replies land in context.
        if (phoneNumberId) {
          _upsertCampaignThread({
            organizationId,
            phoneNumberId,
            recipientPhone: recipient.phone,
            recipientName: recipient.recipientName || recipient.phone,
            connectionId: String(connection._id),
            messageId: result.messageId || null,
            templateLabel,
            templateName,
            languageCode,
            components,
            dbTemplate,
            campaignId,
            campaignName: campaign.name
          }).catch(err => {
            logger.warn('[Campaign] Inbox thread upsert failed (non-fatal)', {
              campaignId, phone: recipient.phone, error: err.message
            });
          });
        }
      } catch (err) {
        const errMsg = err.message || 'Unknown error';
        await WhatsAppCampaignRecipient.findByIdAndUpdate(recipient._id, {
          $set: {
            status: 'failed',
            errorMessage: errMsg.substring(0, 500),
            deliveryStatus: 'failed',
            deliveryStatusAt: new Date()
          }
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
