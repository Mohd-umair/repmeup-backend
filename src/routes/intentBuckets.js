const express = require('express');
const router = express.Router();
const intentBucketController = require('../controllers/intentBucketController');
const { protect, authorize } = require('../middlewares/auth');
const { requireFeature } = require('../middlewares/requireFeature');
const { FEATURE_KEYS } = require('../config/featureCatalog');

router.use(protect);

router.get('/', intentBucketController.getBuckets);
router.post(
  '/',
  authorize('admin', 'manager'),
  requireFeature(FEATURE_KEYS.INBOX_BUCKET_CREATE),
  intentBucketController.createBucket
);
router.put('/reorder', authorize('admin', 'manager'), intentBucketController.reorderBuckets);
router.put('/:id', authorize('admin', 'manager'), intentBucketController.updateBucket);
router.delete('/:id', authorize('admin', 'manager'), intentBucketController.deleteBucket);

module.exports = router;
