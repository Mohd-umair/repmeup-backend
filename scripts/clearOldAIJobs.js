/**
 * Utility script to clear old AI processing jobs for interactions that already have replies
 * Run this to clean up the queue: node backend/scripts/clearOldAIJobs.js
 */

const mongoose = require('mongoose');
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

// Connect to MongoDB
mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/repmeup', {
  useNewUrlParser: true,
  useUnifiedTopology: true
});

const Interaction = require('../src/models/Interaction');
const { aiQueue } = require('../src/config/queue');

async function clearOldAIJobs() {
  try {
    console.log('🧹 Starting cleanup of old AI jobs for already-replied interactions...\n');

    // Get all pending AI jobs
    const jobs = await aiQueue.getJobs(['waiting', 'active', 'delayed']);
    console.log(`📊 Found ${jobs.length} pending AI jobs in queue\n`);

    let removedCount = 0;
    let keptCount = 0;

    for (const job of jobs) {
      const { interactionId } = job.data;

      if (!interactionId) {
        console.log(`⚠️  Job ${job.id} has no interactionId - skipping`);
        continue;
      }

      try {
        // Check if interaction exists and has replies
        const interaction = await Interaction.findById(interactionId);

        if (!interaction) {
          console.log(`🗑️  Removing job ${job.id} - interaction ${interactionId} not found`);
          await job.remove();
          removedCount++;
          continue;
        }

        // Check if already replied
        const hasReplies = interaction.replies && interaction.replies.length > 0;
        const isReplied = interaction.status === 'replied' || interaction.status === 'resolved';

        if (hasReplies || isReplied) {
          console.log(`🗑️  Removing job ${job.id} - interaction ${interactionId} already replied (status: ${interaction.status}, replies: ${interaction.replies?.length || 0})`);
          await job.remove();
          removedCount++;
        } else {
          console.log(`✅ Keeping job ${job.id} - interaction ${interactionId} still needs processing`);
          keptCount++;
        }
      } catch (error) {
        console.error(`❌ Error processing job ${job.id}:`, error.message);
        // Continue with next job
      }
    }

    console.log(`\n✅ Cleanup complete!`);
    console.log(`   Removed: ${removedCount} jobs`);
    console.log(`   Kept: ${keptCount} jobs`);
    console.log(`   Total: ${jobs.length} jobs\n`);

    process.exit(0);
  } catch (error) {
    console.error('❌ Cleanup error:', error);
    process.exit(1);
  }
}

// Run cleanup
clearOldAIJobs();

