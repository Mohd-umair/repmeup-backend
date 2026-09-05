'use strict';

const { scanAllOrganizations } = require('../services/duplicateDetectionService');

module.exports = async function processDuplicateScanNightly() {
  return scanAllOrganizations();
};
