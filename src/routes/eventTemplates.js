const express = require('express');
const router = express.Router();
const multer = require('multer');
const eventTemplateController = require('../controllers/eventTemplateController');
const { protect, authorize } = require('../middlewares/auth');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

router.use(protect);

router.get('/', eventTemplateController.list);
router.post('/', authorize('admin', 'manager'), upload.single('referenceImage'), eventTemplateController.create);
router.put('/:id', authorize('admin', 'manager'), eventTemplateController.update);
router.delete('/:id', authorize('admin', 'manager'), eventTemplateController.remove);

module.exports = router;
