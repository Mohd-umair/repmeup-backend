const crypto = require('crypto');
const User = require('../models/User');
const Organization = require('../models/Organization');
const { generateToken, generateRefreshToken } = require('../middlewares/auth');
const googleAuthService = require('../integrations/google/googleAuthService');
const emailService = require('./emailService');

class AuthService {
  /**
   * Register new user with organization
   */
  async register(userData) {
    try {
      const { email, password, firstName, lastName, organizationName } = userData;

      // Check if user already exists
      const existingUser = await User.findOne({ email });
      if (existingUser) {
        throw new Error('User with this email already exists');
      }

      // Create organization first
      const organization = await Organization.create({
        name: organizationName,
        owner: null, // Will be updated after user creation
        subscription: {
          plan: 'free',
          status: 'trial',
          startDate: new Date()
        }
      });

      // Create user
      const user = await User.create({
        email,
        password,
        firstName,
        lastName,
        role: 'admin', // First user is always admin
        organization: organization._id
      });

      // Update organization owner
      organization.owner = user._id;
      organization.usage.currentUsers = 1;
      await organization.save();

      // Generate tokens
      const token = generateToken(user._id);
      const refreshToken = generateRefreshToken(user._id);

      return {
        user,
        organization,
        token,
        refreshToken
      };
    } catch (error) {
      throw error;
    }
  }

  /**
   * Login user
   */
  async login(email, password) {
    try {
      const user = await User.findOne({ email })
        .select('+password')
        .populate('organization')
        .populate({ path: 'group', populate: { path: 'permissions', select: 'code name category actions' } });

      if (!user) {
        throw new Error('Invalid credentials');
      }

      if (user.deletedAt) {
        throw new Error('This account is no longer available.');
      }

      if (!user.isActive) {
        throw new Error('Account is deactivated. Please contact support.');
      }

      const isPasswordValid = await user.comparePassword(password);
      if (!isPasswordValid) {
        throw new Error('Invalid credentials');
      }

      user.lastLogin = new Date();
      await user.save();

      const token = generateToken(user._id);
      const refreshToken = generateRefreshToken(user._id);

      const userObj = user.toJSON();
      userObj.resolvedPermissions = this._extractPermissionCodes(user);

      return {
        user: userObj,
        token,
        refreshToken
      };
    } catch (error) {
      throw error;
    }
  }

  /**
   * Get user by ID
   */
  async getUserById(userId) {
    try {
      const user = await User.findById(userId)
        .populate('organization')
        .populate({ path: 'group', populate: { path: 'permissions', select: 'code name category actions' } });
      if (!user) {
        throw new Error('User not found');
      }
      const userObj = user.toJSON();
      userObj.resolvedPermissions = this._extractPermissionCodes(user);
      return userObj;
    } catch (error) {
      throw error;
    }
  }

  /**
   * Update user profile
   */
  async updateProfile(userId, updateData) {
    try {
      const allowedUpdates = ['firstName', 'lastName', 'avatar', 'preferences'];
      const updates = {};

      Object.keys(updateData).forEach(key => {
        if (allowedUpdates.includes(key)) {
          updates[key] = updateData[key];
        }
      });

      const user = await User.findByIdAndUpdate(
        userId,
        updates,
        { new: true, runValidators: true }
      ).populate('organization');

      return user;
    } catch (error) {
      throw error;
    }
  }

  /**
   * Change password
   */
  async changePassword(userId, currentPassword, newPassword) {
    try {
      const user = await User.findById(userId).select('+password');

      if (!user) {
        throw new Error('User not found');
      }

      // Verify current password
      const isValid = await user.comparePassword(currentPassword);
      if (!isValid) {
        throw new Error('Current password is incorrect');
      }

      // Update password
      user.password = newPassword;
      await user.save();

      return { message: 'Password updated successfully' };
    } catch (error) {
      throw error;
    }
  }

  /**
   * Create team member
   */
  async createTeamMember(organizationId, creatorId, userData) {
    try {
      const { email, firstName, lastName, role } = userData;

      // Check if user already exists
      const existingUser = await User.findOne({ email });
      if (existingUser) {
        throw new Error('User with this email already exists');
      }

      // Check organization limits
      const organization = await Organization.findById(organizationId);
      if (organization.checkLimit('users')) {
        throw new Error('User limit reached for your plan');
      }

      // Generate temporary password
      const tempPassword = Math.random().toString(36).slice(-8);

      // Create user
      const user = await User.create({
        email,
        password: tempPassword,
        firstName,
        lastName,
        role: role || 'agent',
        organization: organizationId
      });

      // Update organization user count
      organization.usage.currentUsers += 1;
      await organization.save();

      // TODO: Send welcome email with temporary password

      return {
        user,
        tempPassword // In production, this should be emailed, not returned
      };
    } catch (error) {
      throw error;
    }
  }
  /**
   * Google OAuth Login/Signup
   */
  async googleAuth(googleProfile) {
    try {
      const { email, id: providerId, firstName, lastName, picture } = googleProfile;

      // Check if user exists
      let user = await User.findOne({ email }).populate('organization');

      if (user) {
        if (user.deletedAt) {
          throw new Error('This account is no longer available.');
        }
        if (!user.isActive) {
          throw new Error('Account is deactivated. Please contact support.');
        }
        // Block sign-in if RISC reported this Google account as disabled
        if (user.risc && user.risc.googleSignInDisabled) {
          throw new Error(
            'Google sign-in has been temporarily disabled for this account due to a security event. ' +
            'Please contact support or use your email and password to log in.'
          );
        }

        // User exists - update OAuth info and login
        user.oauth = {
          provider: 'google',
          providerId,
          profile: googleProfile
        };
        user.lastLogin = new Date();
        
        if (!user.avatar && picture) {
          user.avatar = picture;
        }
        
        await user.save();
      } else {
        // Create new user and organization
        const organizationName = `${firstName}'s Organization`;
        
        const organization = await Organization.create({
          name: organizationName,
          owner: null,
          subscription: {
            plan: 'free',
            status: 'trial',
            startDate: new Date()
          }
        });

        user = await User.create({
          email,
          firstName,
          lastName,
          role: 'admin',
          organization: organization._id,
          avatar: picture,
          isEmailVerified: true, // Google emails are verified
          oauth: {
            provider: 'google',
            providerId,
            profile: googleProfile
          },
          metadata: {
            signupSource: 'google_oauth'
          }
        });

        // Update organization owner
        organization.owner = user._id;
        organization.usage.currentUsers = 1;
        await organization.save();

        // Populate organization for response
        user = await User.findById(user._id).populate('organization');
      }

      // Generate tokens
      const token = generateToken(user._id);
      const refreshToken = generateRefreshToken(user._id);

      return {
        user: user.toJSON(),
        token,
        refreshToken,
        isNewUser: !user.lastLogin || user.createdAt.getTime() === user.updatedAt.getTime()
      };
    } catch (error) {
      console.error('Google auth error:', error);
      throw error;
    }
  }

  /**
   * Request password reset — generate token, save to user, send email
   */
  async forgotPassword(email) {
    const user = await User.findOne({ email: email.toLowerCase() });

    // Always respond generically so we don't reveal whether email exists
    if (!user) return;

    // Generate a random token
    const rawToken = crypto.randomBytes(32).toString('hex');
    const hashedToken = crypto.createHash('sha256').update(rawToken).digest('hex');

    user.passwordResetToken = hashedToken;
    user.passwordResetExpires = new Date(Date.now() + 60 * 60 * 1000); // 1 hour
    await user.save({ validateBeforeSave: false });

    await emailService.sendPasswordResetEmail(user, rawToken);
  }

  /**
   * Reset password using the token from the email link
   */
  async resetPassword(rawToken, newPassword) {
    const hashedToken = crypto.createHash('sha256').update(rawToken).digest('hex');

    const user = await User.findOne({
      passwordResetToken: hashedToken,
      passwordResetExpires: { $gt: Date.now() }
    });

    if (!user) {
      throw new Error('Password reset token is invalid or has expired');
    }

    user.password = newPassword;
    user.passwordResetToken = undefined;
    user.passwordResetExpires = undefined;
    await user.save();

    const token = generateToken(user._id);
    const refreshToken = generateRefreshToken(user._id);

    return { token, refreshToken };
  }

  _extractPermissionCodes(user) {
    if (user.group && user.group.permissions && user.group.permissions.length > 0) {
      return user.group.permissions.map(p => typeof p === 'object' ? p.code : p).filter(Boolean);
    }
    return [];
  }
}

module.exports = new AuthService();

