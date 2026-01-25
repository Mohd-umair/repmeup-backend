const express = require('express');
const router = express.Router();
const analyticsController = require('../controllers/analyticsController');
const { protect } = require('../middlewares/auth');

/**
 * Analytics Routes
 * All routes require authentication
 */

// Apply authentication to all routes
router.use(protect);

// Get analytics dashboard
router.post('/dashboard', analyticsController.getDashboard);

// Get platform-specific analytics
router.post('/platform/:platform', analyticsController.getPlatformAnalytics);

// Export analytics data
router.post('/export', analyticsController.exportData);

module.exports = router;

