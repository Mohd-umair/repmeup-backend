const authService = require('../services/authService');
const emailService = require('../services/emailService');

// @desc    Register user & organization
// @route   POST /api/auth/register
// @access  Public
exports.register = async (req, res, next) => {
  try {
    const result = await authService.register(req.body);

    // Send welcome email
    await emailService.sendWelcomeEmail(result.user);

    res.status(201).json({
      success: true,
      data: {
        user: result.user,
        organization: result.organization,
        token: result.token,
        refreshToken: result.refreshToken
      }
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Login user
// @route   POST /api/auth/login
// @access  Public
exports.login = async (req, res, next) => {
  try {
    const { email, password } = req.body;

    const result = await authService.login(email, password);

    res.status(200).json({
      success: true,
      data: {
        user: result.user,
        token: result.token,
        refreshToken: result.refreshToken
      }
    });
  } catch (error) {
    res.status(401).json({
      success: false,
      error: error.message
    });
  }
};

// @desc    Get current logged in user
// @route   GET /api/auth/me
// @access  Private
exports.getMe = async (req, res, next) => {
  try {
    const user = await authService.getUserById(req.user._id);

    res.status(200).json({
      success: true,
      data: user
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Update user profile
// @route   PUT /api/auth/profile
// @access  Private
exports.updateProfile = async (req, res, next) => {
  try {
    const user = await authService.updateProfile(req.user._id, req.body);

    res.status(200).json({
      success: true,
      data: user
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Change password
// @route   PUT /api/auth/change-password
// @access  Private
exports.changePassword = async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      return res.status(400).json({
        success: false,
        error: 'Please provide current password and new password'
      });
    }

    const result = await authService.changePassword(
      req.user._id,
      currentPassword,
      newPassword
    );

    res.status(200).json({
      success: true,
      data: result
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error.message
    });
  }
};

// @desc    Logout user
// @route   POST /api/auth/logout
// @access  Private
exports.logout = async (req, res, next) => {
  try {
    // In a real app, you might want to blacklist the token
    // For now, just return success (client will delete token)
    res.status(200).json({
      success: true,
      data: { message: 'Logged out successfully' }
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Create team member
// @route   POST /api/auth/team-member
// @access  Private (Admin/Manager only)
exports.createTeamMember = async (req, res, next) => {
  try {
    const result = await authService.createTeamMember(
      req.user.organization._id,
      req.user._id,
      req.body
    );

    // Send welcome email with temp password
    await emailService.sendWelcomeEmail(result.user, result.tempPassword);

    res.status(201).json({
      success: true,
      data: {
        user: result.user,
        message: 'Team member created. Welcome email sent with temporary password.'
      }
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error.message
    });
  }
};

