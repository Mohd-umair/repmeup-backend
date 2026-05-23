const Plan = require('../models/Plan');
const planAdminService = require('../services/planAdminService');
const entitlementsService = require('../services/entitlementsService');
const { syncPlanWithRazorpay, RazorpayPlanSyncError } = require('../services/razorpayPlanService');
const Subscription = require('../models/Subscription');
const { CATALOG_BY_KEY } = require('../config/featureCatalog');
const { emitToOrg } = require('../utils/socketEmitter');

/**
 * Sanitize an `entitlements` map sent by the admin UI:
 *   - Drops keys not in the catalog (admins can't invent feature keys at runtime).
 *   - Coerces numeric `limit` strings to numbers.
 *   - Coerces boolean strings to true/false.
 *   - Returns a plain object for Plan.entitlements (Mixed — keys may contain ".").
 */
function sanitizeEntitlementsPayload(rawIn) {
  if (!rawIn || typeof rawIn !== 'object') return undefined;
  const cleaned = {};
  for (const [key, value] of Object.entries(rawIn)) {
    const catalogEntry = CATALOG_BY_KEY[key];
    if (!catalogEntry || !value || typeof value !== 'object') continue;
    const next = {};
    if (catalogEntry.kind === 'boolean') {
      if (value.enabled !== undefined) next.enabled = value.enabled === true || value.enabled === 'true';
    } else if (catalogEntry.kind === 'limit') {
      const v = value.limit ?? value.value;
      if (v !== undefined && v !== null && v !== '') {
        const n = Number(v);
        if (Number.isFinite(n)) next.limit = n;
      }
    } else if (value.value !== undefined) {
      next.value = value.value;
    }
    if (Object.keys(next).length) cleaned[key] = next;
  }
  return cleaned;
}

function applyRazorpaySyncToPlan(plan, syncResult) {
  if (syncResult.razorpayPlanId) {
    plan.razorpayPlanId = syncResult.razorpayPlanId;
  } else {
    plan.razorpayPlanId = undefined;
  }
  if (syncResult.priceInr != null && syncResult.priceInr > 0) {
    plan.priceInr = syncResult.priceInr;
  } else {
    plan.priceInr = undefined;
  }
}

/**
 * Plan Management Controller
 * For super admin to manage subscription plans
 */

/**
 * @desc    Get all plans (public - for users)
 * @route   GET /api/plans
 * @access  Public
 */
exports.getPlans = async (req, res, next) => {
  try {
    const plans = await Plan.getPublicPlans();
    
    // Transform to match frontend expectation (object with planId as keys)
    const plansObject = {};
    plans.forEach(plan => {
      plansObject[plan.planId] = {
        name: plan.name,
        tier: plan.tier,
        price: plan.price,
        limits: plan.limits,
        features: plan.features,
        badge: plan.badge,
        badgeColor: plan.badgeColor
      };
    });

    res.status(200).json({
      success: true,
      data: plansObject
    });
  } catch (error) {
    console.error('Get plans error:', error);
    next(error);
  }
};

/**
 * @desc    Get all plans (admin - full details)
 * @route   GET /api/plans/admin
 * @access  Private (Super Admin only)
 */
exports.getAllPlansAdmin = async (req, res, next) => {
  try {
    // Check if user is super admin
    if (req.user.role !== 'super_admin' && req.user.role !== 'admin') {
      return res.status(403).json({
        success: false,
        error: 'Access denied. Super admin only.'
      });
    }

    const plans = await Plan.find().sort({ displayOrder: 1, tier: 1 }).lean();
    const countMap = await planAdminService.getSubscriptionCountMap();
    const data = planAdminService.attachSubscriptionCounts(plans, countMap);

    res.status(200).json({
      success: true,
      data,
      count: data.length
    });
  } catch (error) {
    console.error('Get all plans admin error:', error);
    next(error);
  }
};

/**
 * @desc    Get single plan by ID
 * @route   GET /api/plans/:planId
 * @access  Public
 */
exports.getPlanById = async (req, res, next) => {
  try {
    const plan = await Plan.getByPlanId(req.params.planId);

    if (!plan) {
      return res.status(404).json({
        success: false,
        error: 'Plan not found'
      });
    }

    res.status(200).json({
      success: true,
      data: plan
    });
  } catch (error) {
    console.error('Get plan by ID error:', error);
    next(error);
  }
};

/**
 * @desc    Create new plan
 * @route   POST /api/plans/admin
 * @access  Private (Super Admin only)
 */
exports.createPlan = async (req, res, next) => {
  try {
    // Check if user is super admin
    if (req.user.role !== 'super_admin' && req.user.role !== 'admin') {
      return res.status(403).json({
        success: false,
        error: 'Access denied. Super admin only.'
      });
    }

    const {
      planId,
      name,
      description,
      tier,
      price,
      billingCycle,
      limits,
      features,
      entitlements,
      badge,
      badgeColor,
      highlightColor,
      isActive,
      isPublic,
      displayOrder,
      stripePriceId,
      stripeProductId,
      trialDays
    } = req.body;

    // Check if plan with same planId already exists
    const existingPlan = await Plan.findOne({ planId });
    if (existingPlan) {
      return res.status(400).json({
        success: false,
        error: 'Plan with this planId already exists'
      });
    }

    const draftPlan = {
      planId,
      name,
      description,
      tier,
      price,
      billingCycle,
      limits,
      features,
      entitlements: sanitizeEntitlementsPayload(entitlements),
      badge,
      badgeColor,
      highlightColor,
      isActive,
      isPublic,
      displayOrder,
      stripePriceId,
      stripeProductId,
      trialDays
    };

    let razorpaySync;
    try {
      razorpaySync = await syncPlanWithRazorpay(draftPlan);
    } catch (err) {
      if (err instanceof RazorpayPlanSyncError) {
        return res.status(err.statusCode).json({ success: false, error: err.message });
      }
      throw err;
    }

    const plan = await Plan.create({
      ...draftPlan,
      razorpayPlanId: razorpaySync.razorpayPlanId || undefined,
      priceInr: razorpaySync.priceInr || undefined,
      createdBy: req.user._id
    });

    res.status(201).json({
      success: true,
      data: plan,
      message: razorpaySync.created
        ? 'Plan created and linked to Razorpay successfully'
        : 'Plan created successfully'
    });
  } catch (error) {
    console.error('Create plan error:', error);
    next(error);
  }
};

/**
 * @desc    Update plan
 * @route   PUT /api/plans/admin/:id
 * @access  Private (Super Admin only)
 */
exports.updatePlan = async (req, res, next) => {
  try {
    // Check if user is super admin
    if (req.user.role !== 'super_admin' && req.user.role !== 'admin') {
      return res.status(403).json({
        success: false,
        error: 'Access denied. Super admin only.'
      });
    }

    const plan = await Plan.findById(req.params.id);

    if (!plan) {
      return res.status(404).json({
        success: false,
        error: 'Plan not found'
      });
    }

    const previousPlan = plan.toObject();

    // Update fields (razorpayPlanId/priceInr are server-managed via Razorpay sync)
    const allowedFields = [
      'name', 'description', 'tier', 'price', 'billingCycle',
      'limits', 'features', 'badge', 'badgeColor', 'highlightColor',
      'isActive', 'isPublic', 'displayOrder', 'stripePriceId',
      'stripeProductId', 'trialDays'
    ];

    allowedFields.forEach(field => {
      if (req.body[field] !== undefined) {
        plan[field] = req.body[field];
      }
    });

    if (req.body.entitlements !== undefined) {
      const cleaned = sanitizeEntitlementsPayload(req.body.entitlements) || {};
      plan.entitlements = cleaned;
      plan.markModified('entitlements');
    }

    let razorpaySync;
    try {
      razorpaySync = await syncPlanWithRazorpay(plan, previousPlan);
    } catch (err) {
      if (err instanceof RazorpayPlanSyncError) {
        return res.status(err.statusCode).json({ success: false, error: err.message });
      }
      throw err;
    }

    applyRazorpaySyncToPlan(plan, razorpaySync);
    plan.updatedBy = req.user._id;
    await plan.save();

    // Keep org subscriptions aligned with template (limits/features/name/tier).
    const syncedSubscriptionCount = await planAdminService.syncSubscriptionsFromPlan(plan);

    // Drop entitlement caches for every org on this plan AND tell their
    // active socket sessions to refetch — keeps the FE store in lock-step
    // with admin edits without requiring a page reload.
    try {
      const subs = await Subscription.find({ planId: plan.planId }).select('organization').lean();
      await Promise.all(
        subs.map(async (s) => {
          const orgId = String(s.organization);
          await entitlementsService.invalidateEntitlements(orgId);
          emitToOrg(orgId, 'entitlements:invalidated', { reason: 'plan-update', planId: plan.planId });
        })
      );
    } catch (e) {
      console.warn('[updatePlan] cache invalidation failed (non-fatal):', e.message);
    }

    res.status(200).json({
      success: true,
      data: plan,
      message: razorpaySync.created
        ? 'Plan updated and new Razorpay plan linked (price or billing changed)'
        : 'Plan updated successfully',
      syncedSubscriptionCount
    });
  } catch (error) {
    console.error('Update plan error:', error);
    next(error);
  }
};

/**
 * @desc    Delete plan
 * @route   DELETE /api/plans/admin/:id
 * @access  Private (Super Admin only)
 */
exports.deletePlan = async (req, res, next) => {
  try {
    // Check if user is super admin
    if (req.user.role !== 'super_admin' && req.user.role !== 'admin') {
      return res.status(403).json({
        success: false,
        error: 'Access denied. Super admin only.'
      });
    }

    const plan = await Plan.findById(req.params.id);

    if (!plan) {
      return res.status(404).json({
        success: false,
        error: 'Plan not found'
      });
    }

    // Check if any subscriptions are using this plan
    const Subscription = require('../models/Subscription');
    const subscriptionCount = await Subscription.countDocuments({ planId: plan.planId });

    if (subscriptionCount > 0) {
      return res.status(400).json({
        success: false,
        error: `Cannot delete plan. ${subscriptionCount} subscription(s) are currently using this plan.`,
        subscriptionCount
      });
    }

    await plan.deleteOne();

    res.status(200).json({
      success: true,
      message: 'Plan deleted successfully'
    });
  } catch (error) {
    console.error('Delete plan error:', error);
    next(error);
  }
};

/**
 * @desc    Toggle plan active status
 * @route   PATCH /api/plans/admin/:id/toggle-active
 * @access  Private (Super Admin only)
 */
exports.togglePlanActive = async (req, res, next) => {
  try {
    // Check if user is super admin
    if (req.user.role !== 'super_admin' && req.user.role !== 'admin') {
      return res.status(403).json({
        success: false,
        error: 'Access denied. Super admin only.'
      });
    }

    const plan = await Plan.findById(req.params.id);

    if (!plan) {
      return res.status(404).json({
        success: false,
        error: 'Plan not found'
      });
    }

    plan.isActive = !plan.isActive;
    plan.updatedBy = req.user._id;
    await plan.save();

    res.status(200).json({
      success: true,
      data: plan,
      message: `Plan ${plan.isActive ? 'activated' : 'deactivated'} successfully`
    });
  } catch (error) {
    console.error('Toggle plan active error:', error);
    next(error);
  }
};
