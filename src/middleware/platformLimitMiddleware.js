const platformConnectionService = require('../services/platformConnectionService');

/**
 * Middleware to check platform connection limits before allowing new connections
 * Open/Closed Principle: Easy to extend with new validation rules without modifying existing code
 */

/**
 * Check if organization can add a new platform connection
 * Returns 403 if limit is reached
 */
exports.checkConnectionLimit = async (req, res, next) => {
  try {
    const organizationId = req.user?.organization?._id || req.user?.organization;
    
    if (!organizationId) {
      return res.status(401).json({
        success: false,
        error: 'Organization not found'
      });
    }

    const result = await platformConnectionService.canAddConnection(organizationId);

    if (!result.canConnect) {
      return res.status(403).json({
        success: false,
        error: result.reason === 'PLATFORM_LIMIT_REACHED'
          ? `Your plan allows ${result.limit} social account${result.limit !== 1 ? 's' : ''}. You have ${result.current} connected. Please upgrade your plan or disconnect an account to add another.`
          : result.reason,
        code: result.reason,
        data: {
          limit: result.limit,
          current: result.current,
          canUpgrade: true
        }
      });
    }

    // Attach limit info to request for downstream use
    req.connectionLimits = {
      max: result.limit,
      current: result.current,
      remaining: result.limit - result.current
    };

    next();
  } catch (error) {
    console.error('Error checking connection limit:', error);
    next(error);
  }
};

/**
 * Attach connection limit info to request without blocking
 * Use this for read endpoints that need to show limit info
 */
exports.attachConnectionLimits = async (req, res, next) => {
  try {
    const organizationId = req.user?.organization?._id || req.user?.organization;
    
    if (!organizationId) {
      return next();
    }

    const remaining = await platformConnectionService.getRemainingSlots(organizationId);
    const organization = await require('../models/Organization').findById(organizationId)
      .select('limits.maxPlatformConnections usage.currentPlatformConnections');

    if (organization) {
      req.connectionLimits = {
        max: organization.limits.maxPlatformConnections,
        current: organization.usage.currentPlatformConnections,
        remaining
      };
    }

    next();
  } catch (error) {
    // Don't block request if this fails
    console.warn('Could not attach connection limits:', error);
    next();
  }
};
