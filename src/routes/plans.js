const express = require('express');
const router = express.Router();
const planController = require('../controllers/planController');
const { protect } = require('../middlewares/auth');

// Public routes - for users viewing plans
router.get('/', planController.getPlans);

// Admin routes MUST be registered before `/:planId` or `GET /admin` is captured as planId "admin".
router.use('/admin', protect);

router.get('/admin/', planController.getAllPlansAdmin);
router.post('/admin/', planController.createPlan);
router.put('/admin/:id', planController.updatePlan);
router.delete('/admin/:id', planController.deletePlan);
router.patch('/admin/:id/toggle-active', planController.togglePlanActive);

// Single plan by planId (pricing / marketing)
router.get('/:planId', planController.getPlanById);

module.exports = router;
