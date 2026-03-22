const UserActivityLog = require('../models/UserActivityLog');

const MAX_UA = 500;

function truncate(str, max) {
  if (!str || typeof str !== 'string') return '';
  return str.length > max ? str.slice(0, max) : str;
}

function clientIp(req) {
  const xf = req.headers['x-forwarded-for'];
  if (typeof xf === 'string' && xf.trim()) {
    return xf.split(',')[0].trim().slice(0, 64);
  }
  return (req.ip || req.socket?.remoteAddress || '').toString().slice(0, 64);
}

/**
 * Fire-and-forget insert (does not block request lifecycle).
 * @param {Record<string, unknown>} doc
 */
function recordAsync(doc) {
  setImmediate(() => {
    UserActivityLog.create(doc).catch((err) => {
      console.warn('[UserActivityLog] insert failed:', err.message);
    });
  });
}

/**
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
function recordApiRequest(req, res) {
  if (!req.user) return;

  const org = req.user.organization;
  const organizationId =
    org && typeof org === 'object' && org._id ? org._id : org;

  const rawPath = req.originalUrl || req.url || '';
  const path = rawPath.split('?')[0].slice(0, 1024);

  recordAsync({
    user: req.user._id,
    organization: organizationId || undefined,
    category: 'api',
    action: 'api_request',
    path,
    method: (req.method || '').toUpperCase().slice(0, 16),
    statusCode: res.statusCode,
    ip: clientIp(req),
    userAgent: truncate(req.headers['user-agent'], MAX_UA)
  });
}

/**
 * Auth / explicit events (no req.user on password login).
 */
function recordAuthEvent({ userId, organizationId, action, path, method, statusCode, ip, userAgent, metadata }) {
  if (!userId) return;
  recordAsync({
    user: userId,
    organization: organizationId || undefined,
    category: 'auth',
    action: action || 'auth',
    path: path ? String(path).slice(0, 1024) : undefined,
    method: method ? String(method).slice(0, 16) : undefined,
    statusCode,
    ip: truncate(ip, 64),
    userAgent: truncate(userAgent, MAX_UA),
    metadata: metadata && typeof metadata === 'object' ? metadata : undefined
  });
}

/**
 * SPA navigation beacon (POST /users/me/activity).
 */
function recordNavigation(req, route, extra = {}) {
  if (!req.user) return;
  const org = req.user.organization;
  const organizationId =
    org && typeof org === 'object' && org._id ? org._id : org;

  recordAsync({
    user: req.user._id,
    organization: organizationId || undefined,
    category: 'navigation',
    action: 'page_view',
    path: String(route).slice(0, 1024),
    method: 'CLIENT',
    statusCode: 200,
    ip: clientIp(req),
    userAgent: truncate(req.headers['user-agent'], MAX_UA),
    metadata: Object.keys(extra).length ? extra : undefined
  });
}

function shouldSkipApiLog(path, method) {
  if (method === 'OPTIONS') return true;
  if (!path.startsWith('/api')) return true;

  const skips = [
    '/api/auth/login',
    '/api/auth/register',
    '/api/auth/google/callback',
    '/api/users/me/activity'
  ];
  if (skips.some((p) => path === p || path.startsWith(`${p}/`))) return true;

  // High-volume media proxies (same as rate limiter)
  if (path.includes('/inbox/avatar/') || path.includes('/inbox/attachment')) return true;
  if (path.includes('/api/posts/media/')) return true;

  return false;
}

module.exports = {
  recordApiRequest,
  recordAuthEvent,
  recordNavigation,
  shouldSkipApiLog,
  clientIp
};
