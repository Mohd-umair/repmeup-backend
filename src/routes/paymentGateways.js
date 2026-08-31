'use strict';

/**
 * Payment Gateway Management Routes
 *
 * Manages organization-owned payment gateway integrations (connect, configure, disconnect).
 *
 * All routes require authentication. Connect/disconnect requires org-admin.
 * Returns only safe fields — never credentials or tokens.
 *
 * Routes:
 *   GET    /api/payment-gateways              → list available providers + org connections
 *   GET    /api/payment-gateways/:id          → get single integration (safe fields)
 *   POST   /api/payment-gateways              → connect a new gateway
 *   PATCH  /api/payment-gateways/:id          → update credentials / settings
 *   POST   /api/payment-gateways/:id/default  → set as default
 *   POST   /api/payment-gateways/:id/health   → trigger health check
 *   DELETE /api/payment-gateways/:id          → disconnect
 */

const express = require('express');
const router = express.Router();
const { protect } = require('../middlewares/auth');
const paymentGatewayController = require('../controllers/paymentGatewayController');

router.use(protect);

router.get('/', paymentGatewayController.listGateways);
router.get('/:id', paymentGatewayController.getGateway);
router.post('/', paymentGatewayController.connectGateway);
router.patch('/:id', paymentGatewayController.updateGateway);
router.post('/:id/default', paymentGatewayController.setDefault);
router.post('/:id/health', paymentGatewayController.healthCheck);
router.delete('/:id', paymentGatewayController.disconnectGateway);

module.exports = router;
