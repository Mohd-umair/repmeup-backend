/**
 * IMAP Polling Job
 *
 * Runs every 5 minutes (registered as a repeatable Bull job in worker.js).
 * Finds all active IMAP connections and polls each one for new messages
 * using delta UID fetching.
 *
 * Processing is sequential (not parallel) to avoid overwhelming IMAP servers
 * and to respect connection limits.
 *
 * @param {import('bull').Job} job
 */

const PlatformConnection = require('../models/PlatformConnection');
const emailInboxService = require('../services/email/emailInboxService');
const logger = require('../config/logger');

module.exports = async function processImapPolling(job) {
  const connections = await PlatformConnection.find({
    platform: 'email',
    'platformData.emailProvider': 'imap',
    isActive: true,
    status: 'connected'
  }).lean();

  if (connections.length === 0) {
    logger.debug('[processImapPolling] no active IMAP connections');
    return { processed: 0 };
  }

  logger.info('[processImapPolling] polling IMAP connections', { count: connections.length });

  let totalProcessed = 0;
  let totalFailed = 0;

  for (const connection of connections) {
    try {
      const imapService = require('../integrations/imap/imapService');
      const messages = await imapService.fetchNewMessages(connection);

      for (const parsedMessage of messages) {
        try {
          await emailInboxService.upsertEmailThread(parsedMessage, connection);
          totalProcessed++;
        } catch (upsertErr) {
          logger.error('[processImapPolling] error upserting email thread', {
            connectionId: connection._id,
            messageId: parsedMessage.messageId,
            error: upsertErr.message
          });
        }
      }

      logger.debug('[processImapPolling] connection polled', {
        email: connection.platformData?.emailAddress,
        newMessages: messages.length
      });
    } catch (err) {
      totalFailed++;
      logger.error('[processImapPolling] failed to poll connection', {
        connectionId: connection._id,
        email: connection.platformData?.emailAddress,
        error: err.message
      });

      // Mark connection as error if auth failed
      if (err.code === 'IMAP_AUTH_FAILED') {
        await PlatformConnection.findByIdAndUpdate(connection._id, {
          status: 'error',
          lastError: {
            message: 'IMAP authentication failed. Please check your credentials in Settings.',
            code: 'IMAP_AUTH_FAILED',
            timestamp: new Date()
          }
        });
      }
    }
  }

  logger.info('[processImapPolling] polling complete', { totalProcessed, totalFailed });
  return { processed: totalProcessed, failed: totalFailed };
};
