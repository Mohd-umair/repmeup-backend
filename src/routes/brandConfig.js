const express = require('express');
const router = express.Router();
const brandConfigController = require('../controllers/brandConfigController');
const { protect, authorize } = require('../middlewares/auth');

router.use(protect);

router.get('/', brandConfigController.getBrandConfig);
router.post('/preview', brandConfigController.getPreview);
router.put('/', authorize('admin', 'manager'), brandConfigController.updateBrandConfig);
router.post('/retrain', authorize('admin', 'manager'), brandConfigController.retrainVoice);

module.exports = router;
