const express = require('express');
const router = express.Router();
const path = require('path');
const organizationController = require('../controllers/organizationController');
const { protect, authorize } = require('../middlewares/auth');
const { validateOrganizationUpdate } = require('../middlewares/validation');

// Serve uploaded logos publicly (no auth required so images load in <img> tags)
router.use('/logos', express.static(path.join(__dirname, '../../uploads/logos')));

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

// Upload organization logo (Admin/Manager only)
router.post('/:id/logo', authorize('admin', 'manager'), organizationController.uploadLogo);

// Delete organization logo (Admin/Manager only)
router.delete('/:id/logo', authorize('admin', 'manager'), organizationController.deleteLogo);

// Get auto-reply settings
router.get('/:id/auto-reply-settings', organizationController.getAutoReplySettings);

module.exports = router;

