'use strict';

const PlatformConnection = require('../../models/PlatformConnection');

/**
 * Platform connection statuses that should scope inbox visibility.
 * Must stay aligned with webhook + sync services (they ingest for connected/available).
 * error/token_expired keep historical threads visible while the user fixes the token.
 */
const INBOX_ACTIVE_CONNECTION_STATUSES = ['connected', 'available', 'error', 'token_expired'];

/**
 * Load platform connections used to scope GET /api/inbox and GET /api/inbox/stats.
 * @param {import('mongoose').Types.ObjectId|string} orgId
 */
async function fetchInboxActiveConnections(orgId) {
  return PlatformConnection.find({
    organization: orgId,
    isActive: true,
    status: { $in: INBOX_ACTIVE_CONNECTION_STATUSES }
  })
    .select('_id platform')
    .lean();
}

module.exports = {
  INBOX_ACTIVE_CONNECTION_STATUSES,
  fetchInboxActiveConnections
};
