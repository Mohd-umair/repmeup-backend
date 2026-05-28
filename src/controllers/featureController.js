/**
 * Feature catalog controller.
 *
 * - Super admin reads the full catalog to render the dynamic Plan form.
 * - Authenticated org users read a derived "what is enabled for me" view via
 *   /api/entitlements (different controller).
 *
 * The catalog itself is code-defined and seeded; this controller never lets
 * admins create new feature keys at runtime — adding a key requires a deploy
 * because every key must have backend enforcement code wired up first.
 */

const Feature = require('../models/Feature');
const entitlementsService = require('../services/entitlementsService');
const { isEnforcedFeatureKey } = require('../config/featureCatalog');

/**
 * GET /api/super-admin/features
 * Returns the active catalog grouped by category with all admin-renderable
 * metadata (kind, defaultValue, unit, resetPeriod, enumOptions).
 */
exports.listCatalog = async (req, res, next) => {
  try {
    const items = (await Feature.getCatalog()).map((row) => ({
      ...row,
      enforced: isEnforcedFeatureKey(row.key)
    }));

    const grouped = items.reduce((acc, row) => {
      const cat = row.category || 'general';
      if (!acc[cat]) acc[cat] = [];
      acc[cat].push(row);
      return acc;
    }, {});

    res.status(200).json({
      success: true,
      data: { items, grouped, kinds: Feature.KINDS, categories: Feature.CATEGORIES }
    });
  } catch (err) {
    next(err);
  }
};

/**
 * GET /api/entitlements
 * Per-org resolved entitlements snapshot for the frontend store.
 * Always 200 with the resolved snapshot (or hard defaults) so the UI can render
 * even when the org has no subscription doc yet.
 */
exports.getMine = async (req, res, next) => {
  try {
    const orgId = req.user?.organization?._id || req.user?.organization;
    if (!orgId) {
      return res.status(401).json({ success: false, error: 'Authentication required' });
    }
    const ent = await entitlementsService.getEntitlements(orgId.toString());
    res.status(200).json({ success: true, data: ent });
  } catch (err) {
    next(err);
  }
};
