const express = require('express');
const router = express.Router();
const planController = require('../controllers/planController');
const { protectAdmin } = require('../middlewares/adminAuth');
const { requireSuperAdminAccess } = require('../middlewares/superAdminAccess');

// Public routes - for users viewing plans
router.get('/', planController.getPlans);

// Admin routes MUST be registered before `/:planId` or `GET /admin` is captured as planId "admin".
// Uses protectAdmin (SUPER_ADMIN_JWT_SECRET) because plan admin mutations are only ever called
// from the super-admin panel, which issues admin tokens — not regular tenant tokens.
router.use('/admin', protectAdmin, requireSuperAdminAccess);

router.get('/admin/', planController.getAllPlansAdmin);
router.post('/admin/', planController.createPlan);
router.put('/admin/:id', planController.updatePlan);
router.delete('/admin/:id', planController.deletePlan);
router.patch('/admin/:id/toggle-active', planController.togglePlanActive);

// Single plan by planId (pricing / marketing)
router.get('/:planId', planController.getPlanById);

module.exports = router;
