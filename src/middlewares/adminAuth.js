'use strict';

/**
 * Admin Authentication Middleware
 *
 * Provides a separate authentication layer for the super-admin panel that is
 * cryptographically independent from the tenant JWT layer.
 *
 * Key guarantees:
 *  - Tokens are signed with SUPER_ADMIN_JWT_SECRET (different from JWT_SECRET).
 *  - protectAdmin rejects any token that lacks the `adminSession: true` claim,
 *    meaning tokens issued by the regular login flow are always rejected even if
 *    the signing secret were somehow shared.
 *  - Fails closed: if SUPER_ADMIN_JWT_SECRET is not set, all admin requests are
 *    rejected with 500 rather than falling through to the role-check gate.
 */

const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const User = require('../models/User');
const cacheService = require('../services/cacheService');

const ADMIN_USER_CACHE_TTL = 300; // 5 minutes

/**
 * Restore ObjectId fields after JSON round-trip through Redis.
 * Mirrors the same helper in auth.js to keep admin requests consistent.
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
 * Express middleware that authenticates super-admin requests.
 *
 * Verifies the Bearer token using SUPER_ADMIN_JWT_SECRET and checks that the
 * token carries the `adminSession: true` claim. Rejects tokens issued by the
 * regular tenant login flow (signed with JWT_SECRET) even when a user somehow
 * holds the `super_admin` role via a tenant token.
 */
exports.protectAdmin = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization || '';
    if (!authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, error: 'Not authorized. No token provided.' });
    }

    const token = authHeader.split(' ')[1];
    const secret = process.env.SUPER_ADMIN_JWT_SECRET;

    if (!secret) {
      console.error('[adminAuth] SUPER_ADMIN_JWT_SECRET is not configured — rejecting all admin requests');
      return res.status(500).json({ success: false, error: 'Admin authentication not configured on server' });
    }

    let decoded;
    try {
      decoded = jwt.verify(token, secret);
    } catch {
      return res.status(401).json({ success: false, error: 'Invalid or expired admin token' });
    }

    // Reject tokens that were not minted by the dedicated admin-login endpoint.
    if (!decoded.adminSession) {
      return res.status(401).json({ success: false, error: 'Invalid admin token' });
    }

    // Reject explicitly revoked tokens (logout / forced sign-out).
    if (await cacheService.isTokenBlacklisted(token)) {
      return res.status(401).json({ success: false, error: 'Token has been revoked. Please log in again.' });
    }

    // Prefer the Redis cache to avoid a DB round-trip on every admin request.
    const cacheKey = cacheService.userKey(decoded.id);
    let user = await cacheService.get(cacheKey);

    if (!user) {
      user = await User.findById(decoded.id)
        .select('-password')
        .lean()
        .populate('organization');
      if (user) await cacheService.set(cacheKey, user, ADMIN_USER_CACHE_TTL);
    }

    rehydrateUserIds(user);

    if (!user) {
      return res.status(401).json({ success: false, error: 'User no longer exists' });
    }

    if (user.deletedAt) {
      return res.status(401).json({ success: false, error: 'User account has been removed' });
    }

    if (!user.isActive) {
      return res.status(401).json({ success: false, error: 'User account is deactivated' });
    }

    req.user = user;
    next();
  } catch (err) {
    next(err);
  }
};

/**
 * Generate a short-lived JWT for a super-admin session.
 * Signed with SUPER_ADMIN_JWT_SECRET and carrying `adminSession: true` so that
 * protectAdmin can distinguish these tokens from regular tenant tokens.
 *
 * @param {string|import('mongoose').Types.ObjectId} userId
 * @returns {string} Signed JWT
 */
exports.generateAdminToken = (userId) => {
  const secret = process.env.SUPER_ADMIN_JWT_SECRET;
  if (!secret) throw new Error('SUPER_ADMIN_JWT_SECRET is not configured');
  return jwt.sign(
    { id: String(userId), adminSession: true },
    secret,
    { expiresIn: process.env.SUPER_ADMIN_JWT_EXPIRE || '8h' }
  );
};
