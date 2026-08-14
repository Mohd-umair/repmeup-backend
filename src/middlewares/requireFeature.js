/**
 * Express middleware factory that gates a route on a feature key.
 *
 *   router.post('/intent-buckets', protect, requireFeature(KEYS.INBOX_BUCKET_CREATE), ctrl);
 *
 * On a denied request:
 *   - 403 if the feature is a boolean and turned off (FEATURE_DISABLED)
 *   - 402 if the feature is a quota and exhausted   (QUOTA_EXCEEDED)
 *
 * Body shape mirrors `EntitlementError`:
 *   { success: false, code, error, featureKey, meta? }
 */

const entitlementsService = require('../services/entitlementsService');
const { FEATURE_KEYS } = require('../config/featureCatalog');

/** One response shape for every gate below, mirroring `EntitlementError`. */
function handleEntitlementError(err, res, next) {
  if (err && err.name === 'EntitlementError') {
    return res.status(err.statusCode || 402).json({
      success: false,
      code: err.code,
      error: err.message,
      featureKey: err.featureKey,
      meta: err.meta
    });
  }
  return next(err);
}

function requireFeature(featureKey, { amount = 1 } = {}) {
  return async function requireFeatureMiddleware(req, res, next) {
    try {
      const orgId = req.user?.organization?._id || req.user?.organization;
      if (!orgId) {
        return res.status(401).json({ success: false, error: 'Authentication required' });
      }
      await entitlementsService.assert(orgId.toString(), featureKey, amount);
      return next();
    } catch (err) {
      return handleEntitlementError(err, res, next);
    }
  };
}

/**
 * Gate a route on an ENUM ladder — the org must be at or above `minLevel`.
 *
 *   router.post('/orders', protect, requireLevel(KEYS.COMMERCE_ORDERS_LEVEL, 'basic'), ctrl);
 *
 * `enumOptions` order is the ladder (ascending), so 'full' satisfies a 'basic' gate.
 * Denied requests get 403 FEATURE_LEVEL_TOO_LOW with the required and current rungs.
 */
function requireLevel(featureKey, minLevel) {
  return async function requireLevelMiddleware(req, res, next) {
    try {
      const orgId = req.user?.organization?._id || req.user?.organization;
      if (!orgId) {
        return res.status(401).json({ success: false, error: 'Authentication required' });
      }
      await entitlementsService.assertLevel(orgId.toString(), featureKey, minLevel);
      return next();
    } catch (err) {
      return handleEntitlementError(err, res, next);
    }
  };
}

/**
 * Gate a route on membership of a LIST feature — e.g. `channels.allowed ∋ 'youtube'`.
 *
 *   router.get('/youtube/connect', protect, requireChannel('youtube'), ctrl);
 *   router.post('/:id/connect', protect, requireChannel(async (req) => lookupPlatform(req)), ctrl);
 *
 * `resolve` is a channel name, or a (possibly async) function returning one — some
 * routes only know the platform after loading the record they are about to connect.
 *
 * Returning a falsy value SKIPS the gate rather than denying: a route that cannot tell
 * us which channel it is connecting is a wiring bug, and failing closed there would
 * break connections we never meant to touch.
 */
function requireChannel(resolve, featureKey = FEATURE_KEYS.CHANNELS_ALLOWED) {
  return async function requireChannelMiddleware(req, res, next) {
    try {
      const orgId = req.user?.organization?._id || req.user?.organization;
      if (!orgId) {
        return res.status(401).json({ success: false, error: 'Authentication required' });
      }
      const member = typeof resolve === 'function' ? await resolve(req) : resolve;
      if (!member) return next();
      await entitlementsService.assertListMember(orgId.toString(), featureKey, String(member).toLowerCase());
      return next();
    } catch (err) {
      return handleEntitlementError(err, res, next);
    }
  };
}

module.exports = { requireFeature, requireLevel, requireChannel };
