/**
 * WhatsApp Flows Routes
 * Mount: /api/v1/whatsapp-flows  (and legacy /api/whatsapp-flows)
 */
const express = require('express');
const router = express.Router();
const { protect } = require('../middlewares/auth');
const whatsappFlowController = require('../controllers/whatsappFlowController');

router.get('/', protect, whatsappFlowController.listFlows);
router.post('/', protect, whatsappFlowController.createFlow);
router.get('/:id', protect, whatsappFlowController.getFlow);
router.put('/:id', protect, whatsappFlowController.updateFlow);
router.delete('/:id', protect, whatsappFlowController.deleteFlow);
router.post('/:id/activate', protect, whatsappFlowController.activateFlow);
router.post('/:id/pause', protect, whatsappFlowController.pauseFlow);

module.exports = router;
