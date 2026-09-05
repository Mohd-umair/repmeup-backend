const crypto = require('crypto');
const User = require('../models/User');
const Organization = require('../models/Organization');
const Group = require('../models/Group');
const { generateToken, generateRefreshToken } = require('../middlewares/auth');
const googleAuthService = require('../integrations/google/googleAuthService');
const emailService = require('./emailService');

class AuthService {
  /**
   * Normalize Google profile names and derive a default org name (always creates a sensible org on signup).
   * @param {object} googleProfile - from googleAuthService.getUserProfile / verifyIdToken
   * @returns {{ email: string, providerId: string, firstName: string, lastName: string, picture?: string, organizationName: string }}
   */
  _normalizeGoogleSignupProfile(googleProfile) {
    const email = (googleProfile.email || '').toLowerCase().trim();
    const providerId = googleProfile.id;
    const picture = googleProfile.picture;
    const fullName = (googleProfile.fullName || '').trim();

    let firstName = (googleProfile.firstName || '').trim();
    let lastName = (googleProfile.lastName || '').trim();

    if (!firstName && fullName) {
      const parts = fullName.split(/\s+/).filter(Boolean);
      firstName = parts[0] || '';
      lastName = lastName || parts.slice(1).join(' ');
    }

    const localPart = email.split('@')[0] || 'user';
    if (!firstName) {
      firstName = localPart.replace(/[._-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) || 'User';
    }
    if (!lastName) {
      lastName = 'Team';
    }

    const display = [firstName, lastName].filter((s) => s && String(s).trim()).join(' ').trim();
    const organizationName = display
      ? `${display}'s Organization`
      : `${localPart}'s Organization`;

    return { email, providerId, firstName, lastName, picture, organizationName };
  }

  /**
   * Register new user with organization
   */
  async register(userData) {
    try {
      const { email, password, firstName, lastName, organizationName } = userData;
      const normalizedEmail = (email || '').toLowerCase().trim();

      // Check if user already exists
      const existingUser = await User.findOne({ email: normalizedEmail });
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

      const rawVerifyToken = crypto.randomBytes(32).toString('hex');
      const hashedVerifyToken = crypto.createHash('sha256').update(rawVerifyToken).digest('hex');
      const verifyExpiryMs =
        parseInt(process.env.EMAIL_VERIFICATION_EXPIRY_MS || '', 10) || 48 * 60 * 60 * 1000;

      // Create user (password hashed by pre-save hook)
      const user = await User.create({
        email: normalizedEmail,
        password,
        firstName,
        lastName,
        role: 'admin', // First user is always admin
        organization: organization._id,
        isEmailVerified: false,
        emailVerificationToken: hashedVerifyToken,
        emailVerificationExpires: new Date(Date.now() + verifyExpiryMs),
        emailVerificationLastSent: new Date(),
        metadata: {
          signupSource: 'email_password'
        }
      });

      // Update organization owner
      organization.owner = user._id;
      organization.usage.currentUsers = 1;
      await organization.save();

      // No JWT until email is verified — client shows "check your inbox"
      return {
        user,
        organization,
        verificationTokenPlain: rawVerifyToken
      };
    } catch (error) {
      throw error;
    }
  }

  /**
   * Confirm email using the raw token from the signup link (hashed compare).
   */
  async verifyEmail(rawToken) {
    if (!rawToken || typeof rawToken !== 'string') {
      throw new Error('Verification token is required');
    }

    const hashed = crypto.createHash('sha256').update(rawToken.trim()).digest('hex');
    const user = await User.findOne({
      emailVerificationToken: hashed,
      emailVerificationExpires: { $gt: Date.now() }
    }).populate('organization');

    if (!user) {
      throw new Error('This verification link is invalid or has expired. Request a new one from the sign-in page.');
    }

    user.isEmailVerified = true;
    user.emailVerificationToken = undefined;
    user.emailVerificationExpires = undefined;
    await user.save({ validateBeforeSave: false });

    const token = generateToken(user._id);
    const refreshToken = generateRefreshToken(user._id);

    const userObj = user.toJSON();
    const effectiveGroup = await this._resolveEffectiveGroup(user);
    if (!userObj.group && effectiveGroup) {
      userObj.group = { _id: effectiveGroup._id, name: effectiveGroup.name, slug: effectiveGroup.slug };
    }
    userObj.resolvedPermissions = this._extractPermissionCodes(user, effectiveGroup);

    return {
      user: userObj,
      token,
      refreshToken
    };
  }

  /**
   * Resend signup verification email. Generic success when no account / already verified.
   */
  async resendVerificationEmail(email) {
    const normalizedEmail = (email || '').toLowerCase().trim();
    if (!normalizedEmail) return;

    const user = await User.findOne({ email: normalizedEmail });
    if (!user || user.deletedAt || !user.isActive) return;

    // OAuth-only users have no password and are already treated as verified at signup
    if (!user.password) return;
    if (user.isEmailVerified) return;

    const minGapMs = 60 * 1000;
    if (user.emailVerificationLastSent && Date.now() - new Date(user.emailVerificationLastSent).getTime() < minGapMs) {
      throw new Error('Please wait a minute before requesting another verification email.');
    }

    const rawVerifyToken = crypto.randomBytes(32).toString('hex');
    const hashedVerifyToken = crypto.createHash('sha256').update(rawVerifyToken).digest('hex');
    const verifyExpiryMs =
      parseInt(process.env.EMAIL_VERIFICATION_EXPIRY_MS || '', 10) || 48 * 60 * 60 * 1000;

    user.emailVerificationToken = hashedVerifyToken;
    user.emailVerificationExpires = new Date(Date.now() + verifyExpiryMs);
    user.emailVerificationLastSent = new Date();
    await user.save({ validateBeforeSave: false });

    await emailService.sendEmailVerificationEmail(user, rawVerifyToken);
  }

  /**
   * Login user
   */
  async login(email, password) {
    try {
      const normalizedEmail = (email || '').toLowerCase().trim();
      const user = await User.findOne({ email: normalizedEmail })
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

      // Email/password signups must verify before login. Legacy accounts have no pending token.
      const pendingEmailVerification =
        user.isEmailVerified === false && user.emailVerificationToken;
      if (pendingEmailVerification) {
        throw new Error(
          'Please verify your email before signing in. Check your inbox for the verification link, or use “Resend verification” on the sign-in page.'
        );
      }

      // Block sign-in to a demo workspace whose trial has expired (locked).
      // Data is retained; purchasing unlocks the same workspace.
      if (await this._isWorkspaceLocked(user.organization)) {
        const err = new Error('Your demo trial has ended. Purchase a plan to continue — all your data is safe.');
        err.code = 'UPGRADE_REQUIRED';
        err.statusCode = 403;
        throw err;
      }

      user.lastLogin = new Date();
      await user.save();

      const token = generateToken(user._id);
      const refreshToken = generateRefreshToken(user._id);

      const userObj = user.toJSON();
      const effectiveGroup = await this._resolveEffectiveGroup(user);
      if (!userObj.group && effectiveGroup) {
        userObj.group = { _id: effectiveGroup._id, name: effectiveGroup.name, slug: effectiveGroup.slug };
      }
      userObj.resolvedPermissions = this._extractPermissionCodes(user, effectiveGroup);

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
   * Is the given organization a demo workspace whose trial has expired (locked)?
   * Cheap check: prefers the denormalized `organization.demo.lockedAt`, falling
   * back to the authoritative Subscription.demoStatus only when needed.
   * @param {object|string} organization Populated org doc (preferred) or org id.
   */
  async _isWorkspaceLocked(organization) {
    if (!organization) return false;
    // Fast path: denormalized flag on the (already-populated) org document.
    if (organization.demo) {
      if (organization.demo.lockedAt) return true;
      if (organization.demo.isDemo !== true) return false; // not a demo → never locked
    }
    // Authoritative fallback (e.g. org passed as id, or denormalized flag absent).
    const orgId = organization._id || organization;
    const Subscription = require('../models/Subscription');
    const sub = await Subscription.findOne({ organization: orgId })
      .select('isDemo demoStatus')
      .lean();
    return !!(sub && sub.isDemo && sub.demoStatus === 'locked');
  }

  /**
   * Magic-link login for demo prospects. Consumes a one-time token (hashed on the
   * user as `demoMagicToken`) and issues a normal JWT session — no password needed.
   * @param {string} rawToken The plaintext token from the magic link.
   */
  async demoLogin(rawToken) {
    if (!rawToken || typeof rawToken !== 'string') {
      const err = new Error('Invalid or missing demo login token');
      err.statusCode = 400;
      throw err;
    }

    const hashed = crypto.createHash('sha256').update(rawToken.trim()).digest('hex');
    const user = await User.findOne({
      demoMagicToken: hashed,
      demoMagicTokenExpires: { $gt: new Date() }
    })
      .select('+demoMagicToken +demoMagicTokenExpires')
      .populate('organization')
      .populate({ path: 'group', populate: { path: 'permissions', select: 'code name category actions' } });

    if (!user) {
      const err = new Error('This demo link is invalid or has expired.');
      err.statusCode = 401;
      throw err;
    }
    if (user.deletedAt || !user.isActive) {
      const err = new Error('This demo account is no longer available.');
      err.statusCode = 401;
      throw err;
    }

    // Locked trial → cannot enter via magic link either; must purchase.
    if (await this._isWorkspaceLocked(user.organization)) {
      const err = new Error('Your demo trial has ended. Purchase a plan to continue — all your data is safe.');
      err.code = 'UPGRADE_REQUIRED';
      err.statusCode = 403;
      throw err;
    }

    user.lastLogin = new Date();
    await user.save();

    const token = generateToken(user._id);
    const refreshToken = generateRefreshToken(user._id);

    const userObj = user.toJSON();
    const effectiveGroup = await this._resolveEffectiveGroup(user);
    if (!userObj.group && effectiveGroup) {
      userObj.group = { _id: effectiveGroup._id, name: effectiveGroup.name, slug: effectiveGroup.slug };
    }
    userObj.resolvedPermissions = this._extractPermissionCodes(user, effectiveGroup);

    return { user: userObj, token, refreshToken };
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
      const effectiveGroup = await this._resolveEffectiveGroup(user);
      if (!userObj.group && effectiveGroup) {
        userObj.group = { _id: effectiveGroup._id, name: effectiveGroup.name, slug: effectiveGroup.slug };
      }
      userObj.resolvedPermissions = this._extractPermissionCodes(user, effectiveGroup);
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

      if (updates.preferences) {
        const existing = await User.findById(userId).select('preferences').lean();
        updates.preferences = {
          ...(existing?.preferences || {}),
          ...updates.preferences
        };
      }

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

      // Update password — clear super-admin recoverable copy when user changes it themselves
      user.password = newPassword;
      user.adminRecoverablePassword = undefined;
      user.adminPasswordSetAt = undefined;
      user.adminPasswordSetBy = undefined;
      await user.save();

      return { message: 'Password updated successfully' };
    } catch (error) {
      throw error;
    }
  }

  /**
   * Create team member
   */
  async createTeamMember(organizationId, creatorId, userData, creatorRole = 'agent') {
    try {
      const { email, firstName, lastName, role } = userData;

      // SECURITY: never trust the requested role blindly — that let a tenant
      // admin/manager mint a `super_admin` (full platform takeover). Only an
      // `admin` may create tenant roles up to `admin`; a `manager` is capped at
      // `agent`/`viewer`. Platform roles (`super_admin`) are never grantable here.
      const ROLE_GRANTS = {
        admin: ['admin', 'manager', 'agent', 'viewer'],
        manager: ['agent', 'viewer']
      };
      const grantable = ROLE_GRANTS[creatorRole] || [];
      const requestedRole = role || 'agent';
      if (!grantable.includes(requestedRole)) {
        throw new Error(`You are not permitted to assign the role '${requestedRole}'`);
      }

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

      // Generate a cryptographically strong temporary password
      const tempPassword = crypto.randomBytes(12).toString('base64url');

      // Create user
      const user = await User.create({
        email,
        password: tempPassword,
        firstName,
        lastName,
        role: requestedRole,
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
      const { email, providerId, firstName, lastName, picture, organizationName } =
        this._normalizeGoogleSignupProfile(googleProfile);

      if (!email || !providerId) {
        throw new Error('Google did not return a valid email or account id.');
      }

      let isNewUser = false;

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

        // Orphaned user (no org doc) — create org and attach (e.g. legacy / partial signup)
        if (!user.organization || !user.organization._id) {
          const organization = await Organization.create({
            name: organizationName,
            owner: null,
            subscription: {
              plan: 'free',
              status: 'trial',
              startDate: new Date()
            }
          });
          user.organization = organization._id;
          organization.owner = user._id;
          organization.usage.currentUsers = 1;
          await organization.save();
        }

        // User exists - update OAuth info and login
        user.oauth = {
          provider: 'google',
          providerId,
          profile: googleProfile
        };
        user.lastLogin = new Date();

        if ((!user.firstName || !String(user.firstName).trim()) && firstName) {
          user.firstName = firstName;
        }
        if ((!user.lastName || !String(user.lastName).trim()) && lastName) {
          user.lastName = lastName;
        }

        if (!user.avatar && picture) {
          user.avatar = picture;
        }

        await user.save();
        user = await User.findById(user._id).populate('organization');
      } else {
        isNewUser = true;
        // Create new user and organization (same pattern as email register)
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
          lastLogin: new Date(),
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

        try {
          await emailService.sendWelcomeEmail(user);
        } catch (welcomeErr) {
          console.warn('[auth] Welcome email (Google signup) failed:', welcomeErr.message);
        }
      }

      // Generate tokens
      const token = generateToken(user._id);
      const refreshToken = generateRefreshToken(user._id);

      return {
        user: user.toJSON(),
        token,
        refreshToken,
        isNewUser
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

  async _resolveEffectiveGroup(user) {
    if (user?.group) return user.group;
    const roleToSlug = {
      super_admin: 'super-admin',
      admin: 'admin',
      manager: 'manager',
      agent: 'agent',
      viewer: 'viewer'
    };
    const fallbackSlug = roleToSlug[user?.role];
    if (!fallbackSlug) return null;
    return Group.findOne({ slug: fallbackSlug, isActive: true })
      .populate('permissions', 'code name category actions')
      .lean();
  }

  _extractPermissionCodes(user, effectiveGroup = null) {
    const sourceGroup = user.group || effectiveGroup;
    if (sourceGroup && sourceGroup.permissions && sourceGroup.permissions.length > 0) {
      return sourceGroup.permissions.map(p => typeof p === 'object' ? p.code : p).filter(Boolean);
    }
    if (Array.isArray(user.permissions) && user.permissions.length > 0) {
      return user.permissions.filter(Boolean);
    }
    return [];
  }

  /**
   * Generate & store a 6-digit OTP, then email it.
   * Rate-limited to 1 request per 60 seconds per email.
   */
  async sendLoginOtp(email) {
    const user = await User.findOne({ email: email.toLowerCase().trim() });

    // Always respond with success to avoid user enumeration attacks.
    // If no account exists we send nothing but don't error.
    if (!user || !user.isActive || user.deletedAt) return;

    // Rate limit: block if existing OTP was sent less than 60 seconds ago
    const now = new Date();
    if (
      user.loginOtpExpires &&
      user.loginOtpExpires > new Date(now.getTime() - 9 * 60 * 1000) // within last 9 min
    ) {
      // OTP already sent and still fresh — resend is allowed after 60 s
      const sentAgo = now - (user.loginOtpExpires - 10 * 60 * 1000);
      if (sentAgo < 60 * 1000) {
        throw new Error('Please wait a moment before requesting another code.');
      }
    }

    // Generate cryptographically random 6-digit OTP
    const otp = String(crypto.randomInt(100000, 999999));

    // Hash before storing (plain text is only in the email)
    const hashedOtp = crypto.createHash('sha256').update(otp).digest('hex');

    user.loginOtpCode = hashedOtp;
    user.loginOtpExpires = new Date(now.getTime() + 10 * 60 * 1000); // 10 minutes
    await user.save({ validateBeforeSave: false });

    await emailService.sendLoginOtpEmail(email, otp, user.firstName);
  }

  /**
   * Verify OTP and return auth tokens.
   */
  async verifyLoginOtp(email, otp) {
    const user = await User.findOne({ email: email.toLowerCase().trim() })
      .select('+loginOtpCode +loginOtpExpires')
      .populate('organization');

    if (!user || !user.isActive || user.deletedAt) {
      throw new Error('Invalid or expired code.');
    }

    if (!user.loginOtpCode || !user.loginOtpExpires) {
      throw new Error('No active code found. Please request a new one.');
    }

    if (user.loginOtpExpires < new Date()) {
      throw new Error('This code has expired. Please request a new one.');
    }

    const hashedInput = crypto.createHash('sha256').update(String(otp)).digest('hex');
    if (hashedInput !== user.loginOtpCode) {
      throw new Error('Incorrect code. Please try again.');
    }

    // Consume the OTP
    user.loginOtpCode = undefined;
    user.loginOtpExpires = undefined;
    user.isEmailVerified = true;
    user.lastLogin = new Date();
    await user.save({ validateBeforeSave: false });

    const token = generateToken(user._id);
    const refreshToken = generateRefreshToken(user._id);

    return { token, refreshToken, user };
  }
}

module.exports = new AuthService();

