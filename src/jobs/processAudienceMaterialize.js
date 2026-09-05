'use strict';

const { materializeSnapshot } = require('../services/audienceService');

module.exports = async function processAudienceMaterialize(job) {
  const { snapshotId } = job.data || {};
  if (!snapshotId) return { skipped: true };
  await materializeSnapshot(snapshotId);
  return { ok: true, snapshotId };
};
