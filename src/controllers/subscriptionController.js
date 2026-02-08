const Subscription = require('../models/Subscription');
const PlatformConnection = require('../models/PlatformConnection');
const Plan = require('../models/Plan');
const User = require('../models/User');

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

    // Count actual connected accounts and active users (keep usage in sync)
    const connectedAccountsCount = await PlatformConnection.countDocuments({
      organization: req.user.organization._id,
      status: 'connected',
      usesAccountSlot: true
    });
    const activeUserCount = await User.countDocuments({
      organization: req.user.organization._id,
      isActive: true
    });

    subscription.usage.connectedAccounts = connectedAccountsCount;
    subscription.usage.activeUsers = activeUserCount;
    await subscription.save();

    // Calculate remaining quota
    const canConnectMore = subscription.limits.maxAccounts === -1 || 
                          subscription.usage.connectedAccounts < subscription.limits.maxAccounts;

    const remaining = subscription.limits.maxAccounts === -1 ? 
                     Infinity : 
                     Math.max(0, subscription.limits.maxAccounts - subscription.usage.connectedAccounts);

    // Get next tier info from database
    const currentTier = subscription.tier;
    const nextTier = await Plan.getNextTierPlan(currentTier);

    res.status(200).json({
      success: true,
      data: {
        plan: subscription.planName,
        planId: subscription.planId,
        tier: subscription.tier,
        status: subscription.status,
        limits: subscription.limits,
        usage: subscription.usage,
        canConnectMore,
        remaining,
        nextTier: nextTier ? {
          name: nextTier.name,
          tier: nextTier.tier,
          maxAccounts: nextTier.limits.maxAccounts,
          price: nextTier.price,
          planId: nextTier.planId
        } : null
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

    // Check if downgrade
    if (newPlan.tier < subscription.tier) {
      return res.status(400).json({
        success: false,
        error: 'Cannot downgrade plan. Please contact support.'
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
