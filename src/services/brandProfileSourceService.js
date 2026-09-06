const PlatformConnection = require('../models/PlatformConnection');

/**
 * Returns the connected Facebook/Instagram accounts whose synced posts may
 * contribute to the organization's analyzed brand profile.
 */
async function getActiveConnectionIds(organizationId) {
  if (!organizationId) return [];

  const connections = await PlatformConnection.find({
    organization: organizationId,
    platform: { $in: ['facebook', 'instagram'] },
    status: 'connected',
    isActive: true
  })
    .select('_id')
    .lean();

  return connections.map((connection) => String(connection._id)).sort();
}

function hasSameConnections(profileConnectionIds, activeConnectionIds) {
  if (!Array.isArray(profileConnectionIds)) return false;

  const analyzed = profileConnectionIds.map(String).sort();
  const active = (activeConnectionIds || []).map(String).sort();

  return analyzed.length === active.length
    && analyzed.every((connectionId, index) => connectionId === active[index]);
}

function isProfileCurrent(profile, activeConnectionIds) {
  return Boolean(
    profile?.analyzedAt
    && hasSameConnections(profile.sourceConnectionIds, activeConnectionIds)
  );
}

module.exports = {
  getActiveConnectionIds,
  hasSameConnections,
  isProfileCurrent
};
