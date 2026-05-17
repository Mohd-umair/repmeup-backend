const express = require('express');
const router = express.Router();
const platformController = require('../controllers/platformController');
const { protect, authorize } = require('../middlewares/auth');
const { checkConnectionLimit, attachConnectionLimits } = require('../middlewares/platformLimitMiddleware');

// Google OAuth callback (public - called by Google)
router.get('/google/callback', platformController.handleGoogleCallback);

// WhatsApp Embedded Signup callback (public — Meta redirects here after OAuth)
router.get('/whatsapp/callback', platformController.handleWhatsAppCallback);

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

// Meta webhook events (public - POST from Meta for Facebook/Instagram events)
router.post('/meta/callback', (req, res, next) => {
  const webhookController = require('../controllers/webhookController');
  const obj = req.body?.object;
  console.log('📩 [Meta Callback] Received POST, object:', obj, JSON.stringify(req.body, null, 2));
  if (obj === 'page') {
    return webhookController.handleFacebookWebhook(req, res);
  }
  if (obj === 'instagram') {
    return webhookController.handleInstagramWebhook(req, res);
  }
  // Unknown object or empty body - still respond 200 so Meta doesn't retry
  res.status(200).send();
});

// All other routes require authentication
router.use(protect);

// Google OAuth flow - check limit before starting OAuth
router.get('/google/connect', checkConnectionLimit, platformController.initiateGoogleConnection);

// WhatsApp Business API
// GET  /whatsapp/connect        → returns Embedded Signup OAuth authUrl (production)
// POST /whatsapp/connect        → direct env-credentials connect (dev / current setup)
// POST /whatsapp/connect-direct → alias for the above
router.get('/whatsapp/connect', checkConnectionLimit, platformController.initiateWhatsAppConnection);
router.post('/whatsapp/connect', checkConnectionLimit, platformController.connectWhatsApp);
router.post('/whatsapp/connect-direct', checkConnectionLimit, platformController.connectWhatsApp);
router.delete('/whatsapp/disconnect', platformController.disconnectWhatsApp);
router.get('/whatsapp/status', platformController.getWhatsAppStatus);
// Manually register a Pending phone number for Cloud API (moves status → Active)
router.post('/whatsapp/register-phone', platformController.registerWhatsAppPhone);

// Platform management
router.get('/', attachConnectionLimits, platformController.getPlatformConnections);
router.get('/connections', attachConnectionLimits, platformController.getPlatformConnections); // Alias for frontend
router.post('/refresh-profile-pictures', platformController.refreshProfilePictures);
router.get('/:id', platformController.getPlatformConnection);
router.delete('/:id', platformController.disconnectPlatform);
router.post('/:id/sync', platformController.syncPlatform);
router.post('/:id/refresh-locations', platformController.refreshGoogleLocations);

module.exports = router;

