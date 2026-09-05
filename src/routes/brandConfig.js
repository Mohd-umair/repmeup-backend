const express = require('express');
const router = express.Router();
const multer = require('multer');
const brandConfigController = require('../controllers/brandConfigController');
const refImageController = require('../controllers/brandReferenceImageController');
const { protect, authorize } = require('../middlewares/auth');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

router.use(protect);

router.get('/', brandConfigController.getBrandConfig);
router.post('/preview', brandConfigController.getPreview);
router.put('/', authorize('admin', 'manager'), brandConfigController.updateBrandConfig);
router.post('/retrain', authorize('admin', 'manager'), brandConfigController.retrainVoice);
router.post('/analyze', authorize('admin', 'manager'), brandConfigController.analyzeBrandProfile);
router.put('/profile-overrides', authorize('admin', 'manager'), brandConfigController.updateProfileOverrides);
router.delete('/brand-profile', authorize('admin', 'manager'), brandConfigController.clearBrandProfile);

// Reference images
router.get('/reference-images', refImageController.list);
router.get('/reference-images/style-summary', refImageController.styleSummary);
router.post('/reference-images', authorize('admin', 'manager'), upload.array('images', 5), refImageController.upload);
router.put('/reference-images/:id', authorize('admin', 'manager'), refImageController.update);
router.delete('/reference-images/:id', authorize('admin', 'manager'), refImageController.remove);

module.exports = router;
