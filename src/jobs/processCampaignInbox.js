/**
 * Async inbox backfill for campaign batch sends.
 */
const campaignInboxService = require('../services/campaignInboxService');
const logger = require('../config/logger');

module.exports = async function processCampaignInbox(job) {
  const data = job.data || {};
  const { items, ...ctx } = data;

  if (!items?.length) {
    return { skipped: true };
  }

  const result = await campaignInboxService.upsertCampaignThreadsBatch({
    ...ctx,
    items
  });

  logger.debug('[CampaignInbox] Batch upserted', {
    campaignId: ctx.campaignId,
    upserted: result.upserted
  });

  return result;
};
