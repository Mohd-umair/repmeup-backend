const express = require('express');
const router = express.Router();
const razorpayController = require('../controllers/razorpayController');
const { protect } = require('../middlewares/auth');

/**
 * Webhook MUST use express.raw() before any JSON parser — raw body is required for HMAC verification.
 * Razorpay calls this directly so no auth middleware is applied.
 */
router.post(
  '/webhook',
  express.raw({ type: 'application/json' }),
  razorpayController.handleWebhook
);

/**
 * All other routes:
 *  - express.json() applied here because this router is registered in app.js BEFORE the global
 *    express.json() middleware (necessary so /webhook receives a raw Buffer).
 *  - protect applied after JSON parsing.
 */
router.use(express.json());
router.use(protect);

router.post('/create-subscription', razorpayController.createSubscription);
router.post('/verify', razorpayController.verifyPayment);

module.exports = router;
