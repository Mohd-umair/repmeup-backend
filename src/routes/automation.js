/**
 * Automation Hub Routes
 * Mount: /api/v1/automation  (and legacy /api/automation)
 */
const express = require('express');
const router = express.Router();
const { protect } = require('../middlewares/auth');
const automationHubController = require('../controllers/automationHubController');
const escalationController = require('../controllers/escalationController');
const reviewController = require('../controllers/reviewCollectionController');

// ── Hub overview ──────────────────────────────────────────────────────────────
router.get('/hub-overview', protect, automationHubController.getHubOverview);

// ── Escalation ────────────────────────────────────────────────────────────────
router.get('/escalation/settings', protect, escalationController.getSettings);
router.put('/escalation/settings', protect, escalationController.updateSettings);
router.get('/escalation/stats', protect, escalationController.getStats);
router.get('/escalation/breakdown', protect, escalationController.getBreakdown);
router.get('/escalation/top-reasons', protect, escalationController.getTopReasons);

// ── Review Collection ─────────────────────────────────────────────────────────
router.get('/reviews/settings', protect, reviewController.getSettings);
router.put('/reviews/settings', protect, reviewController.updateSettings);
router.get('/reviews/stats', protect, reviewController.getStats);

module.exports = router;
