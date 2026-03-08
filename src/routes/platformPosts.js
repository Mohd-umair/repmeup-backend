const express = require('express');
const router = express.Router();
const platformPostsController = require('../controllers/platformPostsController');
const { protect } = require('../middlewares/auth');

router.use(protect);

/**
 * POST /api/platform-posts/sync
 * Query: platform = 'facebook' | 'instagram' (required)
 * Fetches posts from Meta for the selected platform and stores them in the database.
 */
router.post('/sync', platformPostsController.syncPlatformPosts);

/**
 * GET /api/platform-posts
 * Query: platform = 'facebook' | 'instagram' (required for data; 'all' returns [])
 * Returns posts from database (synced previously via /sync).
 */
router.get('/', platformPostsController.getPlatformPosts);

module.exports = router;
