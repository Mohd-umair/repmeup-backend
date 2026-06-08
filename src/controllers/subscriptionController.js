const Subscription = require('../models/Subscription');
const PlatformConnection = require('../models/PlatformConnection');
const Plan = require('../models/Plan');
const User = require('../models/User');
const ScheduledPost = require('../models/ScheduledPost');
const AICreditUsage = require('../models/AICreditUsage');
const entitlementsService = require('../services/entitlementsService');
const { buildPublicPlanCard } = require('../services/planPresentationService');
const { cancelRazorpaySubscription } = require('./razorpayController');

/**
 * Build the demo/trial status block for the limits payload.
 * Returns null for normal (non-demo) workspaces so the frontend can simply check
 * `data.trial` truthiness to decide whether to show trial UI.
 */
function buildTrialStatus(subscription) {
  if (!subscription || !subscription.isDemo) return null;
  const now = Date.now();
  const endsAt = subscription.trialEndsAt ? new Date(subscription.trialEndsAt).getTime() : null;
  const msLeft = endsAt != null ? endsAt - now : null;
  const daysRemaining = msLeft != null ? Math.max(0, Math.ceil(msLeft / (24 * 60 * 60 * 1000))) : null;
  return {
    isDemo: true,
    demoStatus: subscription.demoStatus || 'trialing',   // trialing | locked | converted
    locked: subscription.demoStatus === 'locked',
    trialEndsAt: subscription.trialEndsAt ?? null,
    daysRemaining,
    expired: msLeft != null ? msLeft <= 0 : false
  };
}

/**
 * @desc    Get subscription limits and usage for organization
 * @route   GET /api/subscription/limits
 * @access  Private
 */
exports.getLimits = async (req, res, next) => {
  try {
    let subscription = await Subscription.findOne({
      organization: req.user.organization._id
    });

    // If no subscription exists, create free plan
    if (!subscription) {
      const freePlan = await Plan.getByPlanId('free');
      if (!freePlan) {
        return res.status(500).json({
          success: false,
          error: 'Free plan not found in database. Please run seed:plans script.'
        });
      }

      const initialUserCount = await User.countDocuments({
        organization: req.user.organization._id,
        isActive: true
      });

      subscription = await Subscription.create({
        organization: req.user.organization._id,
        planId: freePlan.planId,
        planName: freePlan.name,
        tier: freePlan.tier,
        limits: freePlan.limits,
        features: freePlan.features,
        status: 'active',
        usage: { activeUsers: initialUserCount }
      });
    }

    // Compute all real-time usage values from actual data
    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);

    const [
      connectedAccountsCount,
      activeUserCount,
      postsThisMonthCount,
      autoRepliesThisMonthCount,
      aiCreditsAgg
    ] = await Promise.all([
      PlatformConnection.countDocuments({
        organization: req.user.organization._id,
        status: 'connected',
        usesAccountSlot: true
      }),
      User.countDocuments({
        organization: req.user.organization._id,
        isActive: true
      }),
      ScheduledPost.countDocuments({
        organization: req.user.organization._id,
        status: 'published',
        publishedAt: { $gte: startOfMonth }
      }),
      AICreditUsage.countDocuments({
        organization: req.user.organization._id,
        operation: 'auto_reply',
        createdAt: { $gte: startOfMonth }
      }),
      AICreditUsage.aggregate([
        {
          $match: {
            organization: req.user.organization._id,
            createdAt: { $gte: startOfMonth }
          }
        },
        { $group: { _id: null, total: { $sum: '$creditsUsed' } } }
      ])
    ]);

    const aiCreditsThisMonth = aiCreditsAgg[0]?.total ?? 0;

    subscription.usage.connectedAccounts = connectedAccountsCount;
    subscription.usage.activeUsers = activeUserCount;
    subscription.usage.postsThisMonth = postsThisMonthCount;
    subscription.usage.autoRepliesThisMonth = autoRepliesThisMonthCount;
    subscription.usage.aiCreditsThisMonth = aiCreditsThisMonth;
    await subscription.save();

    const orgId = req.user.organization._id;
    const ent = await entitlementsService.getEntitlements(orgId);
    const resolvedLimits = { ...ent.limits };

    // Per-demo AI-credit cap overrides the (unlimited) plan limit for display +
    // enforcement parity with aiCreditService.checkCredits.
    if (subscription.isDemo && subscription.demoCreditsCap != null && subscription.demoCreditsCap >= 0) {
      resolvedLimits.maxAICreditsPerMonth = subscription.demoCreditsCap;
    }

    const canConnectMore =
      resolvedLimits.maxAccounts === -1 ||
      subscription.usage.connectedAccounts < resolvedLimits.maxAccounts;

    const remaining =
      resolvedLimits.maxAccounts === -1
        ? Infinity
        : Math.max(0, resolvedLimits.maxAccounts - subscription.usage.connectedAccounts);

    const currentTier = ent.tier ?? subscription.tier;
    const nextTierPlan = await Plan.getNextTierPlan(currentTier);
    const nextTier = nextTierPlan
      ? {
          ...buildPublicPlanCard(nextTierPlan),
          planId: nextTierPlan.planId,
          name: nextTierPlan.name,
          tier: nextTierPlan.tier,
          price: nextTierPlan.price,
          maxAccounts: buildPublicPlanCard(nextTierPlan).limits.maxAccounts
        }
      : null;

    res.status(200).json({
      success: true,
      data: {
        plan: ent.planName || subscription.planName,
        planId: ent.planId || subscription.planId,
        tier: ent.tier ?? subscription.tier,
        status: subscription.status,
        limits: {
          ...resolvedLimits,
          // Keep -1 (unlimited) and an explicit demo cap (incl. 0) intact;
          // only fall back to 500 when the value is truly absent.
          maxAICreditsPerMonth:
            resolvedLimits.maxAICreditsPerMonth == null
              ? 500
              : resolvedLimits.maxAICreditsPerMonth
        },
        usage: subscription.usage,
        canConnectMore,
        remaining,
        nextTier,
        billing: {
          currentPeriodStart: subscription.currentPeriodStart ?? null,
          currentPeriodEnd: subscription.currentPeriodEnd ?? null,
          nextBillingAt: subscription.razorpayNextBillingAt ?? null,
          cancelAtPeriodEnd: subscription.cancelAtPeriodEnd ?? false,
          cancelledAt: subscription.cancelledAt ?? null,
          cancellationReason: subscription.cancellationReason ?? null,
          planHistory: (subscription.planHistory || []).slice(-5).map(h => ({
            planId: h.planId,
            planName: h.planName,
            changedAt: h.changedAt,
            reason: h.reason || null
          }))
        },
        // Demo/trial status — drives the prospect trial banner + lock screen.
        // Null for normal (non-demo) workspaces.
        trial: buildTrialStatus(subscription)
      }
    });
  } catch (error) {
    console.error('Get subscription limits error:', error);
    next(error);
  }
};

/**
 * @desc    Check if organization can connect N more accounts
 * @route   POST /api/subscription/check-limit
 * @access  Private
 */
exports.checkLimit = async (req, res, next) => {
  try {
    const { accountsToConnect = 1 } = req.body;

    let subscription = await Subscription.findOne({
      organization: req.user.organization._id
    });

    if (!subscription) {
      // Create free plan if doesn't exist
      const freePlan = await Plan.getByPlanId('free');
      if (!freePlan) {
        return res.status(500).json({
          success: false,
          error: 'Free plan not found in database. Please run seed:plans script.'
        });
      }
      
      subscription = await Subscription.create({
        organization: req.user.organization._id,
        planId: freePlan.planId,
        planName: freePlan.name,
        tier: freePlan.tier,
        limits: freePlan.limits,
        features: freePlan.features
      });
    }

    // Count current connections
    const connectedCount = await PlatformConnection.countDocuments({
      organization: req.user.organization._id,
      status: 'connected',
      usesAccountSlot: true
    });

    const maxAccounts = subscription.limits.maxAccounts;
    const isUnlimited = maxAccounts === -1;
    const wouldExceed = !isUnlimited && (connectedCount + accountsToConnect > maxAccounts);

    const response = {
      allowed: isUnlimited || !wouldExceed,
      current: connectedCount,
      max: maxAccounts,
      requested: accountsToConnect,
      isUnlimited,
      upgradeRequired: wouldExceed
    };

    if (wouldExceed) {
      response.exceededBy = (connectedCount + accountsToConnect) - maxAccounts;
      response.message = `Your ${subscription.planName} plan allows ${maxAccounts} accounts. ` +
                        `You have ${connectedCount} connected. ` +
                        `Cannot connect ${accountsToConnect} more.`;
    }

    res.status(200).json({
      success: true,
      data: response
    });
  } catch (error) {
    console.error('Check limit error:', error);
    next(error);
  }
};

/**
 * @desc    Get subscription details
 * @route   GET /api/subscription
 * @access  Private
 */
exports.getSubscription = async (req, res, next) => {
  try {
    let subscription = await Subscription.findOne({
      organization: req.user.organization._id
    });

    // If no subscription exists, create free plan
    if (!subscription) {
      const freePlan = await Plan.getByPlanId('free');
      if (!freePlan) {
        return res.status(500).json({
          success: false,
          error: 'Free plan not found in database. Please run seed:plans script.'
        });
      }
      
      subscription = await Subscription.create({
        organization: req.user.organization._id,
        planId: freePlan.planId,
        planName: freePlan.name,
        tier: freePlan.tier,
        limits: freePlan.limits,
        features: freePlan.features
      });
    }

    res.status(200).json({
      success: true,
      data: subscription
    });
  } catch (error) {
    console.error('Get subscription error:', error);
    next(error);
  }
};

/**
 * @desc    Get all available plans (from database)
 * @route   GET /api/subscription/plans
 * @access  Public
 *
 * @deprecated Duplicates `GET /api/plans` (planController.getPlans). Kept for
 * one release for backward-compat with older clients; new callers should hit
 * `/api/plans`. The response shape and data are identical. This handler will
 * be removed in the next major version — see the dynamic plan + feature
 * engine plan, "cleanup" task.
 */
exports.getPlans = async (req, res, next) => {
  try {
    res.set('Deprecation', 'true');
    res.set('Link', '</api/plans>; rel="successor-version"');

    const plans = await Plan.getPublicPlans();
    const plansObject = {};
    plans.forEach((plan) => {
      const card = buildPublicPlanCard(plan);
      plansObject[plan.planId] = {
        ...card,
        legacyFeatures: plan.features || []
      };
    });

    res.status(200).json({
      success: true,
      data: plansObject,
      deprecated: true,
      successor: '/api/plans'
    });
  } catch (error) {
    console.error('Get plans error:', error);
    next(error);
  }
};

/**
 * @desc    Upgrade subscription plan
 * @route   POST /api/subscription/upgrade
 * @access  Private (Admin/Manager)
 */
exports.upgradePlan = async (req, res, next) => {
  try {
    const { planId } = req.body;

    // Fetch plan from database
    const newPlan = await Plan.getByPlanId(planId);
    
    if (!newPlan) {
      return res.status(400).json({
        success: false,
        error: 'Invalid plan ID or plan not available'
      });
    }

    let subscription = await Subscription.findOne({
      organization: req.user.organization._id
    });

    if (!subscription) {
      return res.status(404).json({
        success: false,
        error: 'Subscription not found'
      });
    }

    if (newPlan.tier < subscription.tier) {
      return res.status(400).json({
        success: false,
        error: 'Changing to a lower-tier plan is not supported. Contact support if you need help.'
      });
    }

    // Save to history
    subscription.planHistory.push({
      planId: subscription.planId,
      planName: subscription.planName,
      changedAt: new Date(),
      changedBy: req.user._id,
      reason: 'upgrade'
    });
    
    // Update subscription with new plan details
    subscription.planId = newPlan.planId;
    subscription.planName = newPlan.name;
    subscription.tier = newPlan.tier;
    subscription.limits = newPlan.limits;
    subscription.features = newPlan.features;

    await subscription.save();

    // Entitlements have changed — drop the cache so the next request re-resolves.
    await entitlementsService.invalidateEntitlements(subscription.organization);

    res.status(200).json({
      success: true,
      data: subscription,
      message: `Successfully upgraded to ${newPlan.name} plan`
    });
  } catch (error) {
    console.error('Upgrade plan error:', error);
    next(error);
  }
};

/**
 * @desc    Cancel subscription
 * @route   POST /api/subscription/cancel
 * @access  Private (Admin)
 */
exports.reactivateSubscription = async (req, res, next) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ success: false, error: 'Only administrators can reactivate subscriptions' });
    }

    const subscription = await Subscription.findOne({ organization: req.user.organization._id });
    if (!subscription) {
      return res.status(404).json({ success: false, error: 'Subscription not found' });
    }

    if (!subscription.cancelAtPeriodEnd) {
      return res.status(400).json({ success: false, error: 'Subscription is not scheduled for cancellation.' });
    }

    subscription.cancelAtPeriodEnd = false;
    subscription.cancelledAt = undefined;
    subscription.cancelledBy = undefined;
    subscription.cancellationReason = undefined;
    if (subscription.status !== 'active') {
      subscription.status = 'active';
    }

    await subscription.save();

    res.status(200).json({ success: true, message: 'Subscription reactivated successfully.', data: subscription });
  } catch (error) {
    console.error('Reactivate subscription error:', error);
    next(error);
  }
};

exports.cancelSubscription = async (req, res, next) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({
        success: false,
        error: 'Only administrators can cancel subscriptions'
      });
    }

    const { cancelAtPeriodEnd = true, reason } = req.body;

    const subscription = await Subscription.findOne({
      organization: req.user.organization._id
    });

    if (!subscription) {
      return res.status(404).json({
        success: false,
        error: 'Subscription not found'
      });
    }

    subscription.cancelAtPeriodEnd = cancelAtPeriodEnd;
    subscription.cancellationReason = reason;
    subscription.cancelledBy = req.user._id;
    subscription.cancelledAt = new Date();

    if (!cancelAtPeriodEnd) {
      subscription.status = 'cancelled';
    }

    // Also cancel the active Razorpay subscription (at cycle end to match cancelAtPeriodEnd)
    if (subscription.razorpaySubscriptionId) {
      await cancelRazorpaySubscription(subscription.razorpaySubscriptionId);
    }

    await subscription.save();

    res.status(200).json({
      success: true,
      data: subscription,
      message: cancelAtPeriodEnd 
        ? 'Subscription will be cancelled at the end of the current period' 
        : 'Subscription cancelled immediately'
    });
  } catch (error) {
    console.error('Cancel subscription error:', error);
    next(error);
  }
};
