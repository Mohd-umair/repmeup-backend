'use strict';

const Campaign = require('../models/Campaign');
const logger = require('../config/logger');

/**
 * Safety-net for scheduled activation campaigns whose Bull delayed job was lost
 * (Redis restart, worker downtime, etc.).
 */
async function sweepDueScheduledCampaigns() {
  const now = new Date();
  const due = await Campaign.find({
    status: 'scheduled',
    'schedule.sendAt': { $lte: now }
  })
    .select('_id organization createdBy')
    .sort({ 'schedule.sendAt': 1 })
    .limit(50)
    .lean();

  if (!due.length) return { due: 0, enqueued: 0 };

  const { activationCampaignLaunchQueue } = require('../config/queue');
  let enqueued = 0;
  for (const campaign of due) {
    try {
      await activationCampaignLaunchQueue.add(
        {
          campaignId: String(campaign._id),
          organizationId: String(campaign.organization),
          userId: campaign.createdBy ? String(campaign.createdBy) : null
        },
        {
          jobId: `activation-launch:${campaign._id}`,
          removeOnComplete: 20,
          attempts: 3
        }
      );
      enqueued += 1;
    } catch (err) {
      logger.warn('[activationScheduled] failed to enqueue due campaign', {
        campaignId: campaign._id,
        error: err.message
      });
    }
  }
  return { due: due.length, enqueued };
}

module.exports = { sweepDueScheduledCampaigns };
