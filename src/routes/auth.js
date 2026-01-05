const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');
const { protect, authorize } = require('../middlewares/auth');
const { validateRegistration, validateLogin } = require('../middlewares/validation');

// Public routes
router.post('/register', validateRegistration, authController.register);
router.post('/login', validateLogin, authController.login);

// Protected routes
router.get('/me', protect, authController.getMe);
router.put('/profile', protect, authController.updateProfile);
router.put('/change-password', protect, authController.changePassword);
router.post('/logout', protect, authController.logout);

// Admin/Manager only routes
router.post(
  '/team-member',
  protect,
  authorize('admin', 'manager'),
  authController.createTeamMember
);

module.exports = router;

