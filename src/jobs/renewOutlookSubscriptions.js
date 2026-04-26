/**
 * Renew Outlook Graph Subscriptions Job
 *
 * Graph mail subscriptions expire every 3 days.  This job finds all active
 * Outlook connections whose subscription expires within 12 hours and renews them.
 *
 * Registered in worker.js as a repeatable Bull job (every 2 days).
 *
 * @param {import('bull').Job} job
 */

const PlatformConnection = require('../models/PlatformConnection');
const outlookService = require('../integrations/microsoft/outlookService');
const logger = require('../config/logger');

module.exports = async function renewOutlookSubscriptions(job) {
  const threshold = new Date(Date.now() + 12 * 60 * 60 * 1000); // next 12 hours

  const connections = await PlatformConnection.find({
    platform: 'email',
    'platformData.emailProvider': 'outlook',
    isActive: true,
    status: 'connected',
    $or: [
      { 'platformData.msSubscriptionExpiry': { $exists: false } },
      { 'platformData.msSubscriptionExpiry': null },
      { 'platformData.msSubscriptionExpiry': { $lt: threshold } }
    ]
  }).lean();

  if (connections.length === 0) {
    logger.debug('[renewOutlookSubscriptions] no subscriptions need renewal');
    return { renewed: 0 };
  }

  logger.info('[renewOutlookSubscriptions] renewing subscriptions', { count: connections.length });

  let renewed = 0;
  let failed = 0;

  for (const connection of connections) {
    try {
      await outlookService.renewSubscription(connection);
      renewed++;
      logger.info('[renewOutlookSubscriptions] subscription renewed', {
        connectionId: connection._id,
        email: connection.platformData?.emailAddress
      });
    } catch (err) {
      failed++;
      logger.error('[renewOutlookSubscriptions] failed to renew subscription', {
        connectionId: connection._id,
        email: connection.platformData?.emailAddress,
        error: err.message
      });

      if (err.code === 'OUTLOOK_AUTH_FAILED') {
        await PlatformConnection.findByIdAndUpdate(connection._id, {
          status: 'token_expired',
          lastError: {
            message: 'Microsoft OAuth token expired. Please reconnect your Outlook account.',
            code: 'OUTLOOK_AUTH_FAILED',
            timestamp: new Date()
          }
        });
      }
    }
  }

  logger.info('[renewOutlookSubscriptions] batch complete', { renewed, failed });
  return { renewed, failed };
};
