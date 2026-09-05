/**
 * Retargeting Routes
 * Mount: /api/v1/retargeting  (and legacy /api/retargeting)
 */
const express = require('express');
const router = express.Router();
const { protect } = require('../middlewares/auth');
const retargetingController = require('../controllers/retargetingController');

router.get('/flows', protect, retargetingController.listFlows);
router.post('/flows', protect, retargetingController.createFlow);
router.get('/flows/:id', protect, retargetingController.getFlow);
router.put('/flows/:id', protect, retargetingController.updateFlow);
router.delete('/flows/:id', protect, retargetingController.deleteFlow);
router.post('/audiences/preview', protect, retargetingController.previewAudience);

module.exports = router;
