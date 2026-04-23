const jwt = require('jsonwebtoken');
const User = require('../models/User');
const cacheService = require('../services/cacheService');

// User cache TTL: 5 minutes. Short enough that deactivation takes effect quickly.
const USER_CACHE_TTL = 300;

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

// Generate refresh token
exports.generateRefreshToken = (userId) => {
  return jwt.sign(
    { id: userId },
    process.env.JWT_REFRESH_SECRET || process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_REFRESH_EXPIRE || '30d' }
  );
};

