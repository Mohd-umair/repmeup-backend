const platformConnectionService = require('../services/platformConnectionService');
const entitlementsService = require('../services/entitlementsService');

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
 * Attach connection limit info to request without blocking.
 * Used by read endpoints that need to show limit info in the UI.
 *
 * Source of truth: entitlementsService — not Organization.limits (legacy).
 */
exports.attachConnectionLimits = async (req, res, next) => {
  try {
    const organizationId = req.user?.organization?._id || req.user?.organization;

    if (!organizationId) {
      return next();
    }

    const [entitlements, remaining] = await Promise.all([
      entitlementsService.getEntitlements(organizationId),
      platformConnectionService.getRemainingSlots(organizationId)
    ]);

    const max = entitlements.limits.maxAccounts;
    const current = entitlements.usage.connectedAccounts ?? 0;
    req.connectionLimits = { max, current, remaining };

    next();
  } catch (error) {
    // Don't block the request if this fails — it's informational, not authoritative.
    console.warn('Could not attach connection limits:', error);
    next();
  }
};
