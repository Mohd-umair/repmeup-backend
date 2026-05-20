/**
 * WhatsApp Campaign Routes
 * Mount: /api/v1/campaigns  (and legacy /api/campaigns)
 */
const express = require('express');
const router = express.Router();
const { protect } = require('../middlewares/auth');
const ctrl = require('../controllers/campaignController');

// Campaign CRUD
router.get('/',    protect, ctrl.listCampaigns);
router.post('/',   protect, ctrl.createCampaign);
router.get('/:id', protect, ctrl.getCampaign);
router.put('/:id', protect, ctrl.updateCampaign);
router.delete('/:id', protect, ctrl.deleteCampaign);

// Recipients
router.post('/:id/recipients',   protect, ctrl.addRecipients);
router.delete('/:id/recipients', protect, ctrl.clearRecipients);
router.get('/:id/recipients',    protect, ctrl.getRecipients);

// Lifecycle
router.post('/:id/launch', protect, ctrl.launchCampaign);
router.post('/:id/pause',  protect, ctrl.pauseCampaign);
router.post('/:id/resume', protect, ctrl.resumeCampaign);
router.post('/:id/cancel', protect, ctrl.cancelCampaign);

// Stats & test
router.get('/:id/stats',  protect, ctrl.getCampaignStats);
router.post('/:id/test',  protect, ctrl.sendTestMessage);

module.exports = router;
