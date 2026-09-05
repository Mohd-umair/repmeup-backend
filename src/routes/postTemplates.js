const express = require('express');
const router = express.Router();
const postTemplateController = require('../controllers/postTemplateController');
const { protect, authorize } = require('../middlewares/auth');

router.use(protect);

router.get('/', postTemplateController.list);
router.get('/:id', postTemplateController.getById);
router.post('/', authorize('admin', 'manager'), postTemplateController.create);
router.delete('/:id', authorize('admin', 'manager'), postTemplateController.remove);

module.exports = router;
