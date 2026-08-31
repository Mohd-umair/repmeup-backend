'use strict';

/**
 * Payment Routes
 *
 * Customer-facing payment requests: create, list, get, resend, cancel, refund.
 *
 * All routes derive organizationId from auth context — never accept it from body/params.
 *
 * Routes:
 *   POST   /api/payments                      → create (or reuse) payment request
 *   GET    /api/payments                      → list payments with filters
 *   GET    /api/payments/:id                  → get single payment
 *   POST   /api/payments/:id/resend           → resend payment link on channel
 *   POST   /api/payments/:id/cancel           → cancel active payment
 *   POST   /api/payments/:id/reconcile        → poll provider for current status
 *   POST   /api/payments/:id/refund           → initiate refund
 *   GET    /api/payments/:id/attempts         → list payment attempts
 *   GET    /api/payments/:id/refunds          → list refunds for payment
 *   GET    /api/payments/:id/events           → list webhook events for payment
 */

const express = require('express');
const router = express.Router();
const { protect } = require('../middlewares/auth');
const paymentController = require('../controllers/paymentController');

router.use(protect);

router.post('/', paymentController.createPayment);
router.get('/', paymentController.listPayments);
router.get('/:id', paymentController.getPayment);
router.post('/:id/resend', paymentController.resendPayment);
router.post('/:id/cancel', paymentController.cancelPayment);
router.post('/:id/reconcile', paymentController.reconcilePayment);
router.post('/:id/refund', paymentController.refundPayment);
router.get('/:id/attempts', paymentController.listAttempts);
router.get('/:id/refunds', paymentController.listRefunds);
router.get('/:id/events', paymentController.listEvents);

module.exports = router;
