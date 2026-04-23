const User = require('../models/User');
const Organization = require('../models/Organization');
const Subscription = require('../models/Subscription');
const Interaction = require('../models/Interaction');
const { escapeRegex } = require('../utils/sanitize');
const userActivityLogService = require('../services/userActivityLogService');
const { parsePagination, paginationMeta } = require('../utils/pagination');
const cacheService = require('../services/cacheService');
const entitlementsService = require('../services/entitlementsService');

// @desc    Get all users in organization
// @route   GET /api/users
// @access  Private
exports.getUsers = async (req, res, next) => {
  try {
    const { role, status, search } = req.query;
    const organizationId = req.user.organization._id;
    const { page, limit, skip } = parsePagination(req.query);

    // Build query (exclude soft-deleted)
    const query = { organization: organizationId, deletedAt: null };

    if (role) {
      query.role = role;
    }

    if (status) {
      query.isActive = status === 'active';
    }

    if (search && typeof search === 'string' && search.trim()) {
      const escapedSearch = escapeRegex(search.trim());
      query.$or = [
        { firstName: { $regex: escapedSearch, $options: 'i' } },
        { lastName: { $regex: escapedSearch, $options: 'i' } },
        { email: { $regex: escapedSearch, $options: 'i' } }
      ];
    }

    const [total, users] = await Promise.all([
      User.countDocuments(query),
      User.find(query)
        .select('-password')
        .populate('assignedBuckets', 'name color')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
    ]);

    // Get assigned task counts for each user on this page
    const usersWithStats = await Promise.all(
      users.map(async (user) => {
        const assignedTasks = await Interaction.countDocuments({
          assignedTo: user._id,
          status: { $nin: ['resolved', 'closed'] }
        });

        const resolvedToday = await Interaction.countDocuments({
          assignedTo: user._id,
          status: { $in: ['resolved', 'closed'] },
          updatedAt: { $gte: new Date(new Date().setHours(0, 0, 0, 0)) }
        });

        return {
          ...user.toObject(),
          assignedTasks,
          resolvedToday
        };
      })
    );

    res.status(200).json({
      success: true,
      data: usersWithStats,
      pagination: paginationMeta(total, page, limit)
    });
  } catch (error) {
    console.error('Get users error:', error);
    next(error);
  }
};

// @desc    Get single user by ID
// @route   GET /api/users/:id
// @access  Private
exports.getUserById = async (req, res, next) => {
  try {
    const user = await User.findOne({
      _id: req.params.id,
      organization: req.user.organization._id,
      deletedAt: null
    }).select('-password');

    if (!user) {
      return res.status(404).json({
        success: false,
        error: 'User not found'
      });
    }

    // Get user statistics
    const assignedTasks = await Interaction.countDocuments({
      assignedTo: user._id,
      status: { $nin: ['resolved', 'closed'] }
    });

    const resolvedToday = await Interaction.countDocuments({
      assignedTo: user._id,
      status: { $in: ['resolved', 'closed'] },
      updatedAt: { $gte: new Date(new Date().setHours(0, 0, 0, 0)) }
    });

    const totalResolved = await Interaction.countDocuments({
      assignedTo: user._id,
      status: { $in: ['resolved', 'closed'] }
    });

    res.status(200).json({
      success: true,
      data: {
        ...user.toObject(),
        stats: {
          assignedTasks,
          resolvedToday,
          totalResolved
        }
      }
    });
  } catch (error) {
    console.error('Get user by ID error:', error);
    next(error);
  }
};

// @desc    Create new user (agent/team member)
// @route   POST /api/users
// @access  Private (Admin/Manager only)
exports.createUser = async (req, res, next) => {
  try {
    // Check if user has permission to create users
    if (!['admin', 'manager'].includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        error: 'You do not have permission to create users'
      });
    }

    const { email, password, firstName, lastName, role, assignedBuckets, assignedPlatforms } = req.body;
    const organizationId = req.user.organization._id;

    // Check if email already exists
    const existingUser = await User.findOne({ email: email.toLowerCase() });
    if (existingUser) {
      return res.status(400).json({
        success: false,
        error: 'Email already exists'
      });
    }

    // Check user limits via entitlementsService (single source of truth).
    const currentUserCount = await User.countDocuments({ organization: organizationId, isActive: true });
    const { allowed, limit: maxUsers } = await entitlementsService.canAddResource(
      organizationId,
      'users',
      currentUserCount
    );

    if (!allowed) {
      return res.status(400).json({
        success: false,
        error: `User limit reached. Your plan allows ${maxUsers} users. Upgrade to add more team members.`
      });
    }

    // Create user
    const userData = {
      email: email.toLowerCase(),
      password,
      firstName,
      lastName,
      role: role || 'agent',
      organization: organizationId,
      isActive: true
    };
    if (Array.isArray(assignedBuckets)) userData.assignedBuckets = assignedBuckets;
    if (Array.isArray(assignedPlatforms)) userData.assignedPlatforms = assignedPlatforms;

    const user = await User.create(userData);

    // Update usage counters on both the (legacy) Organization doc and the Subscription doc.
    // Both are kept in lockstep during the deprecation period; entitlementsService picks
    // the correct one automatically at read time.
    await Promise.all([
      Organization.findByIdAndUpdate(organizationId, { $inc: { 'usage.currentUsers': 1 } }),
      Subscription.updateOne(
        { organization: organizationId },
        { $inc: { 'usage.activeUsers': 1 } }
      )
    ]);
    await entitlementsService.invalidateEntitlements(organizationId);

    // Return user without password
    const userResponse = await User.findById(user._id).select('-password');

    res.status(201).json({
      success: true,
      data: userResponse,
      message: 'User created successfully'
    });
  } catch (error) {
    console.error('Create user error:', error);
    
    if (error.name === 'ValidationError') {
      const messages = Object.values(error.errors).map(err => err.message);
      return res.status(400).json({
        success: false,
        error: messages.join(', ')
      });
    }
    
    next(error);
  }
};

// @desc    Update user
// @route   PUT /api/users/:id
// @access  Private (Admin/Manager only, or own profile)
exports.updateUser = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { firstName, lastName, role, isActive, preferences, assignedBuckets, assignedPlatforms } = req.body;

    // Check if user exists in same organization
    const userToUpdate = await User.findOne({
      _id: id,
      organization: req.user.organization._id,
      deletedAt: null
    });

    if (!userToUpdate) {
      return res.status(404).json({
        success: false,
        error: 'User not found'
      });
    }

    // Check permissions
    const isSelfUpdate = req.user._id.toString() === id;
    const canUpdateOthers = ['admin', 'manager'].includes(req.user.role);

    if (!isSelfUpdate && !canUpdateOthers) {
      return res.status(403).json({
        success: false,
        error: 'You do not have permission to update this user'
      });
    }

    // Prevent self-role change and self-deactivation
    if (isSelfUpdate) {
      if (role && role !== userToUpdate.role) {
        return res.status(400).json({
          success: false,
          error: 'You cannot change your own role'
        });
      }
      if (isActive === false) {
        return res.status(400).json({
          success: false,
          error: 'You cannot deactivate your own account'
        });
      }
    }

    // Update fields
    const updateData = {};
    if (firstName) updateData.firstName = firstName;
    if (lastName) updateData.lastName = lastName;
    if (role && canUpdateOthers) updateData.role = role;
    if (typeof isActive === 'boolean' && canUpdateOthers) updateData.isActive = isActive;
    if (preferences) updateData.preferences = { ...userToUpdate.preferences, ...preferences };
    if (Array.isArray(assignedBuckets) && canUpdateOthers) updateData.assignedBuckets = assignedBuckets;
    if (Array.isArray(assignedPlatforms) && canUpdateOthers) updateData.assignedPlatforms = assignedPlatforms;

    const updatedUser = await User.findByIdAndUpdate(
      id,
      updateData,
      { new: true, runValidators: true }
    ).select('-password');

    // Invalidate cached user so protect middleware picks up the changes on next request
    cacheService.del(cacheService.userKey(id)).catch(() => {});

    res.status(200).json({
      success: true,
      data: updatedUser,
      message: 'User updated successfully'
    });
  } catch (error) {
    console.error('Update user error:', error);
    
    if (error.name === 'ValidationError') {
      const messages = Object.values(error.errors).map(err => err.message);
      return res.status(400).json({
        success: false,
        error: messages.join(', ')
      });
    }
    
    next(error);
  }
};

// @desc    Delete user (soft delete - deactivate)
// @route   DELETE /api/users/:id
// @access  Private (Admin only)
exports.deleteUser = async (req, res, next) => {
  try {
    // Only admins can delete users
    if (req.user.role !== 'admin') {
      return res.status(403).json({
        success: false,
        error: 'Only administrators can delete users'
      });
    }

    const { id } = req.params;

    // Check if user exists in same organization
    const userToDelete = await User.findOne({
      _id: id,
      organization: req.user.organization._id,
      deletedAt: null
    });

    if (!userToDelete) {
      return res.status(404).json({
        success: false,
        error: 'User not found'
      });
    }

    // Prevent self-deletion
    if (req.user._id.toString() === id) {
      return res.status(400).json({
        success: false,
        error: 'You cannot delete your own account'
      });
    }

    // Soft delete - just deactivate
    await User.findByIdAndUpdate(id, { isActive: false });

    // Invalidate cached user so protect middleware immediately sees deactivation
    cacheService.del(cacheService.userKey(id)).catch(() => {});

    // Unassign all interactions from this user
    await Interaction.updateMany(
      { assignedTo: id },
      { $unset: { assignedTo: '', assignedAt: '' } }
    );

    // Decrement usage counters on both the (legacy) Organization doc and the Subscription doc.
    const orgId = req.user.organization._id;
    await Promise.all([
      Organization.findByIdAndUpdate(orgId, { $inc: { 'usage.currentUsers': -1 } }),
      Subscription.updateOne(
        { organization: orgId, 'usage.activeUsers': { $gt: 0 } },
        { $inc: { 'usage.activeUsers': -1 } }
      )
    ]);
    await entitlementsService.invalidateEntitlements(orgId);

    res.status(200).json({
      success: true,
      message: 'User deleted successfully'
    });
  } catch (error) {
    console.error('Delete user error:', error);
    next(error);
  }
};

// @desc    Get user statistics
// @route   GET /api/users/:id/stats
// @access  Private
exports.getUserStats = async (req, res, next) => {
  try {
    const { id } = req.params;

    // Check if user exists in same organization
    const user = await User.findOne({
      _id: id,
      organization: req.user.organization._id,
      deletedAt: null
    }).select('-password');

    if (!user) {
      return res.status(404).json({
        success: false,
        error: 'User not found'
      });
    }

    // Get detailed statistics
    const now = new Date();
    const todayStart = new Date(now.setHours(0, 0, 0, 0));
    const weekStart = new Date(now.setDate(now.getDate() - 7));
    const monthStart = new Date(now.setDate(1));

    const [
      assignedTasks,
      resolvedToday,
      resolvedThisWeek,
      resolvedThisMonth,
      totalResolved,
      avgResponseTime
    ] = await Promise.all([
      // Assigned tasks (not resolved)
      Interaction.countDocuments({
        assignedTo: id,
        status: { $nin: ['resolved', 'closed'] }
      }),
      
      // Resolved today
      Interaction.countDocuments({
        assignedTo: id,
        status: { $in: ['resolved', 'closed'] },
        updatedAt: { $gte: todayStart }
      }),
      
      // Resolved this week
      Interaction.countDocuments({
        assignedTo: id,
        status: { $in: ['resolved', 'closed'] },
        updatedAt: { $gte: weekStart }
      }),
      
      // Resolved this month
      Interaction.countDocuments({
        assignedTo: id,
        status: { $in: ['resolved', 'closed'] },
        updatedAt: { $gte: monthStart }
      }),
      
      // Total resolved
      Interaction.countDocuments({
        assignedTo: id,
        status: { $in: ['resolved', 'closed'] }
      }),
      
      // Average response time (simplified)
      Interaction.aggregate([
        {
          $match: {
            assignedTo: user._id,
            'replies.0': { $exists: true }
          }
        },
        {
          $project: {
            responseTime: {
              $subtract: [
                { $arrayElemAt: ['$replies.timestamp', 0] },
                '$createdAt'
              ]
            }
          }
        },
        {
          $group: {
            _id: null,
            avgTime: { $avg: '$responseTime' }
          }
        }
      ])
    ]);

    res.status(200).json({
      success: true,
      data: {
        user: {
          _id: user._id,
          name: `${user.firstName} ${user.lastName}`,
          email: user.email,
          role: user.role
        },
        stats: {
          assignedTasks,
          resolvedToday,
          resolvedThisWeek,
          resolvedThisMonth,
          totalResolved,
          avgResponseTimeMinutes: avgResponseTime[0]?.avgTime 
            ? Math.round(avgResponseTime[0].avgTime / 60000) 
            : 0
        }
      }
    });
  } catch (error) {
    console.error('Get user stats error:', error);
    next(error);
  }
};

// @desc    Get available agents for assignment
// @route   GET /api/users/ai-credits
// @access  Private
exports.getAICredits = async (req, res, next) => {
  try {
    const organizationId = req.user.organization._id || req.user.organization;
    const aiCreditService = require('../services/aiCreditService');
    
    const credits = await aiCreditService.getUsage(organizationId);
    
    res.status(200).json({
      success: true,
      credits: credits
    });
  } catch (error) {
    console.error('Get AI credits error:', error);
    next(error);
  }
};

/**
 * Get AI credit usage history
 * GET /api/users/ai-credits/usage
 */
exports.getAICreditUsageHistory = async (req, res, next) => {
  try {
    const organizationId = req.user.organization._id || req.user.organization;
    const { page, limit, startDate, endDate } = req.query;

    // Dynamically import to avoid circular dependency
    const aiCreditService = require('../services/aiCreditService');
    const history = await aiCreditService.getUsageHistory(organizationId, {
      page,
      limit,
      startDate,
      endDate
    });

    res.status(200).json({
      success: true,
      ...history
    });
  } catch (error) {
    console.error('Get AI credit usage history error:', error);
    next(error);
  }
};

// @route   GET /api/users/agents/available
// @access  Private
exports.getAvailableAgents = async (req, res, next) => {
  try {
    const organizationId = req.user.organization._id;

    // Get all active agents and managers
    const agents = await User.find({
      organization: organizationId,
      deletedAt: null,
      isActive: true,
      role: { $in: ['agent', 'manager', 'admin'] }
    })
    .select('firstName lastName email role')
    .sort({ firstName: 1 });

    // Get current workload for each agent
    const agentsWithWorkload = await Promise.all(
      agents.map(async (agent) => {
        const assignedCount = await Interaction.countDocuments({
          assignedTo: agent._id,
          status: { $nin: ['resolved', 'closed'] }
        });

        return {
          _id: agent._id,
          firstName: agent.firstName,
          lastName: agent.lastName,
          name: `${agent.firstName} ${agent.lastName}`,
          email: agent.email,
          role: agent.role,
          currentWorkload: assignedCount
        };
      })
    );

    // Sort by workload (least busy first)
    agentsWithWorkload.sort((a, b) => a.currentWorkload - b.currentWorkload);

    res.status(200).json({
      success: true,
      count: agentsWithWorkload.length,
      data: agentsWithWorkload
    });
  } catch (error) {
    console.error('Get available agents error:', error);
    next(error);
  }
};

/**
 * @desc    SPA navigation beacon (page / route views)
 * @route   POST /api/users/me/activity
 * @access  Private
 */
exports.recordClientNavigation = async (req, res, next) => {
  try {
    const route = typeof req.body?.route === 'string' ? req.body.route.trim() : '';
    if (!route || route.length > 512) {
      return res.status(400).json({
        success: false,
        error: 'route is required (max 512 characters)'
      });
    }
    const title =
      typeof req.body?.title === 'string' ? req.body.title.trim().slice(0, 200) : undefined;
    const referrer =
      typeof req.body?.referrer === 'string' ? req.body.referrer.trim().slice(0, 512) : undefined;
    const meta = {};
    if (title) meta.title = title;
    if (referrer) meta.referrer = referrer;

    userActivityLogService.recordNavigation(req, route, meta);
    return res.status(204).send();
  } catch (error) {
    next(error);
  }
};

