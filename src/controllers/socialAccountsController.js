const PlatformConnection = require('../models/PlatformConnection');
const Subscription = require('../models/Subscription');
const Plan = require('../models/Plan');
const metaAuth = require('../integrations/meta/metaAuth');

/**
 * @desc    Get available (authenticated but not connected) accounts
 * @route   GET /api/social-accounts/available
 * @access  Private
 */
exports.getAvailableAccounts = async (req, res, next) => {
  try {
    const orgId = req.user.organization._id;

    // Find available connections (authenticated but not actively used)
    const availableConnections = await PlatformConnection.find({
      organization: orgId,
      status: 'available',
      isActive: true
    }).select('-accessToken -refreshToken');

    // Get subscription to show plan info
    let subscription = await Subscription.findOne({ organization: orgId });
    
    if (!subscription) {
      const freePlan = await Plan.getByPlanId('free');
      subscription = {
        planName: freePlan?.name || 'Free',
        limits: freePlan?.limits || { maxAccounts: 1 },
        usage: { connectedAccounts: 0 }
      };
    }

    // Count currently connected
    const connectedCount = await PlatformConnection.countDocuments({
      organization: orgId,
      status: 'connected',
      usesAccountSlot: true
    });

    const maxAccounts = subscription.limits.maxAccounts;
    const remaining = maxAccounts === -1 ? Infinity : Math.max(0, maxAccounts - connectedCount);

    res.status(200).json({
      success: true,
      data: {
        accounts: availableConnections,
        plan: {
          name: subscription.planName,
          maxAccounts: subscription.limits.maxAccounts,
          connected: connectedCount,
          remaining
        }
      }
    });
  } catch (error) {
    console.error('Get available accounts error:', error);
    next(error);
  }
};

/**
 * @desc    Get all social accounts grouped by status
 * @route   GET /api/social-accounts
 * @access  Private
 */
exports.getAccountsGrouped = async (req, res, next) => {
  try {
    const orgId = req.user.organization._id;

    // Fetch all connections
    const allConnections = await PlatformConnection.find({
      organization: orgId,
      isActive: true
    })
    .select('-accessToken -refreshToken')
    .populate('metadata.parentConnection', 'platform platformUsername')
    .sort({ createdAt: -1 });

    // Group by status
    const grouped = {
      connected: allConnections.filter(c => c.status === 'connected'),
      available: allConnections.filter(c => c.status === 'available'),
      disconnected: allConnections.filter(c => c.status === 'disconnected'),
      error: allConnections.filter(c => c.status === 'error' || c.status === 'token_expired')
    };

    // Get subscription info
    let subscription = await Subscription.findOne({ organization: orgId });
    
    if (!subscription) {
      const freePlan = await Plan.getByPlanId('free');
      subscription = {
        planName: freePlan?.name || 'Free',
        limits: freePlan?.limits || { maxAccounts: 1 },
        usage: { connectedAccounts: grouped.connected.length }
      };
    }

    res.status(200).json({
      success: true,
      data: {
        grouped,
        counts: {
          connected: grouped.connected.length,
          available: grouped.available.length,
          disconnected: grouped.disconnected.length,
          error: grouped.error.length,
          total: allConnections.length
        },
        plan: {
          name: subscription.planName || 'Free',
          maxAccounts: subscription.limits?.maxAccounts || 1,
          connected: grouped.connected.filter(c => c.usesAccountSlot !== false).length,
          remaining: subscription.limits?.maxAccounts === -1 ? 
                    Infinity : 
                    Math.max(0, (subscription.limits?.maxAccounts || 1) - grouped.connected.filter(c => c.usesAccountSlot !== false).length)
        }
      }
    });
  } catch (error) {
    console.error('Get accounts grouped error:', error);
    next(error);
  }
};

/**
 * @desc    Connect an available account (change status available → connected)
 * @route   POST /api/social-accounts/:id/connect
 * @access  Private
 */
exports.connectAccount = async (req, res, next) => {
  try {
    const connection = await PlatformConnection.findOne({
      _id: req.params.id,
      organization: req.user.organization._id,
      status: 'available'
    });

    if (!connection) {
      return res.status(404).json({
        success: false,
        error: 'Available account not found'
      });
    }

    // Check subscription limits if this uses a slot
    if (connection.usesAccountSlot !== false) {
      const subscription = await Subscription.findOne({
        organization: req.user.organization._id
      });

      if (subscription && subscription.limits.maxAccounts !== -1) {
        const connectedCount = await PlatformConnection.countDocuments({
          organization: req.user.organization._id,
          status: 'connected',
          usesAccountSlot: true
        });

        if (connectedCount >= subscription.limits.maxAccounts) {
          return res.status(403).json({
            success: false,
            error: 'ACCOUNT_LIMIT_REACHED',
            message: `Your ${subscription.planName} plan allows ${subscription.limits.maxAccounts} accounts. Please upgrade to connect more.`,
            current: connectedCount,
            max: subscription.limits.maxAccounts
          });
        }
      }
    }

    // Update status
    connection.status = 'connected';
    connection.connectedAt = new Date();
    await connection.save();

    // Update subscription usage
    if (connection.usesAccountSlot !== false) {
      await Subscription.updateOne(
        { organization: req.user.organization._id },
        { $inc: { 'usage.connectedAccounts': 1 } }
      );
    }

    res.status(200).json({
      success: true,
      data: connection,
      message: `${connection.platform} account connected successfully`
    });
  } catch (error) {
    console.error('Connect account error:', error);
    next(error);
  }
};

/**
 * @desc    Disconnect account (change status connected → disconnected)
 * @route   POST /api/social-accounts/:id/disconnect
 * @access  Private
 */
exports.disconnectAccount = async (req, res, next) => {
  try {
    const connection = await PlatformConnection.findOne({
      _id: req.params.id,
      organization: req.user.organization._id,
      status: 'connected'
    });

    if (!connection) {
      return res.status(404).json({
        success: false,
        error: 'Connected account not found'
      });
    }

    // Update status
    connection.status = 'disconnected';
    connection.disconnectedAt = new Date();
    connection.isActive = false;
    await connection.save();

    // Revoke Meta webhook subscription for Instagram Login connections
    if (
      connection.platform === 'instagram' &&
      (connection.metadata?.connectionType === 'instagram_login' ||
        (typeof connection.accessToken === 'string' && connection.accessToken.startsWith('IGAA')))
    ) {
      const igLoginAuth = require('../integrations/meta/instagramLoginAuth');
      const isuid = connection.metadata?.igLoginScopedId || connection.platformUserId;
      igLoginAuth.unsubscribeFromWebhook(isuid, connection.accessToken).catch(() => {});
    }

    // Update subscription usage
    if (connection.usesAccountSlot !== false) {
      await Subscription.updateOne(
        { organization: req.user.organization._id },
        { $inc: { 'usage.connectedAccounts': -1 } }
      );
    }

    // Get remaining slots
    const subscription = await Subscription.findOne({
      organization: req.user.organization._id
    });

    const remaining = subscription && subscription.limits.maxAccounts !== -1 ?
                     Math.max(0, subscription.limits.maxAccounts - (subscription.usage.connectedAccounts - 1)) :
                     Infinity;

    res.status(200).json({
      success: true,
      data: connection,
      message: `${connection.platform} account disconnected successfully`,
      slotsAvailable: remaining
    });
  } catch (error) {
    console.error('Disconnect account error:', error);
    next(error);
  }
};

/**
 * @desc    Reconnect previously disconnected account
 * @route   POST /api/social-accounts/:id/reconnect
 * @access  Private
 */
exports.reconnectAccount = async (req, res, next) => {
  try {
    const connection = await PlatformConnection.findOne({
      _id: req.params.id,
      organization: req.user.organization._id,
      status: 'disconnected'
    });

    if (!connection) {
      return res.status(404).json({
        success: false,
        error: 'Disconnected account not found'
      });
    }

    // Check subscription limits if this uses a slot
    if (connection.usesAccountSlot !== false) {
      const subscription = await Subscription.findOne({
        organization: req.user.organization._id
      });

      if (subscription && subscription.limits.maxAccounts !== -1) {
        const connectedCount = await PlatformConnection.countDocuments({
          organization: req.user.organization._id,
          status: 'connected',
          usesAccountSlot: true
        });

        if (connectedCount >= subscription.limits.maxAccounts) {
          return res.status(403).json({
            success: false,
            error: 'ACCOUNT_LIMIT_REACHED',
            message: `Your ${subscription.planName} plan allows ${subscription.limits.maxAccounts} accounts. Please upgrade to connect more.`,
            current: connectedCount,
            max: subscription.limits.maxAccounts
          });
        }
      }
    }

    // Update status
    connection.status = 'connected';
    connection.connectedAt = new Date();
    connection.isActive = true;
    await connection.save();

    // Update subscription usage
    if (connection.usesAccountSlot !== false) {
      await Subscription.updateOne(
        { organization: req.user.organization._id },
        { $inc: { 'usage.connectedAccounts': 1 } }
      );
    }

    res.status(200).json({
      success: true,
      data: connection,
      message: `${connection.platform} account reconnected successfully`
    });
  } catch (error) {
    console.error('Reconnect account error:', error);
    next(error);
  }
};
