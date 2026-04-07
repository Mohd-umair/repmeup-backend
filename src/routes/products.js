const express = require('express');
const router = express.Router();
const { protect } = require('../middlewares/auth');
const productController = require('../controllers/productController');

router.use(protect);

// Catalog CRUD
router.get('/', productController.getProducts);
router.get('/by-post/:postId', productController.getProductsByPost);
router.get('/:id', productController.getProduct);
router.post('/', productController.createProduct);
router.put('/:id', productController.updateProduct);
router.delete('/:id', productController.deleteProduct);

// Resolve Instagram post shortcode → numeric media ID (must be before /:id routes)
router.get('/resolve-post', productController.resolvePostId);

// Recent Instagram posts seen in the inbox (for easy post-to-product linking)
router.get('/recent-posts', productController.getRecentPosts);

// Post-product mapping
router.post('/:id/posts', productController.linkPost);
router.post('/:id/posts/unlink', productController.unlinkPost);   // body: { postId } — safe for full-URL postIds
router.delete('/:id/posts/:postId', productController.unlinkPost); // legacy param-based route

// Comment-to-DM settings
router.get('/settings/comment-to-dm', productController.getCommentToDmSettings);
router.put('/settings/comment-to-dm', productController.updateCommentToDmSettings);

// Diagnostic dry-run (does not send real DMs)
router.post('/debug/test-automation', productController.testAutomation);

module.exports = router;
