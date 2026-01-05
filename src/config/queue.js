const Queue = require('bull');

// Create queues
const webhookQueue = new Queue('webhook-processing', process.env.REDIS_URL || 'redis://localhost:6379');
const syncQueue = new Queue('platform-sync', process.env.REDIS_URL || 'redis://localhost:6379');
const aiQueue = new Queue('ai-processing', process.env.REDIS_URL || 'redis://localhost:6379');
const notificationQueue = new Queue('notifications', process.env.REDIS_URL || 'redis://localhost:6379');

// Configure queue settings
const queueConfig = {
  attempts: 3,
  backoff: {
    type: 'exponential',
    delay: 2000
  },
  removeOnComplete: 100,
  removeOnFail: 500
};

// Error handling for all queues
const queues = [webhookQueue, syncQueue, aiQueue, notificationQueue];

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
  queueConfig
};

