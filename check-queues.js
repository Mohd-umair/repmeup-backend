/**
 * Script to check Bull queues in Redis
 * Shows all jobs in each queue
 */

require('dotenv').config();
const Queue = require('bull');

const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';

async function checkQueues() {
  console.log('Connecting to Redis:', redisUrl);
  console.log('\n' + '='.repeat(60));
  
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
      
      // Get waiting jobs
      if (waiting > 0) {
        const waitingJobs = await queue.getWaiting(0, 10); // First 10
        console.log(`\n   ⏳ Waiting Jobs (showing first 10):`);
        waitingJobs.forEach((job, i) => {
          console.log(`      ${i + 1}. Job ${job.id}: ${JSON.stringify(job.data)}`);
        });
        if (waiting > 10) {
          console.log(`      ... and ${waiting - 10} more`);
        }
      }
      
      // Get active jobs
      if (active > 0) {
        const activeJobs = await queue.getActive(0, 10);
        console.log(`\n   🔄 Active Jobs (showing first 10):`);
        activeJobs.forEach((job, i) => {
          console.log(`      ${i + 1}. Job ${job.id}: ${JSON.stringify(job.data)}`);
        });
        if (active > 10) {
          console.log(`      ... and ${active - 10} more`);
        }
      }
      
      // Get delayed jobs
      if (delayed > 0) {
        const delayedJobs = await queue.getDelayed(0, 10);
        console.log(`\n   ⏰ Delayed Jobs (showing first 10):`);
        delayedJobs.forEach((job, i) => {
          const delay = job.opts.delay || 0;
          const delayMinutes = Math.round(delay / 60000);
          console.log(`      ${i + 1}. Job ${job.id}: ${JSON.stringify(job.data)} (delayed ${delayMinutes}min)`);
        });
        if (delayed > 10) {
          console.log(`      ... and ${delayed - 10} more`);
        }
      }
      
      // Get repeatable jobs
      const repeatableJobs = await queue.getRepeatableJobs();
      if (repeatableJobs.length > 0) {
        console.log(`\n   🔁 Repeatable Jobs:`);
        repeatableJobs.forEach((job, i) => {
          console.log(`      ${i + 1}. ${job.id}: every ${job.cron || job.every}ms`);
        });
      }
      
    } catch (error) {
      console.error(`   ❌ Error checking ${queue.name}:`, error.message);
    }
  }

  console.log('\n' + '='.repeat(60));
  console.log('\n✅ Queue check complete!');
  process.exit(0);
}

checkQueues().catch(console.error);

