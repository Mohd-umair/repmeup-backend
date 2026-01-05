const express = require('express');
const router = express.Router();
const platformController = require('../controllers/platformController');
const { protect, authorize } = require('../middlewares/auth');

// All routes require authentication
router.use(protect);

// Google OAuth flow
router.get('/google/connect', platformController.initiateGoogleConnection);
router.get('/google/callback', platformController.handleGoogleCallback);

// Platform management
router.get('/', platformController.getPlatformConnections);
router.get('/:id', platformController.getPlatformConnection);
router.delete('/:id', platformController.disconnectPlatform);
router.post('/:id/sync', platformController.syncPlatform);

module.exports = router;

