const express = require('express');
const router = express.Router();
const intentBucketController = require('../controllers/intentBucketController');
const { protect, authorize } = require('../middlewares/auth');
const { requireFeature } = require('../middlewares/requireFeature');
const { FEATURE_KEYS } = require('../config/featureCatalog');

router.use(protect);

router.get('/', intentBucketController.getBuckets);
/**
 * Two gates, on purpose.
 *
 * `INBOX_BUCKET_CREATE` is the original key and 13 free orgs depend on its current
 * value — removing it would silently change what they can do. `INBOX_INTENT_BUCKET_ENABLED`
 * is the pricing-sheet key that actually sells Intent Bucket as Growth-and-above.
 * A caller must satisfy both, so the old contract holds while the new one starts to bite.
 */
router.post(
  '/',
  authorize('admin', 'manager'),
  requireFeature(FEATURE_KEYS.INBOX_BUCKET_CREATE),
  requireFeature(FEATURE_KEYS.INBOX_INTENT_BUCKET_ENABLED),
  intentBucketController.createBucket
);
router.put('/reorder', authorize('admin', 'manager'), intentBucketController.reorderBuckets);
router.put('/:id', authorize('admin', 'manager'), intentBucketController.updateBucket);
router.delete('/:id', authorize('admin', 'manager'), intentBucketController.deleteBucket);

module.exports = router;
