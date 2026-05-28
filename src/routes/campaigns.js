/**
 * WhatsApp Campaign Routes
 * Mount: /api/v1/campaigns  (and legacy /api/campaigns)
 */
const express = require('express');
const router = express.Router();
const { protect } = require('../middlewares/auth');
const { requireFeature } = require('../middlewares/requireFeature');
const { FEATURE_KEYS } = require('../config/featureCatalog');
const ctrl = require('../controllers/campaignController');

router.use(protect);
router.use(requireFeature(FEATURE_KEYS.CAMPAIGNS_ENABLED));

// Campaign CRUD
router.get('/',    ctrl.listCampaigns);
router.post('/',   ctrl.createCampaign);
router.get('/:id', ctrl.getCampaign);
router.put('/:id', ctrl.updateCampaign);
router.delete('/:id', ctrl.deleteCampaign);

// Template introspection (drives the dynamic-param editor UI)
router.get('/:id/template-slots', ctrl.getTemplateSlots);
router.get('/:id/audience-defaults', ctrl.getAudienceDefaults);

// Recipients
router.get('/:id/recipients/report', ctrl.getRecipientsReport);
router.post('/:id/recipients/csv/preview', ctrl.previewRecipientCsv);
router.post('/:id/recipients',   ctrl.addRecipients);
router.delete('/:id/recipients', ctrl.clearRecipients);
router.get('/:id/recipients',    ctrl.getRecipients);

// Lifecycle
router.post('/:id/launch', requireFeature(FEATURE_KEYS.WHATSAPP_BROADCAST_ENABLED), ctrl.launchCampaign);
router.post('/:id/pause',  ctrl.pauseCampaign);
router.post('/:id/resume', ctrl.resumeCampaign);
router.post('/:id/cancel', ctrl.cancelCampaign);

// Stats & test
router.get('/:id/stats',  ctrl.getCampaignStats);
router.post('/:id/test',  ctrl.sendTestMessage);

module.exports = router;
