const express = require('express');
const router = express.Router();
const analyticsController = require('../controllers/analyticsController');
const { protect } = require('../middlewares/auth');
const { requireFeature } = require('../middlewares/requireFeature');
const { FEATURE_KEYS } = require('../config/featureCatalog');
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
router.post('/export', requireFeature(FEATURE_KEYS.ANALYTICS_ADVANCED), validateAnalyticsExport, analyticsController.exportData);

// Agent analytics
router.post('/agents', requireFeature(FEATURE_KEYS.ANALYTICS_ADVANCED), validateAnalyticsAgents, analyticsController.getAgentAnalytics);

// Engagement analytics
router.post('/engagement', requireFeature(FEATURE_KEYS.ANALYTICS_ADVANCED), validateAnalyticsEngagement, analyticsController.getEngagementAnalytics);

// Content performance (AI vs Human) and suggested improvements
router.get('/content-performance', analyticsController.getContentPerformance);
router.get('/suggested-improvements', analyticsController.getSuggestedImprovements);

module.exports = router;

