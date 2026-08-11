const express = require('express');
const router = express.Router();
const { protect, authorize } = require('../middlewares/auth');
const addOnController = require('../controllers/addOnController');

router.use(protect);

// Anyone who can see billing can see what's on offer.
router.get('/', addOnController.listAvailable);
router.get('/mine', addOnController.listMine);

// Spending money is restricted to the roles that own billing.
router.post('/purchase', authorize('admin', 'manager'), addOnController.purchase);
router.post('/verify', authorize('admin', 'manager'), addOnController.verify);

// Recurring add-ons (extra seats, Flow Builder) — their own Razorpay subscription each.
router.post('/subscribe', authorize('admin', 'manager'), addOnController.subscribe);
router.post('/subscribe/verify', authorize('admin', 'manager'), addOnController.verifySubscription);
router.delete('/:addOnId/subscription', authorize('admin', 'manager'), addOnController.cancelSubscription);

module.exports = router;
