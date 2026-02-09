const express = require('express');
const router = express.Router();
const subscriptionController = require('../controllers/subscriptionController');
const { protect } = require('../middlewares/auth');

// Public routes
router.get('/plans', subscriptionController.getPlans);

// Protected routes
router.use(protect);

// Get subscription limits and usage
router.get('/limits', subscriptionController.getLimits);

// Check if can connect more accounts
router.post('/check-limit', subscriptionController.checkLimit);

// Get full subscription details
router.get('/', subscriptionController.getSubscription);

// Upgrade plan
router.post('/upgrade', subscriptionController.upgradePlan);

// Cancel subscription (admin only)
router.post('/cancel', subscriptionController.cancelSubscription);

module.exports = router;
