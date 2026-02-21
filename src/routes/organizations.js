const express = require('express');
const router = express.Router();
const organizationController = require('../controllers/organizationController');
const { protect, authorize } = require('../middlewares/auth');
const { validateOrganizationUpdate } = require('../middlewares/validation');

// All organization routes require authentication
router.use(protect);

// Get organization details
router.get('/:id', organizationController.getOrganization);

// Update organization settings (Admin/Manager only)
router.put(
  '/:id',
  authorize('admin', 'manager'),
  validateOrganizationUpdate,
  organizationController.updateOrganization
);

// Get auto-reply settings
router.get('/:id/auto-reply-settings', organizationController.getAutoReplySettings);

module.exports = router;

