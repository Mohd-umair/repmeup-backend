const express = require('express');
const router = express.Router();
const webhookController = require('../controllers/webhookController');

// Webhook routes are public (called by external services)
// But we verify signatures/tokens

// Google Business Profile webhooks
router.get('/google', webhookController.verifyGoogleWebhook);
router.post('/google', webhookController.handleGoogleWebhook);

// YouTube webhooks
router.get('/youtube', webhookController.verifyYouTubeWebhook);
router.post('/youtube', webhookController.handleYouTubeWebhook);

// Facebook webhooks
router.get('/facebook', webhookController.verifyFacebookWebhook);
router.post('/facebook', webhookController.handleFacebookWebhook);

// Instagram webhooks
router.get('/instagram', webhookController.verifyInstagramWebhook);
router.post('/instagram', webhookController.handleInstagramWebhook);

// Health check
router.get('/health', webhookController.webhookHealth);

module.exports = router;

