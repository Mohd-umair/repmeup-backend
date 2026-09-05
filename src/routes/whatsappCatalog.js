const express = require('express');
const router = express.Router();
const multer = require('multer');
const { protect } = require('../middlewares/auth');
const { requireFeature } = require('../middlewares/requireFeature');
const { FEATURE_KEYS } = require('../config/featureCatalog');
const ctrl = require('../controllers/whatsappCatalogController');

const upload = multer({ storage: multer.memoryStorage() });
const requireWaCatalog = requireFeature(FEATURE_KEYS.COMMERCE_WA_CATALOG_ENABLED);

// All routes require authentication + WhatsApp Catalog plan entitlement
router.use(protect);
router.use(requireWaCatalog);

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
