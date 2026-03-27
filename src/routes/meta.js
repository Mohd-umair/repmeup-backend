const express = require('express');
const router = express.Router();
const metaPagesController = require('../controllers/metaPagesController');
const { protect } = require('../middlewares/auth');
const { checkConnectionLimit, attachConnectionLimits } = require('../middleware/platformLimitMiddleware');

/**
 * Meta Pages Routes (Step 8)
 * Handles Facebook/Instagram page selection
 */

// All routes require authentication
router.use(protect);

// Get user's Facebook pages with connection status
router.get('/pages', attachConnectionLimits, metaPagesController.getUserPages);

// Connect selected pages (with limit enforcement)
router.post('/pages/connect', checkConnectionLimit, metaPagesController.connectSelectedPages);

// Re-subscribe connected Facebook pages to webhook (feed + messages) — for existing pages after deploy
router.post('/pages/resubscribe-webhooks', metaPagesController.resubscribeFacebookWebhooks);

// Disconnect a specific page
router.delete('/pages/:pageId', metaPagesController.disconnectPage);

// Re-enrich stored Instagram mentions that only have fallback text (e.g. "You were mentioned...")
router.post('/mentions/re-enrich', metaPagesController.reEnrichMentions);

module.exports = router;
