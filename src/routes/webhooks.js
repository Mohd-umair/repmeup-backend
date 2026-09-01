const express = require('express');
const router = express.Router();
const webhookController = require('../controllers/webhookController');
const shopifyController = require('../controllers/shopifyController');

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

// Instagram webhooks (Facebook Login — main Repmeup app)
router.get('/instagram', webhookController.verifyInstagramWebhook);
router.post('/instagram', webhookController.handleInstagramWebhook);

// Instagram Login webhooks (Repmeup-IG app — separate Meta app)
router.get('/instagram-login', webhookController.verifyInstagramLoginWebhook);
router.post('/instagram-login', webhookController.handleInstagramLoginWebhook);

// LinkedIn webhooks
router.get('/linkedin', webhookController.verifyLinkedInWebhook);
router.post('/linkedin', webhookController.handleLinkedInWebhook);

// Interakt tech-partner webhook — onboarding lifecycle (WABA_ONBOARDED).
// Partner-level, shared only between us and Interakt. Distinct from the per-number
// message webhook on /whatsapp below, which carries Meta-format messages/statuses.
router.get('/interakt', webhookController.verifyInteraktWebhook);
router.post('/interakt', webhookController.handleInteraktWebhook);

// WhatsApp webhooks
router.get('/whatsapp', webhookController.verifyWhatsAppWebhook);
router.post('/whatsapp', webhookController.handleWhatsAppWebhook);

// Gmail Pub/Sub push notifications
router.post('/gmail', webhookController.handleGmailWebhook);

// Microsoft Graph (Outlook) push notifications
router.post('/outlook', webhookController.handleOutlookWebhook);

// Product payment confirmation (from any payment provider)
router.post('/product-payment', webhookController.handleProductPaymentWebhook);

// Shopify webhooks (real-time product/customer/order events)
router.post('/shopify', shopifyController.handleShopifyWebhook);

// Health check
router.get('/health', webhookController.webhookHealth);

module.exports = router;

