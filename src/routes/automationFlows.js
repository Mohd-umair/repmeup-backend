/**
 * Unified automation flow builder routes.
 * Mount: /api/automation/flows
 */
const express = require('express');
const router = express.Router();
const { protect } = require('../middlewares/auth');
const { validateAutomationFlow } = require('../middlewares/validation');
const { requireFeature } = require('../middlewares/requireFeature');
const { FEATURE_KEYS } = require('../config/featureCatalog');
const automationFlowController = require('../controllers/automationFlowController');

router.use(protect);

/**
 * Flow Builder is a paid capability (bundled on Pro, a ₹1,999 add-on below it).
 *
 * The gate goes on AUTHORING only — create, edit, publish, duplicate. Listing, viewing,
 * stats and enrolments stay open so an org that downgrades (or lets the add-on lapse)
 * can still see and pause what it already built. Taking away the view would be taking
 * away their data.
 *
 * `/:id/pause` is deliberately ungated for the same reason: stopping a flow must never
 * require an active entitlement.
 */
const requireFlowBuilder = requireFeature(FEATURE_KEYS.FLOW_BUILDER_ENABLED);

router.get('/node-catalog', automationFlowController.getNodeCatalog);
router.post('/check-keyword-overlap', automationFlowController.checkKeywordOverlap);
router.get('/', automationFlowController.listFlows);
router.post('/', requireFlowBuilder, validateAutomationFlow, automationFlowController.createFlow);
router.get('/:id/stats', automationFlowController.getFlowStats);
router.get('/:id/enrollments', automationFlowController.listEnrollments);
router.get('/:id/enrollments/:eid', automationFlowController.getEnrollment);
router.post('/:id/validate', automationFlowController.validateFlow);
router.post('/:id/test', requireFlowBuilder, automationFlowController.testFlow);
router.post('/:id/publish', requireFlowBuilder, automationFlowController.publishFlow);
router.post('/:id/pause', automationFlowController.pauseFlow);
router.post('/:id/duplicate', requireFlowBuilder, automationFlowController.duplicateFlow);
router.get('/:id', automationFlowController.getFlow);
router.put('/:id', requireFlowBuilder, validateAutomationFlow, automationFlowController.updateFlow);
router.delete('/:id', automationFlowController.deleteFlow);

module.exports = router;
