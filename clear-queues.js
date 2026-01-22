/**
 * Script to clear all Bull queues in Redis
 * Run this to stop the endless job processing
 */

require('dotenv').config();
const Queue = require('bull');

const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';

async function clearQueues() {
  console.log('Connecting to Redis:', redisUrl);
  
  const queues = [
    new Queue('webhook-processing', redisUrl),
    new Queue('ai-processing', redisUrl),
    new Queue('auto-reply', redisUrl),
    new Queue('platform-sync', redisUrl),
    new Queue('notifications', redisUrl)
  ];

  for (const queue of queues) {
    try {
      const waiting = await queue.getWaitingCount();
      const active = await queue.getActiveCount();
      const delayed = await queue.getDelayedCount();
      const completed = await queue.getCompletedCount();
      const failed = await queue.getFailedCount();
      
      console.log(`\n📊 Queue: ${queue.name}`);
      console.log(`   Waiting: ${waiting}`);
      console.log(`   Active: ${active}`);
      console.log(`   Delayed: ${delayed}`);
      console.log(`   Completed: ${completed}`);
      console.log(`   Failed: ${failed}`);
      
      // Clean all jobs
      await queue.empty(); // Remove waiting jobs
      await queue.clean(0, 'completed'); // Remove completed jobs
      await queue.clean(0, 'failed'); // Remove failed jobs
      await queue.clean(0, 'delayed'); // Remove delayed jobs
      
      // Remove repeatable jobs
      const repeatableJobs = await queue.getRepeatableJobs();
      for (const job of repeatableJobs) {
        await queue.removeRepeatableByKey(job.key);
      }
      
      console.log(`   ✅ Cleared!`);
    } catch (error) {
      console.error(`   ❌ Error clearing ${queue.name}:`, error.message);
    }
  }

  console.log('\n✅ All queues cleared!');
  console.log('Now restart your backend: pm2 restart orm-backend');
  process.exit(0);
}

clearQueues().catch(console.error);
