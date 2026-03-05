const express = require('express');
const router = express.Router();
const platformController = require('../controllers/platformController');
const { protect, authorize } = require('../middlewares/auth');
const { checkConnectionLimit, attachConnectionLimits } = require('../middleware/platformLimitMiddleware');

// Google OAuth callback (public - called by Google)
router.get('/google/callback', platformController.handleGoogleCallback);

// Meta webhook verification (public - called by Meta for callback URL validation)
// Must be before router.use(protect)
router.get('/meta/callback', (req, res) => {
  const hubMode = req.query['hub.mode'] || req.query.hub_mode;
  const hubChallenge = req.query['hub.challenge'] || req.query.hub_challenge;
  const hubVerifyToken = req.query['hub.verify_token'] || req.query.hub_verify_token;

  if (hubMode === 'subscribe' && hubChallenge != null) {
    const expectedToken = process.env.META_VERIFY_TOKEN || 'REP_ME_UP';
    if (hubVerifyToken === expectedToken) {
      console.log('✅ [Meta] Webhook verification successful (/api/platforms/meta/callback)');
      res.status(200).send(String(hubChallenge));
      return;
    }
    console.warn('⚠️ [Meta] Webhook verify_token mismatch');
    res.status(403).send('Forbidden');
    return;
  }

  // Plain URL validation (no hub params)
  res.status(200).send('OK');
});

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

