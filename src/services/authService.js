const User = require('../models/User');
const Organization = require('../models/Organization');
const { generateToken, generateRefreshToken } = require('../middlewares/auth');

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
      // Find user with password field
      const user = await User.findOne({ email })
        .select('+password')
        .populate('organization');

      if (!user) {
        throw new Error('Invalid credentials');
      }

      // Check if user is active
      if (!user.isActive) {
        throw new Error('Account is deactivated. Please contact support.');
      }

      // Verify password
      const isPasswordValid = await user.comparePassword(password);
      if (!isPasswordValid) {
        throw new Error('Invalid credentials');
      }

      // Update last login
      user.lastLogin = new Date();
      await user.save();

      // Generate tokens
      const token = generateToken(user._id);
      const refreshToken = generateRefreshToken(user._id);

      // Remove password from response
      const userObj = user.toJSON();

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
      const user = await User.findById(userId).populate('organization');
      if (!user) {
        throw new Error('User not found');
      }
      return user;
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
}

module.exports = new AuthService();

