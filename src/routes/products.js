const express = require('express');
const router = express.Router();
const multer = require('multer');
const { protect } = require('../middlewares/auth');
const productController = require('../controllers/productController');

const upload = multer({ storage: multer.memoryStorage() });

router.use(protect);

// ── Static/named routes MUST come before /:id ──────────────────────────────
// Import products — Excel/CSV
router.post('/import', upload.single('file'), productController.importProducts);
// Import from external platforms
router.post('/import/woocommerce', productController.importFromWooCommerce);
router.post('/import/shopify', productController.importFromShopify);
router.post('/import/url', productController.importFromUrl);
// Comment-to-DM settings
router.get('/settings/comment-to-dm', productController.getCommentToDmSettings);
router.put('/settings/comment-to-dm', productController.updateCommentToDmSettings);
router.get('/settings/comment-follow-invite', productController.getCommentFollowInviteSettings);
router.put('/settings/comment-follow-invite', productController.updateCommentFollowInviteSettings);
router.get('/settings/sales-flow', productController.getSalesFlowSettings);
router.put('/settings/sales-flow', productController.updateSalesFlowSettings);

// Resolve Instagram post shortcode → numeric media ID
router.get('/resolve-post', productController.resolvePostId);

// Posts by Instagram post ID
router.get('/by-post/:postId', productController.getProductsByPost);

// ── Catalog CRUD ────────────────────────────────────────────────────────────
router.get('/', productController.getProducts);
router.get('/:id', productController.getProduct);
router.post('/', productController.createProduct);
router.put('/:id', productController.updateProduct);
router.delete('/:id', productController.deleteProduct);

// ── Post-product mapping ────────────────────────────────────────────────────
router.post('/:id/posts', productController.linkPost);
router.post('/:id/posts/unlink', productController.unlinkPost);   // body: { postId } — safe for full-URL postIds
router.delete('/:id/posts/:postId', productController.unlinkPost); // legacy param-based route

module.exports = router;
