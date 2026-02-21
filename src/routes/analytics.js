const express = require('express');
const router = express.Router();
const analyticsController = require('../controllers/analyticsController');
const { protect } = require('../middlewares/auth');
const {
  validateAnalyticsDashboard,
  validateAnalyticsExport,
  validateAnalyticsAgents,
  validateAnalyticsEngagement,
  validateAnalyticsPlatform
} = require('../middlewares/validation');

/**
 * Analytics Routes
 * All routes require authentication
 */

// Apply authentication to all routes
router.use(protect);

// Get analytics dashboard
router.post('/dashboard', validateAnalyticsDashboard, analyticsController.getDashboard);

// Get platform-specific analytics
router.post('/platform/:platform', validateAnalyticsPlatform, analyticsController.getPlatformAnalytics);

// Export analytics data
router.post('/export', validateAnalyticsExport, analyticsController.exportData);

// Agent analytics
router.post('/agents', validateAnalyticsAgents, analyticsController.getAgentAnalytics);

// Engagement analytics
router.post('/engagement', validateAnalyticsEngagement, analyticsController.getEngagementAnalytics);

module.exports = router;

