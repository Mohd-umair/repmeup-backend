const Queue = require('bull');
const logger = require('./logger');

// Memory-efficient queue settings
const queueOptions = {
  redis: process.env.REDIS_URL || 'redis://localhost:6379',
  settings: {
    maxStalledCount: 3, // Max times job can stall before failing
    stalledInterval: 60000, // Check for stalled jobs every 60s (increased from 30s)
    lockDuration: 120000, // Job lock expires after 120s (increased from 30s)
    lockRenewTime: 60000 // Renew lock every 60s (increased from 15s)
  },
  limiter: {
    max: 100, // Max 100 jobs per groupKey
    duration: 1000 // Per 1 second
  }
};

// ============================================================================
// Active queues (have at least one producer AND one consumer in worker.js)
// ============================================================================
const webhookQueue = new Queue('webhook-processing', queueOptions);
const aiQueue = new Queue('ai-processing', queueOptions);
const autoReplyQueue = new Queue('auto-reply', queueOptions);
const scheduledPublishQueue = new Queue('scheduled-publish', queueOptions);
const brandAnalysisQueue = new Queue('brand-analysis', queueOptions);
const emailWebhookQueue = new Queue('email-webhook', queueOptions);
const imapPollingQueue = new Queue('imap-polling', queueOptions);
const gmailWatchRenewalQueue = new Queue('gmail-watch-renewal', queueOptions);
const outlookRenewalQueue = new Queue('outlook-subscription-renewal', queueOptions);
const voiceCallQueue = new Queue('voice-call', queueOptions);

// WhatsApp campaign broadcast — rate-limited job starts (actual send rate enforced per-WABA in worker)
const campaignSendQueue = new Queue('campaign-send', {
  ...queueOptions,
  limiter: { max: 60, duration: 1000 }
});

// Async inbox backfill after campaign sends (cold path)
const campaignInboxQueue = new Queue('campaign-inbox', {
  ...queueOptions,
  limiter: { max: 100, duration: 1000 }
});

const flowTickQueue = new Queue('flow-tick', queueOptions);

// Knowledge-base website crawl — long-running (crawl + per-page AI summarize).
// Low concurrency in the worker; one job can take minutes for a large site.
const kbCrawlQueue = new Queue('kb-crawl', queueOptions);

// Demo-trial expiry — a lightweight daily repeat job that locks expired demos.
const demoExpiryQueue = new Queue('demo-expiry', queueOptions);

// ============================================================================
// Reserved / dormant queues (declared but currently unused).
// Kept in place so existing Bull Board dashboards and imports keep working.
// TODO: either wire producers/consumers or remove. See docs/queues.md.
// ============================================================================
const syncQueue = new Queue('platform-sync', queueOptions);
const notificationQueue = new Queue('notifications', queueOptions);

// Configure job settings (memory-efficient)
const queueConfig = {
  attempts: 3,
  backoff: {
    type: 'exponential',
    delay: 2000
  },
  removeOnComplete: 50, // Keep only last 50 completed jobs (reduced from 100)
  removeOnFail: 100 // Keep only last 100 failed jobs (reduced from 500)
};

// Error handling for all queues — every event below MUST be cheap.
// Per-job logs go to debug to avoid log explosion under load.
const queues = [
  webhookQueue,
  syncQueue,
  aiQueue,
  notificationQueue,
  autoReplyQueue,
  scheduledPublishQueue,
  brandAnalysisQueue,
  emailWebhookQueue,
  imapPollingQueue,
  gmailWatchRenewalQueue,
  outlookRenewalQueue,
  voiceCallQueue,
  campaignSendQueue,
  campaignInboxQueue,
  flowTickQueue,
  kbCrawlQueue,
  demoExpiryQueue
];

queues.forEach(queue => {
  queue.on('error', (error) => {
    logger.error(`[Queue:${queue.name}] error`, {
      queue: queue.name,
      error: error.message,
      stack: error.stack
    });
  });

  queue.on('failed', (job, err) => {
    logger.error(`[Queue:${queue.name}] job failed`, {
      queue: queue.name,
      jobId: job?.id,
      attemptsMade: job?.attemptsMade,
      error: err?.message,
      stack: err?.stack
    });
  });

  queue.on('completed', (job) => {
    logger.debug(`[Queue:${queue.name}] job completed`, {
      queue: queue.name,
      jobId: job?.id
    });
  });
});

module.exports = {
  webhookQueue,
  syncQueue,
  aiQueue,
  notificationQueue,
  autoReplyQueue,
  scheduledPublishQueue,
  brandAnalysisQueue,
  emailWebhookQueue,
  imapPollingQueue,
  gmailWatchRenewalQueue,
  outlookRenewalQueue,
  voiceCallQueue,
  campaignSendQueue,
  campaignInboxQueue,
  flowTickQueue,
  kbCrawlQueue,
  demoExpiryQueue,
  queueConfig
};
