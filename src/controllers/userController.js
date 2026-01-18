const User = require('../models/User');
const Organization = require('../models/Organization');
const Interaction = require('../models/Interaction');

// @desc    Get all users in organization
// @route   GET /api/users
// @access  Private
exports.getUsers = async (req, res, next) => {
  try {
    const { role, status, search } = req.query;
    const organizationId = req.user.organization._id;

    // Build query
    const query = { organization: organizationId };

    if (role) {
      query.role = role;
    }

    if (status) {
      query.isActive = status === 'active';
    }

    if (search) {
      query.$or = [
        { firstName: { $regex: search, $options: 'i' } },
        { lastName: { $regex: search, $options: 'i' } },
        { email: { $regex: search, $options: 'i' } }
      ];
    }

    const users = await User.find(query)
      .select('-password')
      .sort({ createdAt: -1 });

    // Get assigned task counts for each user
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
      count: usersWithStats.length,
      data: usersWithStats
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
      organization: req.user.organization._id
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

    const { email, password, firstName, lastName, role } = req.body;
    const organizationId = req.user.organization._id;

    // Check if email already exists
    const existingUser = await User.findOne({ email: email.toLowerCase() });
    if (existingUser) {
      return res.status(400).json({
        success: false,
        error: 'Email already exists'
      });
    }

    // Check organization limits
    const organization = await Organization.findById(organizationId);
    if (organization.usage.currentUsers >= organization.limits.maxUsers) {
      return res.status(400).json({
        success: false,
        error: `User limit reached. Your plan allows ${organization.limits.maxUsers} users.`
      });
    }

    // Create user
    const user = await User.create({
      email: email.toLowerCase(),
      password,
      firstName,
      lastName,
      role: role || 'agent',
      organization: organizationId,
      isActive: true
    });

    // Update organization user count
    await Organization.findByIdAndUpdate(organizationId, {
      $inc: { 'usage.currentUsers': 1 }
    });

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
    const { firstName, lastName, role, isActive, preferences } = req.body;

    // Check if user exists in same organization
    const userToUpdate = await User.findOne({
      _id: id,
      organization: req.user.organization._id
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

    const updatedUser = await User.findByIdAndUpdate(
      id,
      updateData,
      { new: true, runValidators: true }
    ).select('-password');

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
      organization: req.user.organization._id
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

    // Unassign all interactions from this user
    await Interaction.updateMany(
      { assignedTo: id },
      { $unset: { assignedTo: '', assignedAt: '' } }
    );

    // Update organization user count
    await Organization.findByIdAndUpdate(req.user.organization._id, {
      $inc: { 'usage.currentUsers': -1 }
    });

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
      organization: req.user.organization._id
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
// @route   GET /api/users/agents/available
// @access  Private
exports.getAvailableAgents = async (req, res, next) => {
  try {
    const organizationId = req.user.organization._id;

    // Get all active agents and managers
    const agents = await User.find({
      organization: organizationId,
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

