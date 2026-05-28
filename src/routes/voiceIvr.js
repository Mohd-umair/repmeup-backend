'use strict';

const express = require('express');
const router = express.Router();
const { protect } = require('../middlewares/auth');
const { requireFeature } = require('../middlewares/requireFeature');
const { FEATURE_KEYS } = require('../config/featureCatalog');
const controller = require('../controllers/voiceIvrController');

// ─── Public Twilio webhooks (no auth; signature validated in controller) ────
router.post('/webhooks/incoming', express.urlencoded({ extended: false }), controller.incomingCallWebhook);
router.post('/webhooks/status', express.urlencoded({ extended: false }), controller.callStatusWebhook);
router.post('/webhooks/recording', express.urlencoded({ extended: false }), controller.recordingWebhook);

// ─── Protected routes ───────────────────────────────────────────────────────
router.use(protect);
router.use(requireFeature(FEATURE_KEYS.VOICE_IVR_ENABLED));

// Credentials
router.get('/credentials', controller.getCredentials);
router.put('/credentials', controller.updateCredentials);
router.delete('/credentials', controller.deleteCredentials);

// Phone numbers
router.get('/phone-numbers', controller.listPhoneNumbers);
router.post('/phone-numbers/search', controller.searchAvailableNumbers);
router.post('/phone-numbers/register-existing', controller.registerExistingPhoneNumber);
router.post('/phone-numbers/purchase', controller.purchasePhoneNumber);
router.put('/phone-numbers/:id', controller.updatePhoneNumber);
router.delete('/phone-numbers/:id', controller.releasePhoneNumber);

// Agents
router.get('/agents/templates', controller.getAgentTemplates);
router.get('/agents', controller.listAgents);
router.post('/agents', controller.createAgent);
router.get('/agents/:id', controller.getAgent);
router.put('/agents/:id', controller.updateAgent);
router.delete('/agents/:id', controller.deleteAgent);

// Calls
router.get('/calls', controller.listCalls);
router.post('/calls/outbound', controller.createOutboundCall);
router.get('/calls/:id', controller.getCall);

// Analytics
router.get('/analytics/summary', controller.analyticsSummary);
router.get('/analytics/trends', controller.analyticsTrends);

module.exports = router;
