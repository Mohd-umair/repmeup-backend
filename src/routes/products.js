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

// Post-product mapping
router.post('/:id/posts', productController.linkPost);
router.delete('/:id/posts/:postId', productController.unlinkPost);

// Comment-to-DM settings
router.get('/settings/comment-to-dm', productController.getCommentToDmSettings);
router.put('/settings/comment-to-dm', productController.updateCommentToDmSettings);

module.exports = router;
