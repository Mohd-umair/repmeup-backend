const express = require('express');
const router = express.Router();
const platformController = require('../controllers/platformController');
const { protect, authorize } = require('../middlewares/auth');

// Google OAuth callback (public - called by Google)
router.get('/google/callback', platformController.handleGoogleCallback);

// All other routes require authentication
router.use(protect);

// Google OAuth flow
router.get('/google/connect', platformController.initiateGoogleConnection);

// Platform management
router.get('/', platformController.getPlatformConnections);
router.get('/:id', platformController.getPlatformConnection);
router.delete('/:id', platformController.disconnectPlatform);
router.post('/:id/sync', platformController.syncPlatform);

module.exports = router;

