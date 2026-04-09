const brandProfileService = require('../services/brandProfileService');

/**
 * Bull job processor: analyze brand content for an organization.
 * Expects job.data.organizationId.
 */
async function processBrandAnalysis(job) {
  const { organizationId } = job.data;
  if (!organizationId) throw new Error('organizationId is required');

  console.log(`[BrandAnalysis] Starting analysis for org ${organizationId}`);
  const result = await brandProfileService.analyzeOrgContent(organizationId);
  console.log(`[BrandAnalysis] Done for org ${organizationId}: ${result.analyzedCount} posts analyzed, confidence=${result.profile?.confidence || 'n/a'}`);
  return result;
}

module.exports = processBrandAnalysis;
