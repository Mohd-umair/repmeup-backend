const express = require('express');
const router = express.Router();
const socialAccountsController = require('../controllers/socialAccountsController');
const { protect } = require('../middlewares/auth');
const { requireChannel } = require('../middlewares/requireFeature');
const PlatformConnection = require('../models/PlatformConnection');

// All routes require authentication
router.use(protect);

// Get available accounts
router.get('/available', socialAccountsController.getAvailableAccounts);

// Get all accounts grouped by status
router.get('/', socialAccountsController.getAccountsGrouped);

/**
 * The platform is on the record, not in the request, so the channel is resolved by
 * loading it. An unknown id resolves to null, which skips the gate and lets the
 * controller return its own 404 — the gate should not become a second, vaguer 404.
 */
const resolveConnectionPlatform = async (req) => {
  const connection = await PlatformConnection.findOne({
    _id: req.params.id,
    organization: req.user.organization._id
  }).select('platform').lean();
  return connection?.platform || null;
};

// Connect an available account
router.post('/:id/connect', requireChannel(resolveConnectionPlatform), socialAccountsController.connectAccount);

// Disconnect a connected account
router.post('/:id/disconnect', socialAccountsController.disconnectAccount);

// Reconnect a disconnected account
router.post('/:id/reconnect', socialAccountsController.reconnectAccount);

module.exports = router;
