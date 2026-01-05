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

// Health check
router.get('/health', webhookController.webhookHealth);

module.exports = router;

