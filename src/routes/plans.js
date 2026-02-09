const express = require('express');
const router = express.Router();
const planController = require('../controllers/planController');
const { protect } = require('../middlewares/auth');

// Public routes - for users viewing plans
router.get('/', planController.getPlans);
router.get('/:planId', planController.getPlanById);

// Admin routes - for super admin managing plans
router.use('/admin', protect); // All admin routes require authentication

router.get('/admin/', planController.getAllPlansAdmin);
router.post('/admin/', planController.createPlan);
router.put('/admin/:id', planController.updatePlan);
router.delete('/admin/:id', planController.deletePlan);
router.patch('/admin/:id/toggle-active', planController.togglePlanActive);

module.exports = router;
