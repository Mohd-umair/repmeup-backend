/**
 * Register campaign queue processors — shared by campaignWorker.js and core worker.js.
 */
const campaignConfig = require('../config/campaignConfig');
const { campaignSendQueue, campaignInboxQueue } = require('../config/queue');
const processCampaign = require('../jobs/processCampaign');
const processCampaignInbox = require('../jobs/processCampaignInbox');
const logger = require('../config/logger');

async function registerCampaignWorkers() {
  const batchConcurrency = campaignConfig.batchConcurrency;

  campaignSendQueue.process(batchConcurrency, async (job) => {
    logger.debug('[Worker:campaign-send] picked up job', {
      jobId: job.id,
      type: job.data?.type,
      campaignId: job.data?.campaignId
    });
    return await processCampaign(job);
  });

  const campaignRepeatableJobs = await campaignSendQueue.getRepeatableJobs();
  const campaignScheduleExists = campaignRepeatableJobs.some(
    (j) => j.id && j.id.includes('campaign-schedule-poller')
  );
  if (!campaignScheduleExists) {
    await campaignSendQueue.add(
      { type: 'schedule-poller' },
      {
        repeat: { every: 30000 },
        jobId: 'campaign-schedule-poller',
        removeOnComplete: 5
      }
    );
    logger.info('[Worker] campaign-schedule-poller repeat job registered (every 30s)');
  }

  const archiveExists = campaignRepeatableJobs.some(
    (j) => j.id && j.id.includes('interaction-archive')
  );
  if (!archiveExists) {
    await campaignSendQueue.add(
      { type: 'interaction-archive' },
      {
        repeat: { every: 6 * 60 * 60 * 1000 },
        jobId: 'interaction-archive-repeat',
        removeOnComplete: 3
      }
    );
    logger.info('[Worker] interaction-archive repeat job registered (every 6h)');
  }

  const retryExists = campaignRepeatableJobs.some(
    (j) => j.id && j.id.includes('campaign-retry-pending')
  );
  if (!retryExists) {
    await campaignSendQueue.add(
      { type: 'retry-pending' },
      {
        repeat: { every: 5 * 60 * 1000 },
        jobId: 'campaign-retry-pending',
        removeOnComplete: 3
      }
    );
    logger.info('[Worker] campaign-retry-pending repeat job registered (every 5 min)');
  }

  campaignInboxQueue.process(campaignConfig.inboxConcurrency, async (job) => {
    return await processCampaignInbox(job);
  });

  logger.info('[Worker] campaign-send processor started', { concurrency: batchConcurrency });
  logger.info('[Worker] campaign-inbox processor started', { concurrency: campaignConfig.inboxConcurrency });

  return { batchConcurrency };
}

module.exports = { registerCampaignWorkers };
