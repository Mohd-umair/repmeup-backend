const express = require('express');
const router = express.Router();
const dataDeleteController = require('../controllers/dataDeleteController');
const { protect } = require('../middlewares/auth');

/**
 * Data Deletion Routes
 * Handles Facebook/Instagram data deletion callbacks
 * Reference: https://developers.facebook.com/docs/development/create-an-app/app-dashboard/data-deletion-callback
 */

// Facebook data deletion callback (public endpoint)
router.post('/facebook', dataDeleteController.handleFacebookDataDeletion);

// Instagram data deletion callback (public endpoint)
router.post('/instagram', dataDeleteController.handleInstagramDataDeletion);

// Check deletion status (public endpoint with confirmation code)
router.get('/status', dataDeleteController.checkDeletionStatus);

// Manual deletion endpoint (protected - admin only)
router.post('/manual', protect, dataDeleteController.manualDataDeletion);

module.exports = router;

