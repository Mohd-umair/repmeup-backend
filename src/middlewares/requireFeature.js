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
  };
}

module.exports = { requireFeature };
