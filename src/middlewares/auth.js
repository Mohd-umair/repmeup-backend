const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const User = require('../models/User');
const cacheService = require('../services/cacheService');

// User cache TTL: 5 minutes. Short enough that deactivation takes effect quickly.
const USER_CACHE_TTL = 300;

/**
 * Restore ObjectId fields that were flattened to strings by JSON serialisation
 * when the user object was stored in Redis.  Mongoose aggregation pipelines do
 * NOT schema-cast, so a string `_id` in a `$match` stage silently matches
 * nothing.  Restoring the types here means all downstream code (controllers,
 * services) receives proper ObjectId values regardless of whether the user
 * came from a DB query or a cache hit.
 */
function rehydrateUserIds(user) {
  if (!user) return user;
  if (user._id && !(user._id instanceof mongoose.Types.ObjectId)) {
    user._id = new mongoose.Types.ObjectId(String(user._id));
  }
  if (user.organization) {
    if (typeof user.organization === 'string') {
      user.organization = new mongoose.Types.ObjectId(user.organization);
    } else if (user.organization._id && !(user.organization._id instanceof mongoose.Types.ObjectId)) {
      user.organization._id = new mongoose.Types.ObjectId(String(user.organization._id));
    }
  }
  return user;
}

/**
 * Endpoints a LOCKED demo workspace may still call — everything needed to render
 * the "trial ended" screen and complete a purchase. Matched against req.originalUrl
 * (the full path, e.g. /api/subscription/limits or /api/v1/razorpay/...), so it is
 * robust to the dual /api + /api/v1 mounting and to nested routers.
 */
const DEMO_UNLOCKED_PATH_PATTERNS = [
  '/subscription',   // view plan/limits, upgrade
  '/plans',          // list purchasable plans
  '/razorpay',       // create + verify payment
  '/entitlements',   // resolve current entitlements
  '/auth/me',        // who am I (renders the shell)
  '/auth/logout',    // sign out
  '/auth/demo-login' // re-entry attempt
];

function isDemoUnlockedPath(originalUrl) {
  const url = String(originalUrl || '').split('?')[0];
  return DEMO_UNLOCKED_PATH_PATTERNS.some((p) => url.includes(p));
}
exports.isDemoUnlockedPath = isDemoUnlockedPath;

// Protect routes - verify JWT token
exports.protect = async (req, res, next) => {
  try {
    let token;

    // Get token from header
    if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
      token = req.headers.authorization.split(' ')[1];
    }

    // Check if token exists
    if (!token) {
      return res.status(401).json({
        success: false,
        error: 'Not authorized to access this route. No token provided.'
      });
    }

    try {
      // Verify token signature and expiry
      const decoded = jwt.verify(token, process.env.JWT_SECRET);

      // Reject tokens that have been explicitly revoked (logout / forced sign-out)
      if (await cacheService.isTokenBlacklisted(token)) {
        return res.status(401).json({
          success: false,
          error: 'Token has been revoked. Please log in again.'
        });
      }

      // Try cache first — avoids a DB round-trip on every authenticated request.
      // On cache miss, falls through to MongoDB and repopulates the cache.
      const cacheKey = cacheService.userKey(decoded.id);
      let user = await cacheService.get(cacheKey);

      if (!user) {
        user = await User.findById(decoded.id)
          .select('-password')
          .lean()
          .populate('organization');

        if (user) {
          await cacheService.set(cacheKey, user, USER_CACHE_TTL);
        }
      }

      // Restore ObjectId types lost during JSON serialisation (Redis cache hit).
      rehydrateUserIds(user);

      if (!user) {
        return res.status(401).json({
          success: false,
          error: 'User no longer exists'
        });
      }

      if (user.deletedAt) {
        return res.status(401).json({
          success: false,
          error: 'User account has been removed'
        });
      }

      if (!user.isActive) {
        return res.status(401).json({
          success: false,
          error: 'User account is deactivated'
        });
      }

      // Demo trial lock: when a demo workspace's trial has expired it is locked
      // (data retained). We block normal API access with UPGRADE_REQUIRED but
      // still allow the endpoints needed to render the lock screen and purchase
      // a plan (subscription/billing, plans, auth/me, logout). The check is cheap:
      // it reads the denormalized flag on the already-populated organization.
      if (user.organization && user.organization.demo && user.organization.demo.lockedAt) {
        if (!isDemoUnlockedPath(req.originalUrl)) {
          return res.status(403).json({
            success: false,
            code: 'UPGRADE_REQUIRED',
            error: 'Your demo trial has ended. Purchase a plan to continue — all your data is safe.'
          });
        }
      }

      // Attach user to request
      req.user = user;
      next();
    } catch (error) {
      return res.status(401).json({
        success: false,
        error: 'Invalid or expired token'
      });
    }
  } catch (error) {
    next(error);
  }
};

// Role-based access control
exports.authorize = (...roles) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        error: 'Not authorized to access this route'
      });
    }

    if (!roles.includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        error: `User role '${req.user.role}' is not authorized to access this route`
      });
    }

    next();
  };
};

// Check if user belongs to the organization
exports.checkOrganization = (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({
      success: false,
      error: 'Not authorized'
    });
  }

  // Organization check - can be overridden by admin
  if (req.user.role !== 'admin') {
    const orgId = req.params.organizationId || req.body.organization;
    
    if (orgId && orgId.toString() !== req.user.organization._id.toString()) {
      return res.status(403).json({
        success: false,
        error: 'You do not have access to this organization'
      });
    }
  }

  next();
};

// Generate JWT token
exports.generateToken = (userId) => {
  return jwt.sign({ id: userId }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRE || '7d'
  });
};

/**
 * Short-lived token for super-admin "login as user" in the main app.
 * @param {import('mongoose').Types.ObjectId|string} userId Target user
 * @param {import('mongoose').Types.ObjectId|string} impersonatedBy Super-admin operator
 */
exports.generateImpersonationToken = (userId, impersonatedBy) => {
  return jwt.sign(
    { id: userId, impersonatedBy: String(impersonatedBy), impersonation: true },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_IMPERSONATION_EXPIRE || '2h' }
  );
};

// Generate refresh token
exports.generateRefreshToken = (userId) => {
  return jwt.sign(
    { id: userId },
    process.env.JWT_REFRESH_SECRET || process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_REFRESH_EXPIRE || '30d' }
  );
};

