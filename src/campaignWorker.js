/**
 * Dedicated campaign worker — processes campaign-send, campaign-inbox, and archive jobs.
 * Run separately from worker.js to isolate blast traffic from AI/webhooks.
 *
 *   node src/campaignWorker.js
 *   npm run worker:campaign
 */
require('dotenv').config();
const connectDB = require('./config/database');
const { connectRedis, getRedisClient } = require('./config/redis');
const { campaignSendQueue, campaignInboxQueue } = require('./config/queue');
const { registerCampaignWorkers } = require('./workers/registerCampaignWorkers');
const socketEmitter = require('./utils/socketEmitter');
const logger = require('./config/logger');

async function startCampaignWorker() {
  try {
    logger.info('📣 Starting ORM Campaign Worker...');

    await connectDB();
    await connectRedis();

    // Campaign jobs emit progress/inbox events — bridge them to API clients via Redis.
    socketEmitter.initRedisEmitter(getRedisClient());

    const { batchConcurrency } = await registerCampaignWorkers();

    logger.info('✨ Campaign worker started', { batchConcurrency });

    const shutdown = async (signal) => {
      logger.warn(`${signal} received: closing campaign worker`);
      try {
        await Promise.all([campaignSendQueue.close(), campaignInboxQueue.close()]);
        process.exit(0);
      } catch (err) {
        logger.error('Campaign worker shutdown error', { error: err.message });
        process.exit(1);
      }
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  } catch (error) {
    logger.error('Campaign worker startup error', { error: error.message, stack: error.stack });
    process.exit(1);
  }
}

startCampaignWorker().catch((err) => {
  logger.error('Campaign worker bootstrap failed', { error: err.message });
  process.exit(1);
});
