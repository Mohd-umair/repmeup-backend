const Queue = require('bull');

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

// Create queues with optimized settings
const webhookQueue = new Queue('webhook-processing', queueOptions);
const syncQueue = new Queue('platform-sync', queueOptions);
const aiQueue = new Queue('ai-processing', queueOptions);
const notificationQueue = new Queue('notifications', queueOptions);
const autoReplyQueue = new Queue('auto-reply', queueOptions);

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

// Error handling for all queues
const queues = [webhookQueue, syncQueue, aiQueue, notificationQueue, autoReplyQueue];

queues.forEach(queue => {
  queue.on('error', (error) => {
    console.error(`Queue ${queue.name} error:`, error);
  });

  queue.on('failed', (job, err) => {
    console.error(`Job ${job.id} in queue ${queue.name} failed:`, err.message);
  });

  queue.on('completed', (job) => {
    console.log(`Job ${job.id} in queue ${queue.name} completed`);
  });
});

module.exports = {
  webhookQueue,
  syncQueue,
  aiQueue,
  notificationQueue,
  autoReplyQueue,
  queueConfig
};

