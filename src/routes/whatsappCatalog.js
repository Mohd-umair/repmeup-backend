const express = require('express');
const router = express.Router();
const multer = require('multer');
const { protect } = require('../middlewares/auth');
const ctrl = require('../controllers/whatsappCatalogController');

const upload = multer({ storage: multer.memoryStorage() });

// All routes require authentication
router.use(protect);

// ── Catalog Settings ─────────────────────────────────────────────────────────
router.get('/settings', ctrl.getCatalogSettings);
router.put('/settings', ctrl.updateCatalogSettings);

// ── Sync ─────────────────────────────────────────────────────────────────────
router.post('/sync-all', ctrl.syncAllProducts);
router.post('/products/:productId/sync', ctrl.syncOneProduct);

// ── CSV Import ───────────────────────────────────────────────────────────────
router.post('/import/csv', upload.single('file'), ctrl.importCsv);

// ── Inbox: Send product message ───────────────────────────────────────────────
router.post('/send-product', ctrl.sendProductMessage);

module.exports = router;
