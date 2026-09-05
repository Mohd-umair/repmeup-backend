/**
 * Renew Gmail Watches Job
 *
 * Gmail Pub/Sub watches expire every 7 days.  This job finds all active Gmail
 * connections whose watch is within 24 hours of expiry and calls watchInbox()
 * to reset them.
 *
 * Registered as a repeatable Bull job in worker.js (every 6 days).
 *
 * @param {import('bull').Job} job
 */

const PlatformConnection = require('../models/PlatformConnection');
const gmailService = require('../integrations/google/gmailService');
const logger = require('../config/logger');

module.exports = async function renewGmailWatches(job) {
  const threshold = new Date(Date.now() + 24 * 60 * 60 * 1000); // next 24 hours

  // Find connections where watch is missing or expiring soon
  const connections = await PlatformConnection.find({
    platform: 'email',
    'platformData.emailProvider': 'gmail',
    isActive: true,
    status: 'connected',
    $or: [
      { 'platformData.watchExpiry': { $exists: false } },
      { 'platformData.watchExpiry': null },
      { 'platformData.watchExpiry': { $lt: threshold } }
    ]
  }).lean();

  if (connections.length === 0) {
    logger.debug('[renewGmailWatches] no watches need renewal');
    return { renewed: 0 };
  }

  logger.info('[renewGmailWatches] renewing watches', { count: connections.length });

  let renewed = 0;
  let failed = 0;

  for (const connection of connections) {
    try {
      await gmailService.watchInbox(connection);
      renewed++;
      logger.info('[renewGmailWatches] watch renewed', {
        connectionId: connection._id,
        email: connection.platformData?.emailAddress
      });
    } catch (err) {
      failed++;
      logger.error('[renewGmailWatches] failed to renew watch', {
        connectionId: connection._id,
        email: connection.platformData?.emailAddress,
        error: err.message
      });

      // Mark connection as error if auth failed
      if (err.code === 'GMAIL_AUTH_FAILED') {
        await PlatformConnection.findByIdAndUpdate(connection._id, {
          status: 'token_expired',
          lastError: {
            message: 'Gmail OAuth token expired. Please reconnect this account.',
            code: 'GMAIL_AUTH_FAILED',
            timestamp: new Date()
          }
        });
      }
    }
  }

  logger.info('[renewGmailWatches] batch complete', { renewed, failed });
  return { renewed, failed };
};
