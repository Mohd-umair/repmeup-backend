/**
 * WhatsApp Template Routes
 * Base: /api/whatsapp-templates
 */

const express = require('express');
const multer = require('multer');
const router = express.Router();
const { protect } = require('../middlewares/auth');
const ctrl = require('../controllers/whatsappTemplateController');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 32 * 1024 * 1024 }
});

router.use(protect);

router.post('/upload-header-example', upload.single('file'), ctrl.uploadHeaderExample);

router.route('/')
  .post(ctrl.createTemplate)
  .get(ctrl.listTemplates);

router.route('/:templateId')
  .get(ctrl.getTemplate)
  .delete(ctrl.deleteTemplate);

module.exports = router;
