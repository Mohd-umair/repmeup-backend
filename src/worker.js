require('dotenv').config();
const connectDB = require('./config/database');
const { connectRedis } = require('./config/redis');
const { webhookQueue, aiQueue, autoReplyQueue, scheduledPublishQueue } = require('./config/queue');
const processWebhook = require('./jobs/processWebhook');
const processAI = require('./jobs/processAI');
const processAutoReply = require('./jobs/processAutoReply');
const processScheduledPublish = require('./jobs/processScheduledPublish');

// Concurrency from env
const WEBHOOK_CONCURRENCY = parseInt(process.env.WEBHOOK_CONCURRENCY) || 10;
const AI_CONCURRENCY = parseInt(process.env.AI_CONCURRENCY) || 10;
const AUTOREPLY_CONCURRENCY = parseInt(process.env.AUTOREPLY_CONCURRENCY) || 5;

async function startWorker() {
  try {
    console.log('🔧 Starting ORM Worker...');
    
    // Connect to MongoDB
    await connectDB();
    
    // Connect to Redis
    await connectRedis();
    
    // Start queue processors with concurrency
    webhookQueue.process(WEBHOOK_CONCURRENCY, async (job) => {
      console.log(`\n📥 [Worker] Processing webhook job ${job.id}`);
      return await processWebhook(job);
    });
    console.log(`✅ Webhook queue processor started (concurrency: ${WEBHOOK_CONCURRENCY})`);
    
    aiQueue.process(AI_CONCURRENCY, async (job) => {
      console.log(`\n🤖 [Worker] Processing AI job ${job.id}`);
      return await processAI(job);
    });
    console.log(`✅ AI queue processor started (concurrency: ${AI_CONCURRENCY})`);
    
    autoReplyQueue.process(AUTOREPLY_CONCURRENCY, async (job) => {
      console.log(`\n💬 [Worker] Processing auto-reply job ${job.id}`);
      return await processAutoReply(job);
    });
    console.log(`✅ Auto-reply queue processor started (concurrency: ${AUTOREPLY_CONCURRENCY})`);

    // Scheduled publish: run every 1 minute to publish due posts
    await scheduledPublishQueue.add({}, {
      repeat: { every: 60000 },
      jobId: 'scheduled-publish-repeat',
      removeOnComplete: 5
    });
    scheduledPublishQueue.process(1, async () => {
      return await processScheduledPublish();
    });
    console.log('✅ Scheduled publish processor started (every 1 min)');
    
    console.log('✨ Worker started successfully with concurrency:');
    console.log(`   Webhook: ${WEBHOOK_CONCURRENCY}`);
    console.log(`   AI: ${AI_CONCURRENCY}`);
    console.log(`   Auto-reply: ${AUTOREPLY_CONCURRENCY}`);
    
    // Handle shutdown gracefully
    process.on('SIGTERM', async () => {
      console.log('⚠️  SIGTERM signal received: closing worker');
      await webhookQueue.close();
      await aiQueue.close();
      await autoReplyQueue.close();
      await scheduledPublishQueue.close();
      process.exit(0);
    });
    
    process.on('SIGINT', async () => {
      console.log('⚠️  SIGINT signal received: closing worker');
      await webhookQueue.close();
      await aiQueue.close();
      await autoReplyQueue.close();
      await scheduledPublishQueue.close();
      process.exit(0);
    });
    
  } catch (error) {
    console.error('❌ Worker startup error:', error);
    process.exit(1);
  }
}

startWorker().catch(console.error);
