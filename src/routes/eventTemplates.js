const express = require('express');
const router = express.Router();
const multer = require('multer');
const eventTemplateController = require('../controllers/eventTemplateController');
const { protect, authorize } = require('../middlewares/auth');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

router.use(protect);

// 'super_admin' is a distinct role from 'admin' (see User.js role enum) and
// must be listed explicitly or a super_admin gets 403 managing occasion templates.
const TEMPLATE_MANAGERS = ['super_admin', 'admin', 'manager'];

router.get('/', eventTemplateController.list);
router.post('/', authorize(...TEMPLATE_MANAGERS), upload.single('referenceImage'), eventTemplateController.create);
router.put('/:id', authorize(...TEMPLATE_MANAGERS), eventTemplateController.update);
router.delete('/:id', authorize(...TEMPLATE_MANAGERS), eventTemplateController.remove);

module.exports = router;
