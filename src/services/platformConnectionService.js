const PlatformConnection = require('../models/PlatformConnection');
const Organization = require('../models/Organization');

/**
 * Platform Connection Service
 * Single Responsibility: Manage platform connection limits and counting
 */
class PlatformConnectionService {
  /**
   * Check if organization can add a new platform connection
   * @param {String} organizationId - Organization ID
   * @returns {Promise<{canConnect: Boolean, reason?: String, limit?: Number, current?: Number}>}
   */
  async canAddConnection(organizationId) {
    const organization = await Organization.findById(organizationId);
    
    if (!organization) {
      return { 
        canConnect: false, 
        reason: 'Organization not found' 
      };
    }

    const isAtLimit = organization.checkLimit('platforms');
    
    if (isAtLimit) {
      return {
        canConnect: false,
        reason: 'PLATFORM_LIMIT_REACHED',
        limit: organization.limits.maxPlatformConnections,
        current: organization.usage.currentPlatformConnections
      };
    }

    return { 
      canConnect: true,
      limit: organization.limits.maxPlatformConnections,
      current: organization.usage.currentPlatformConnections
    };
  }

  /**
   * Get remaining connection slots for an organization
   * @param {String} organizationId
   * @returns {Promise<Number>}
   */
  async getRemainingSlots(organizationId) {
    const organization = await Organization.findById(organizationId);
    if (!organization) return 0;

    return Math.max(
      0, 
      organization.limits.maxPlatformConnections - organization.usage.currentPlatformConnections
    );
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
   * Get all connections for an organization with limit info
   * @param {String} organizationId
   * @returns {Promise<{connections: Array, usage: Object, limits: Object}>}
   */
  async getConnectionsWithLimits(organizationId) {
    const [connections, organization] = await Promise.all([
      PlatformConnection.find({
        organization: organizationId,
        isActive: true,
        status: { $in: ['connected', 'error', 'token_expired'] }
      })
      .select('-accessToken -refreshToken') // Don't expose tokens
      .sort({ createdAt: -1 }),
      
      Organization.findById(organizationId)
        .select('limits.maxPlatformConnections usage.currentPlatformConnections')
    ]);

    if (!organization) {
      throw new Error('Organization not found');
    }

    return {
      connections,
      usage: {
        current: organization.usage.currentPlatformConnections,
        max: organization.limits.maxPlatformConnections,
        remaining: Math.max(0, organization.limits.maxPlatformConnections - organization.usage.currentPlatformConnections)
      },
      limits: {
        maxPlatformConnections: organization.limits.maxPlatformConnections
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
