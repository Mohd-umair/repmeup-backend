const campaignMetrics = require('../services/campaignMetricsService');

/**
 * GET /api/super-admin/campaign-metrics
 * Ops snapshot: send counts, Meta 429s, queue depths.
 */
exports.getCampaignMetrics = async (req, res, next) => {
  try {
    const data = await campaignMetrics.getSnapshot();
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
};

/**
 * PATCH /api/super-admin/platform-connections/:id/waba-metadata
 * Body: { messagingTier?, qualityRating? }
 */
exports.updateWabaMetadata = async (req, res, next) => {
  try {
    const campaignGovernance = require('../services/campaignGovernanceService');
    const updated = await campaignGovernance.updateWabaMetadata(req.params.id, req.body || {});
    if (!updated) {
      return res.status(400).json({ success: false, error: 'No metadata fields provided' });
    }
    res.status(200).json({ success: true, data: updated });
  } catch (err) {
    next(err);
  }
};
