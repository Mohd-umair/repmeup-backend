'use strict';

const { scanOrganization } = require('../services/duplicateDetectionService');

module.exports = async function processDuplicateScan(job) {
  if (job.data?.nightly) {
    return require('./processDuplicateScanNightly')();
  }
  const { organizationId } = job.data || {};
  if (!organizationId) return { skipped: true };
  return scanOrganization(organizationId);
};
