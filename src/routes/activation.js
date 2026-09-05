const express = require('express');
const router = express.Router();
const { protect, authorize, requirePermission } = require('../middlewares/auth');
const { campaignAiGenerateLimiter } = require('../middlewares/contactRateLimit');
const ctrl = require('../controllers/contactActivationController');

router.use(protect);
router.use(authorize('admin', 'manager'));

router.post('/audiences', requirePermission('campaigns.create'), ctrl.createAudience);
router.get('/audiences/:id', requirePermission('campaigns.manage'), ctrl.getAudience);
router.get('/audiences/:id/members', requirePermission('campaigns.manage'), ctrl.previewAudience);
router.post('/audiences/:id/materialize', requirePermission('campaigns.manage'), ctrl.materializeAudience);

router.get('/campaigns', requirePermission('campaigns.manage'), ctrl.listCampaigns);
router.post('/campaigns', requirePermission('campaigns.create'), ctrl.createCampaign);
router.post('/campaigns/ai-generate', requirePermission('campaigns.create'), campaignAiGenerateLimiter, ctrl.generateContent);
router.get('/campaigns/:id', requirePermission('campaigns.manage'), ctrl.getCampaign);
router.put('/campaigns/:id', requirePermission('campaigns.manage'), ctrl.updateCampaign);
router.post('/campaigns/:id/validate', requirePermission('campaigns.manage'), ctrl.validate);
router.get('/campaigns/:id/preview', requirePermission('campaigns.manage'), ctrl.preview);
router.post('/campaigns/:id/launch', requirePermission('campaigns.send'), ctrl.launch);
router.post('/campaigns/:id/pause', requirePermission('campaigns.manage'), ctrl.pause);
router.post('/campaigns/:id/resume', requirePermission('campaigns.send'), ctrl.resume);
router.get('/campaigns/:id/stats', requirePermission('campaigns.manage'), ctrl.stats);
router.post('/campaigns/:id/follow-up', requirePermission('campaigns.create'), ctrl.followUp);
router.post('/campaigns/:id/analyze', requirePermission('campaigns.manage'), ctrl.analyze);
router.post('/campaigns/:id/tick', requirePermission('campaigns.send'), ctrl.tickSocial);

module.exports = router;
