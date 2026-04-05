const authService = require('../services/authService');
const emailService = require('../services/emailService');
const userActivityLogService = require('../services/userActivityLogService');

// @desc    Register user & organization
// @route   POST /api/auth/register
// @access  Public
exports.register = async (req, res, next) => {
  try {
    const result = await authService.register(req.body);

    const orgId =
      result.user.organization?._id || result.user.organization;
    userActivityLogService.recordAuthEvent({
      userId: result.user._id,
      organizationId: orgId,
      action: 'register',
      path: '/api/auth/register',
      method: 'POST',
      statusCode: 201,
      ip: userActivityLogService.clientIp(req),
      userAgent: req.headers['user-agent']
    });

    try {
      await emailService.sendWelcomeEmail(result.user);
    } catch (welcomeErr) {
      console.warn('[auth] Welcome email failed:', welcomeErr.message);
    }

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

    const orgId =
      result.user.organization?._id || result.user.organization;
    userActivityLogService.recordAuthEvent({
      userId: result.user._id,
      organizationId: orgId,
      action: 'login',
      path: '/api/auth/login',
      method: 'POST',
      statusCode: 200,
      ip: userActivityLogService.clientIp(req),
      userAgent: req.headers['user-agent']
    });

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

    try {
      await emailService.sendWelcomeEmail(result.user, result.tempPassword);
    } catch (welcomeErr) {
      console.warn('[auth] Team welcome email failed:', welcomeErr.message);
    }

    res.status(201).json({
      success: true,
      data: {
        user: result.user,
        message: 'Team member created. If email is configured, a welcome message was sent.'
      }
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error.message
    });
  }
};

// @desc    Google OAuth Login/Signup
// @route   Called from Google callback route
// @access  Public
exports.googleAuth = async (googleProfile) => {
  try {
    const result = await authService.googleAuth(googleProfile);
    return result;
  } catch (error) {
    throw error;
  }
};

// @desc    Forgot password — send reset email
// @route   POST /api/auth/forgot-password
// @access  Public
exports.forgotPassword = async (req, res, next) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ success: false, error: 'Email is required' });
    }

    await authService.forgotPassword(email);

    // Always return the same message to avoid email enumeration
    res.status(200).json({
      success: true,
      data: { message: 'If an account with that email exists, a password reset link has been sent.' }
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Send 6-digit OTP to email for passwordless login
// @route   POST /api/auth/send-otp
// @access  Public
exports.sendLoginOtp = async (req, res, next) => {
  try {
    const { email } = req.body;
    if (!email) {
      return res.status(400).json({ success: false, error: 'Email is required.' });
    }
    // Always 200 to avoid user enumeration
    await authService.sendLoginOtp(email);
    res.status(200).json({ success: true, message: 'If an account exists, a login code has been sent.' });
  } catch (error) {
    if (error.message.includes('Please wait')) {
      return res.status(429).json({ success: false, error: error.message });
    }
    next(error);
  }
};

// @desc    Verify OTP and issue auth tokens
// @route   POST /api/auth/verify-otp
// @access  Public
exports.verifyLoginOtp = async (req, res, next) => {
  try {
    const { email, otp } = req.body;
    if (!email || !otp) {
      return res.status(400).json({ success: false, error: 'Email and OTP are required.' });
    }

    const result = await authService.verifyLoginOtp(email, otp);

    const orgId = result.user.organization?._id || result.user.organization;
    userActivityLogService.recordAuthEvent({
      userId: result.user._id,
      organizationId: orgId,
      action: 'login_otp',
      path: '/api/auth/verify-otp',
      method: 'POST',
      statusCode: 200,
      ip: userActivityLogService.clientIp(req),
      userAgent: req.headers['user-agent']
    });

    res.status(200).json({
      success: true,
      data: {
        token: result.token,
        refreshToken: result.refreshToken,
        user: result.user
      }
    });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
};

// @desc    Reset password using token
// @route   POST /api/auth/reset-password
// @access  Public
exports.resetPassword = async (req, res, next) => {
  try {
    const { token, password } = req.body;

    if (!token || !password) {
      return res.status(400).json({ success: false, error: 'Token and new password are required' });
    }

    if (password.length < 6) {
      return res.status(400).json({ success: false, error: 'Password must be at least 6 characters' });
    }

    const result = await authService.resetPassword(token, password);

    res.status(200).json({
      success: true,
      data: {
        message: 'Password reset successfully',
        token: result.token,
        refreshToken: result.refreshToken
      }
    });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
};

