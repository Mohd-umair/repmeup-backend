'use strict';

const { launch } = require('../services/campaignOrchestratorService');
const { sweepDueScheduledCampaigns } = require('../services/activationScheduledService');

module.exports = async function processActivationCampaignLaunch(job) {
  if (job.data?.sweep) {
    return sweepDueScheduledCampaigns();
  }
  const { campaignId, organizationId, userId } = job.data || {};
  if (!campaignId || !organizationId) return { skipped: true };
  return launch({
    orgId: organizationId,
    userId: userId || null,
    campaignId,
    sendNow: true,
    scheduledJob: true
  });
};
