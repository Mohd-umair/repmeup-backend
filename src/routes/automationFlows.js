/**
 * Unified automation flow builder routes.
 * Mount: /api/automation/flows
 */
const express = require('express');
const router = express.Router();
const { protect } = require('../middlewares/auth');
const { validateAutomationFlow } = require('../middlewares/validation');
const automationFlowController = require('../controllers/automationFlowController');

router.use(protect);

router.get('/node-catalog', automationFlowController.getNodeCatalog);
router.get('/', automationFlowController.listFlows);
router.post('/', validateAutomationFlow, automationFlowController.createFlow);
router.get('/:id/stats', automationFlowController.getFlowStats);
router.post('/:id/validate', automationFlowController.validateFlow);
router.post('/:id/test', automationFlowController.testFlow);
router.post('/:id/publish', automationFlowController.publishFlow);
router.post('/:id/pause', automationFlowController.pauseFlow);
router.post('/:id/duplicate', automationFlowController.duplicateFlow);
router.get('/:id', automationFlowController.getFlow);
router.put('/:id', validateAutomationFlow, automationFlowController.updateFlow);
router.delete('/:id', automationFlowController.deleteFlow);

module.exports = router;
