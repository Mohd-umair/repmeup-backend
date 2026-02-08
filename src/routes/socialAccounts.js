const express = require('express');
const router = express.Router();
const socialAccountsController = require('../controllers/socialAccountsController');
const { protect } = require('../middlewares/auth');

// All routes require authentication
router.use(protect);

// Get available accounts
router.get('/available', socialAccountsController.getAvailableAccounts);

// Get all accounts grouped by status
router.get('/', socialAccountsController.getAccountsGrouped);

// Connect an available account
router.post('/:id/connect', socialAccountsController.connectAccount);

// Disconnect a connected account
router.post('/:id/disconnect', socialAccountsController.disconnectAccount);

// Reconnect a disconnected account
router.post('/:id/reconnect', socialAccountsController.reconnectAccount);

module.exports = router;
