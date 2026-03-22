const userActivityLogService = require('../services/userActivityLogService');

/**
 * Logs authenticated API responses (after `protect` sets req.user).
 * Mounted early on `/api` so `res.on('finish')` runs after downstream handlers.
 */
function userActivityLogger(req, res, next) {
  res.on('finish', () => {
    try {
      if (!req.user) return;
      const rawPath = req.originalUrl || req.url || '';
      const path = rawPath.split('?')[0];
      if (userActivityLogService.shouldSkipApiLog(path, req.method)) return;
      // Skip failed auth handoffs (no user would exist anyway)
      if (res.statusCode === 404) return;
      userActivityLogService.recordApiRequest(req, res);
    } catch (e) {
      /* never throw from logger */
    }
  });
  next();
}

module.exports = userActivityLogger;
