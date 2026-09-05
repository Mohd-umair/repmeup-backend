const demoWorkspaceService = require('../services/demoWorkspaceService');
const logger = require('../config/logger');

/**
 * Bull job processor: lock demo workspaces whose trial has expired.
 * Runs on a daily repeat (registered in worker.js). Idempotent — re-running is
 * safe; only `trialing` demos past `trialEndsAt` are locked.
 */
async function processDemoExpiry() {
  const result = await demoWorkspaceService.lockExpiredDemos(new Date());
  if (result.locked > 0) {
    logger.info('[DemoExpiry] locked expired demo workspaces', { count: result.locked });
  } else {
    logger.debug('[DemoExpiry] no demos to lock');
  }
  return result;
}

module.exports = processDemoExpiry;
