const PlatformConnection = require('../models/PlatformConnection');
const Organization = require('../models/Organization');
const Subscription = require('../models/Subscription');

/**
 * Count connections that use an account slot (for plan limit).
 * Same logic as subscriptionController: status connected, usesAccountSlot true.
 * Excludes Facebook user_token (page picker) which has usesAccountSlot: false.
 */
async function countConnectionsUsingSlots(organizationId) {
  return PlatformConnection.countDocuments({
    organization: organizationId,
    isActive: true,
    status: 'connected',
    usesAccountSlot: true
  });
}

/**
 * Platform Connection Service
 * Single Responsibility: Manage platform connection limits and counting.
 * Uses Subscription (plan) as source of truth when present; falls back to Organization.
 */
class PlatformConnectionService {
  /**
   * Check if organization can add a new platform connection (uses Subscription limit when present)
   * @param {String} organizationId - Organization ID
   * @returns {Promise<{canConnect: Boolean, reason?: String, limit?: Number, current?: Number}>}
   */
  async canAddConnection(organizationId) {
    const organization = await Organization.findById(organizationId);
    if (!organization) {
      return { canConnect: false, reason: 'Organization not found' };
    }

    const subscription = await Subscription.findOne({ organization: organizationId });
    const currentCount = await countConnectionsUsingSlots(organizationId);
    const maxAccounts = subscription
      ? subscription.limits.maxAccounts
      : (organization.limits?.maxPlatformConnections ?? 3);
    const isUnlimited = maxAccounts === -1;
    const isAtLimit = !isUnlimited && currentCount >= maxAccounts;

    if (isAtLimit) {
      return {
        canConnect: false,
        reason: 'PLATFORM_LIMIT_REACHED',
        limit: maxAccounts,
        current: currentCount
      };
    }

    return {
      canConnect: true,
      limit: maxAccounts,
      current: currentCount
    };
  }

  /**
   * Get remaining connection slots (uses Subscription limit when present)
   * @param {String} organizationId
   * @returns {Promise<Number>}
   */
  async getRemainingSlots(organizationId) {
    const organization = await Organization.findById(organizationId);
    if (!organization) return 0;

    const subscription = await Subscription.findOne({ organization: organizationId });
    const currentCount = await countConnectionsUsingSlots(organizationId);
    const maxAccounts = subscription
      ? subscription.limits.maxAccounts
      : (organization.limits?.maxPlatformConnections ?? 3);

    if (maxAccounts === -1) return 999;
    return Math.max(0, maxAccounts - currentCount);
  }

  /**
   * Increment platform connection count for organization
   * @param {String} organizationId
   * @returns {Promise<void>}
   */
  async incrementConnectionCount(organizationId) {
    await Organization.updateOne(
      { _id: organizationId },
      { 
        $inc: { 'usage.currentPlatformConnections': 1 }
      }
    );
    console.log(`✅ [ConnectionService] Incremented connection count for org: ${organizationId}`);
  }

  /**
   * Decrement platform connection count for organization
   * Guards against going below 0
   * @param {String} organizationId
   * @returns {Promise<void>}
   */
  async decrementConnectionCount(organizationId) {
    // Use $max to ensure we don't go below 0
    await Organization.updateOne(
      { 
        _id: organizationId,
        'usage.currentPlatformConnections': { $gt: 0 }
      },
      { 
        $inc: { 'usage.currentPlatformConnections': -1 }
      }
    );
    console.log(`✅ [ConnectionService] Decremented connection count for org: ${organizationId}`);
  }

  /**
   * Check if a connection should be counted toward the limit
   * Some connections (like Meta user-level tokens) are excluded
   * @param {Object} connectionData
   * @returns {Boolean}
   */
  shouldCountConnection(connectionData) {
    // Meta user-level connections (for page management) don't count
    if (connectionData.platform === 'facebook' && 
        connectionData.metadata?.type === 'user_token') {
      return false;
    }

    // All other connections count toward the limit
    return true;
  }

  /**
   * Get all connections for an organization with limit info.
   * Uses Subscription (plan) for usage/limits when present so UI matches plan.
   * @param {String} organizationId
   * @returns {Promise<{connections: Array, usage: Object, limits: Object}>}
   */
  async getConnectionsWithLimits(organizationId) {
    const [connections, organization, subscription] = await Promise.all([
      PlatformConnection.find({
        organization: organizationId,
        isActive: true,
        status: { $in: ['connected', 'error', 'token_expired'] }
      })
        .select('-accessToken -refreshToken')
        .sort({ createdAt: -1 }),
      Organization.findById(organizationId).select('limits usage'),
      Subscription.findOne({ organization: organizationId })
    ]);

    if (!organization) {
      throw new Error('Organization not found');
    }

    const currentCount = await countConnectionsUsingSlots(organizationId);
    const maxAccounts = subscription
      ? subscription.limits.maxAccounts
      : (organization.limits?.maxPlatformConnections ?? 3);
    const isUnlimited = maxAccounts === -1;
    const remaining = isUnlimited ? 999 : Math.max(0, maxAccounts - currentCount);

    return {
      connections,
      usage: {
        current: currentCount,
        max: maxAccounts,
        remaining
      },
      limits: {
        maxPlatformConnections: maxAccounts
      }
    };
  }

  /**
   * Recalculate connection count from actual database records
   * Use this to fix drift or as a periodic maintenance task
   * @param {String} organizationId
   * @returns {Promise<{previous: Number, corrected: Number, drift: Number}>}
   */
  async recalculateConnectionCount(organizationId) {
    const organization = await Organization.findById(organizationId);
    if (!organization) {
      throw new Error('Organization not found');
    }

    const previous = organization.usage.currentPlatformConnections;

    // Count actual connections (excluding user-level Meta connections)
    const actualCount = await PlatformConnection.countDocuments({
      organization: organizationId,
      isActive: true,
      status: 'connected',
      $or: [
        { 'metadata.type': { $ne: 'user_token' } },
        { 'metadata.type': { $exists: false } }
      ]
    });

    organization.usage.currentPlatformConnections = actualCount;
    await organization.save();

    const drift = actualCount - previous;
    
    if (drift !== 0) {
      console.warn(`⚠️  [ConnectionService] Fixed connection count drift for org ${organizationId}: ${previous} → ${actualCount} (drift: ${drift})`);
    }

    return {
      previous,
      corrected: actualCount,
      drift
    };
  }
}

module.exports = new PlatformConnectionService();
