const express = require('express');
const router = express.Router();
const { protect, authorize } = require('../middlewares/auth');
const whatsappFormFlowController = require('../controllers/whatsappFormFlowController');
const { requireFeature } = require('../middlewares/requireFeature');
const { FEATURE_KEYS } = require('../config/featureCatalog');

/**
 * WhatsApp Form Flow Routes
 * @route /api/whatsapp-form-flows
 *
 * Distinct from /api/whatsapp-flows (legacy journey builder).
 * These are Meta's interactive "Forms" (Flows), not the old drip sequences.
 */

router.use(protect);

router.get('/templates', whatsappFormFlowController.getTemplates);

router.get('/', whatsappFormFlowController.listFlows);

router.post(
  '/',
  requireFeature(FEATURE_KEYS.WHATSAPP_FLOWS_ENABLED),
  whatsappFormFlowController.createFlow
);

router.get('/:id', whatsappFormFlowController.getFlow);

router.put(
  '/:id',
  requireFeature(FEATURE_KEYS.WHATSAPP_FLOWS_ENABLED),
  whatsappFormFlowController.updateFlow
);

router.delete(
  '/:id',
  requireFeature(FEATURE_KEYS.WHATSAPP_FLOWS_ENABLED),
  whatsappFormFlowController.deleteFlow
);

router.post(
  '/:id/publish',
  requireFeature(FEATURE_KEYS.WHATSAPP_FLOWS_ENABLED),
  whatsappFormFlowController.publishFlow
);

router.post(
  '/:id/deprecate',
  requireFeature(FEATURE_KEYS.WHATSAPP_FLOWS_ENABLED),
  whatsappFormFlowController.deprecateFlow
);

module.exports = router;
