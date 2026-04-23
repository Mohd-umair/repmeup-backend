require('dotenv').config();
const connectDB = require('./config/database');
const { connectRedis } = require('./config/redis');
const {
  webhookQueue,
  aiQueue,
  autoReplyQueue,
  scheduledPublishQueue,
  brandAnalysisQueue
} = require('./config/queue');
const processWebhook = require('./jobs/processWebhook');
const processAI = require('./jobs/processAI');
const processAutoReply = require('./jobs/processAutoReply');
const processScheduledPublish = require('./jobs/processScheduledPublish');
const processBrandAnalysis = require('./jobs/processBrandAnalysis');
const logger = require('./config/logger');

// Concurrency from env
const WEBHOOK_CONCURRENCY = parseInt(process.env.WEBHOOK_CONCURRENCY) || 10;
const AI_CONCURRENCY = parseInt(process.env.AI_CONCURRENCY) || 10;
const AUTOREPLY_CONCURRENCY = parseInt(process.env.AUTOREPLY_CONCURRENCY) || 5;
const BRAND_ANALYSIS_CONCURRENCY = parseInt(process.env.BRAND_ANALYSIS_CONCURRENCY) || 2;

async function startWorker() {
  try {
    logger.info('🔧 Starting ORM Worker...');

    await connectDB();
    await connectRedis();

    webhookQueue.process(WEBHOOK_CONCURRENCY, async (job) => {
      logger.debug('[Worker:webhook] picked up job', { jobId: job.id });
      return await processWebhook(job);
    });
    logger.info('[Worker] webhook processor started', { concurrency: WEBHOOK_CONCURRENCY });

    aiQueue.process(AI_CONCURRENCY, async (job) => {
      logger.debug('[Worker:ai] picked up job', { jobId: job.id });
      return await processAI(job);
    });
    logger.info('[Worker] ai processor started', { concurrency: AI_CONCURRENCY });

    autoReplyQueue.process(AUTOREPLY_CONCURRENCY, async (job) => {
      logger.debug('[Worker:auto-reply] picked up job', { jobId: job.id });
      return await processAutoReply(job);
    });
    logger.info('[Worker] auto-reply processor started', { concurrency: AUTOREPLY_CONCURRENCY });

    // Scheduled publish: run every 1 minute to publish due posts.
    // Guard against creating duplicate repeat jobs on worker restart.
    scheduledPublishQueue.process(1, async () => {
      return await processScheduledPublish();
    });
    const repeatableJobs = await scheduledPublishQueue.getRepeatableJobs();
    const alreadyScheduled = repeatableJobs.some(j => j.id && j.id.includes('scheduled-publish-repeat'));
    if (!alreadyScheduled) {
      await scheduledPublishQueue.add({}, {
        repeat: { every: 60000 },
        jobId: 'scheduled-publish-repeat',
        removeOnComplete: 5
      });
      logger.info('[Worker] scheduled-publish repeat job registered');
    } else {
      logger.info('[Worker] scheduled-publish repeat job already exists — skipping registration');
    }
    logger.info('[Worker] scheduled-publish processor started (every 1 min)');

    brandAnalysisQueue.process(BRAND_ANALYSIS_CONCURRENCY, async (job) => {
      logger.debug('[Worker:brand-analysis] picked up job', { jobId: job.id });
      return await processBrandAnalysis(job);
    });
    logger.info('[Worker] brand-analysis processor started', { concurrency: BRAND_ANALYSIS_CONCURRENCY });

    logger.info('✨ Worker started successfully', {
      webhook: WEBHOOK_CONCURRENCY,
      ai: AI_CONCURRENCY,
      autoReply: AUTOREPLY_CONCURRENCY,
      brandAnalysis: BRAND_ANALYSIS_CONCURRENCY
    });

    const shutdown = async (signal) => {
      logger.warn(`${signal} signal received: closing worker`);
      try {
        await Promise.all([
          webhookQueue.close(),
          aiQueue.close(),
          autoReplyQueue.close(),
          scheduledPublishQueue.close(),
          brandAnalysisQueue.close()
        ]);
        process.exit(0);
      } catch (err) {
        logger.error('Error during worker shutdown', { error: err.message, stack: err.stack });
        process.exit(1);
      }
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));

  } catch (error) {
    logger.error('Worker startup error', { error: error.message, stack: error.stack });
    process.exit(1);
  }
}

startWorker().catch((err) => {
  logger.error('Worker bootstrap failed', { error: err.message, stack: err.stack });
  process.exit(1);
});
