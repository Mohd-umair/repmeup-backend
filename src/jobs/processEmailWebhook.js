/**
 * Process Email Webhook Job
 *
 * Bull queue worker that processes inbound email notifications from:
 *   - Gmail   (Pub/Sub push → historyId delta → fetch new messages)
 *   - Outlook (Graph subscription → messageId → fetch message)
 *
 * Job data shape:
 *   Gmail:   { provider: 'gmail',   emailAddress: string, historyId: string }
 *   Outlook: { provider: 'outlook', subscriptionId: string, messageId: string }
 */

const PlatformConnection = require('../models/PlatformConnection');
const emailInboxService = require('../services/email/emailInboxService');
const logger = require('../config/logger');

/**
 * @param {import('bull').Job} job
 */
module.exports = async function processEmailWebhook(job) {
  const { provider } = job.data;

  if (provider === 'gmail') {
    return _processGmail(job.data);
  }

  if (provider === 'outlook') {
    return _processOutlook(job.data);
  }

  logger.warn('[processEmailWebhook] unknown provider', { provider });
};

// ── Gmail ─────────────────────────────────────────────────────────────────────

async function _processGmail({ emailAddress, historyId }) {
  // Look up the connection by email address
  const connection = await PlatformConnection.findOne({
    platform: 'email',
    'platformData.emailProvider': 'gmail',
    'platformData.emailAddress': emailAddress,
    isActive: true
  }).lean();

  if (!connection) {
    logger.warn('[processEmailWebhook:gmail] no active connection for email', { emailAddress });
    return;
  }

  const gmailService = require('../integrations/google/gmailService');

  // Fetch new message IDs since the stored historyId
  const messageIds = await gmailService.fetchNewMessageIds(connection, historyId);
  if (messageIds.length === 0) {
    logger.debug('[processEmailWebhook:gmail] no new messages', { emailAddress });
    return;
  }

  logger.info('[processEmailWebhook:gmail] processing new messages', {
    emailAddress,
    count: messageIds.length
  });

  let processed = 0;
  let skipped = 0;

  for (const messageId of messageIds) {
    try {
      const parsedMessage = await gmailService.getMessage(connection, messageId);
      const { skipped: wasSkipped } = await emailInboxService.upsertEmailThread(parsedMessage, connection);
      if (wasSkipped) skipped++;
      else processed++;
    } catch (err) {
      logger.error('[processEmailWebhook:gmail] error processing message', {
        emailAddress,
        messageId,
        error: err.message
      });
      // Continue processing remaining messages even if one fails
    }
  }

  logger.info('[processEmailWebhook:gmail] batch complete', {
    emailAddress,
    processed,
    skipped
  });
}

// ── Outlook ───────────────────────────────────────────────────────────────────

async function _processOutlook({ subscriptionId, messageId }) {
  const connection = await PlatformConnection.findOne({
    platform: 'email',
    'platformData.emailProvider': 'outlook',
    'platformData.msSubscriptionId': subscriptionId,
    isActive: true
  }).lean();

  if (!connection) {
    logger.warn('[processEmailWebhook:outlook] no active connection for subscription', { subscriptionId });
    return;
  }

  try {
    const outlookService = require('../integrations/microsoft/outlookService');
    const parsedMessage = await outlookService.fetchMessage(connection, messageId);
    await emailInboxService.upsertEmailThread(parsedMessage, connection);
    logger.info('[processEmailWebhook:outlook] message processed', { messageId });
  } catch (err) {
    logger.error('[processEmailWebhook:outlook] error processing message', {
      messageId,
      error: err.message
    });
    throw err; // re-throw so Bull can retry
  }
}
