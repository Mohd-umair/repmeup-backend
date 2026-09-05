'use strict';

const { computeForContact, recomputeOrg } = require('../services/contactIntelligenceService');
const { computeAndStore } = require('../services/nextBestActionService');

module.exports = async function processContactIntelligence(job) {
  const { organizationId, contactId } = job.data || {};
  if (contactId && organizationId) {
    await computeForContact(organizationId, contactId);
    await computeAndStore(organizationId, contactId);
    return { contactId };
  }
  if (organizationId) {
    return recomputeOrg(organizationId);
  }
  return { skipped: true };
};
