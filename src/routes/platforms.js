const express = require('express');
const router = express.Router();
const platformController = require('../controllers/platformController');
const { protect, authorize } = require('../middlewares/auth');
const { checkConnectionLimit, attachConnectionLimits } = require('../middleware/platformLimitMiddleware');

// Google OAuth callback (public - called by Google)
router.get('/google/callback', platformController.handleGoogleCallback);

// All other routes require authentication
router.use(protect);

// Google OAuth flow - check limit before starting OAuth
router.get('/google/connect', checkConnectionLimit, platformController.initiateGoogleConnection);

// WhatsApp Business API
router.post('/whatsapp/connect', platformController.connectWhatsApp);
router.delete('/whatsapp/disconnect', platformController.disconnectWhatsApp);
router.get('/whatsapp/status', platformController.getWhatsAppStatus);

// Platform management
router.get('/', attachConnectionLimits, platformController.getPlatformConnections);
router.get('/connections', attachConnectionLimits, platformController.getPlatformConnections); // Alias for frontend
router.post('/refresh-profile-pictures', platformController.refreshProfilePictures);
router.get('/:id', platformController.getPlatformConnection);
router.delete('/:id', platformController.disconnectPlatform);
router.post('/:id/sync', platformController.syncPlatform);
router.post('/:id/refresh-locations', platformController.refreshGoogleLocations);

router.post('/whatsapp/connect', checkConnectionLimit, platformController.connectWhatsApp);

module.exports = router;

