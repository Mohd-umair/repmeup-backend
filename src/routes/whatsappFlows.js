/**
 * WhatsApp Flows Routes
 * Mount: /api/v1/whatsapp-flows  (and legacy /api/whatsapp-flows)
 */
const express = require('express');
const router = express.Router();
const { protect } = require('../middlewares/auth');
const { requireFeature } = require('../middlewares/requireFeature');
const { FEATURE_KEYS } = require('../config/featureCatalog');
const whatsappFlowController = require('../controllers/whatsappFlowController');

// Authoring is gated; reading and pausing are not — see automationFlows.js for why.
const requireFlowBuilder = requireFeature(FEATURE_KEYS.FLOW_BUILDER_ENABLED);

router.get('/', protect, whatsappFlowController.listFlows);
router.post('/', protect, requireFlowBuilder, whatsappFlowController.createFlow);
router.get('/:id', protect, whatsappFlowController.getFlow);
router.put('/:id', protect, requireFlowBuilder, whatsappFlowController.updateFlow);
router.delete('/:id', protect, whatsappFlowController.deleteFlow);
router.post('/:id/activate', protect, requireFlowBuilder, whatsappFlowController.activateFlow);
router.post('/:id/pause', protect, whatsappFlowController.pauseFlow);

module.exports = router;
