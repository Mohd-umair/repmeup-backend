const express = require('express');
const router = express.Router();
const multer = require('multer');
const { protect, authorize } = require('../middlewares/auth');
const { requireFeature } = require('../middlewares/requireFeature');
const { FEATURE_KEYS } = require('../config/featureCatalog');
const contentStudioInputController = require('../controllers/contentStudioInputController');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// Anyone who can already use Content Studio AI generation can upload a
// one-off product photo for their own session — matches the gating already
// used by /api/posts/generate-variant-image.
const requirePostsAi = requireFeature(FEATURE_KEYS.POSTS_AI_ENABLED);

router.use(protect);

router.get('/input-images', requirePostsAi, contentStudioInputController.list);
router.get('/input-images/:id', requirePostsAi, contentStudioInputController.get);
router.post('/input-images', requirePostsAi, upload.single('image'), contentStudioInputController.upload);
router.delete('/input-images/:id', requirePostsAi, contentStudioInputController.remove);

// Promoting an ephemeral upload into the shared Brand Hub reference library
// is a write to org-wide style — same roles as brandConfig.js reference-image mutations.
router.post(
  '/input-images/:id/promote',
  requirePostsAi,
  authorize('super_admin', 'admin', 'manager'),
  contentStudioInputController.promote
);

module.exports = router;
