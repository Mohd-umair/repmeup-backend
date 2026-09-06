const express = require('express');
const router = express.Router();
const multer = require('multer');
const brandConfigController = require('../controllers/brandConfigController');
const refImageController = require('../controllers/brandReferenceImageController');
const { protect, authorize } = require('../middlewares/auth');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

router.use(protect);

// NOTE: 'super_admin' is a distinct role value from 'admin' (see User.js role
// enum) — it must be listed explicitly on every authorize() call below or a
// super_admin gets a 403 trying to manage Brand Hub, unlike every other
// admin/manager-gated feature in the app (e.g. postRoutes.js approve/reject).
const BRAND_MANAGERS = ['super_admin', 'admin', 'manager'];

router.get('/', brandConfigController.getBrandConfig);
router.post('/preview', brandConfigController.getPreview);
router.put('/', authorize(...BRAND_MANAGERS), brandConfigController.updateBrandConfig);
router.post('/retrain', authorize(...BRAND_MANAGERS), brandConfigController.retrainVoice);
router.post('/analyze', authorize(...BRAND_MANAGERS), brandConfigController.analyzeBrandProfile);
router.put('/profile-overrides', authorize(...BRAND_MANAGERS), brandConfigController.updateProfileOverrides);
router.delete('/brand-profile', authorize(...BRAND_MANAGERS), brandConfigController.clearBrandProfile);

// Reference images
router.get('/reference-images', refImageController.list);
router.get('/reference-images/style-summary', refImageController.styleSummary);
router.post('/reference-images', authorize(...BRAND_MANAGERS), upload.array('images', 5), refImageController.upload);
router.post('/reference-images/re-analyze', authorize(...BRAND_MANAGERS), refImageController.reAnalyzeAll);
router.put('/reference-images/:id', authorize(...BRAND_MANAGERS), refImageController.update);
router.delete('/reference-images/:id', authorize(...BRAND_MANAGERS), refImageController.remove);

module.exports = router;
