'use strict';

const Campaign = require('../models/Campaign');
const { sendBatch } = require('../services/socialCampaignService');

module.exports = async function processSocialCampaign(job) {
  const { campaignId, organizationId } = job.data || {};
  if (!campaignId) return { skipped: true };
  const result = await sendBatch({ orgId: organizationId, campaignId, limit: 40 });
  if (!result.done) {
    const campaign = await Campaign.findById(campaignId).select('status organization').lean();
    if (campaign && campaign.status === 'running') {
      const { socialCampaignSendQueue } = require('../config/queue');
      await socialCampaignSendQueue.add(
        { campaignId, organizationId: campaign.organization },
        { delay: 2000, removeOnComplete: 20 }
      );
    }
  }
  return result;
};
