'use strict';

/**
 * Razorpay Commerce Payment Webhook Router
 *
 * MUST be mounted BEFORE the global express.json() in app.js so the handler
 * receives the raw Buffer body for HMAC-SHA256 signature verification.
 *
 * Route: POST /api/webhooks/payments/razorpay/:endpointToken
 *
 * The opaque endpointToken selects the candidate PaymentIntegration; signature
 * verification establishes authenticity. No tenant information is returned on failure.
 */

const express = require('express');
const router = express.Router();

router.post(
  '/:endpointToken',
  express.raw({ type: ['application/json', 'text/plain', '*/*'] }),
  require('../controllers/paymentWebhookController').handleRazorpayWebhook
);

module.exports = router;
