const Organization = require('../models/Organization');
const multer = require('multer');
const path = require('path');
const fs = require('fs').promises;

const LOGOS_UPLOAD_DIR = path.join(__dirname, '../../uploads/logos');

/** Remove a locally stored logo file (new path /organizations/logos/ or legacy /uploads/logos/). */
async function unlinkLocalLogoFile(logo) {
  if (!logo || typeof logo !== 'string') return;
  const isLocal =
    logo.startsWith('/organizations/logos/') || logo.startsWith('/uploads/logos/');
  if (!isLocal) return;
  const base = path.basename(logo);
  if (!base || base.includes('..')) return;
  const diskPath = path.join(LOGOS_UPLOAD_DIR, base);
  try {
    await fs.unlink(diskPath);
  } catch (_) {}
}

// ─── Multer setup for logo uploads ────────────────────────────────────────────
const logoStorage = multer.diskStorage({
  destination: async (req, file, cb) => {
    const dir = LOGOS_UPLOAD_DIR;
    try { await fs.mkdir(dir, { recursive: true }); } catch (_) {}
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || '.png';
    cb(null, `logo-${req.params.id}-${Date.now()}${ext}`);
  }
});

const logoUpload = multer({
  storage: logoStorage,
  limits: { fileSize: 2 * 1024 * 1024 }, // 2 MB
  fileFilter: (req, file, cb) => {
    const ok = /jpeg|jpg|png|gif|svg\+xml|webp/.test(file.mimetype);
    ok ? cb(null, true) : cb(new Error('Only image files are allowed (JPEG, PNG, GIF, WebP, SVG)'));
  }
}).single('logo');

/**
 * Get organization details
 * GET /api/organizations/:id
 */
exports.getOrganization = async (req, res, next) => {
  try {
    const organization = await Organization.findById(req.params.id);

    if (!organization) {
      return res.status(404).json({
        success: false,
        error: 'Organization not found'
      });
    }

    // Check if user belongs to this organization
    if (req.user.organization._id.toString() !== organization._id.toString()) {
      return res.status(403).json({
        success: false,
        error: 'Access denied'
      });
    }

    res.status(200).json({
      success: true,
      data: organization
    });
  } catch (error) {
    console.error('Get organization error:', error);
    next(error);
  }
};

/**
 * Update organization settings
 * PUT /api/organizations/:id
 */
exports.updateOrganization = async (req, res, next) => {
  try {
    const organization = await Organization.findById(req.params.id);

    if (!organization) {
      return res.status(404).json({
        success: false,
        error: 'Organization not found'
      });
    }

    // Check if user belongs to this organization and has admin role
    if (req.user.organization._id.toString() !== organization._id.toString()) {
      return res.status(403).json({
        success: false,
        error: 'Access denied'
      });
    }

    if (req.user.role !== 'admin' && req.user.role !== 'manager') {
      return res.status(403).json({
        success: false,
        error: 'Only admins and managers can update organization settings'
      });
    }

    // Update allowed fields
    const allowedFields = [
      'name',
      'website',
      'industry',
      'size',
      'logo',
      'whiteLabel'
    ];

    allowedFields.forEach(field => {
      if (req.body[field] !== undefined) {
        organization[field] = req.body[field];
      }
    });

    // Handle autoReplySettings separately (merge nested object)
    if (req.body.autoReplySettings !== undefined) {
      // Merge the autoReplySettings object instead of replacing
      if (!organization.autoReplySettings) {
        organization.autoReplySettings = {};
      }
      Object.keys(req.body.autoReplySettings).forEach(key => {
        if (req.body.autoReplySettings[key] !== undefined) {
          organization.autoReplySettings[key] = req.body.autoReplySettings[key];
        }
      });
    }

    // Handle inboxSettings (merge nested object)
    if (req.body.inboxSettings !== undefined) {
      if (!organization.inboxSettings) {
        organization.inboxSettings = {};
      }
      Object.keys(req.body.inboxSettings).forEach(key => {
        if (req.body.inboxSettings[key] !== undefined) {
          organization.inboxSettings[key] = req.body.inboxSettings[key];
        }
      });
    }

    // Handle escalationSettings (e.g. autoAssign for new conversations)
    if (req.body.escalationSettings !== undefined) {
      if (!organization.escalationSettings) {
        organization.escalationSettings = {};
      }
      Object.keys(req.body.escalationSettings).forEach(key => {
        if (req.body.escalationSettings[key] !== undefined) {
          organization.escalationSettings[key] = req.body.escalationSettings[key];
        }
      });
    }

    await organization.save();

    // Update scheduled jobs after saving (so we have the updated organization)
    if (req.body.autoReplySettings !== undefined) {
      try {
        const autoReplyScheduler = require('../services/autoReplyScheduler');
        await autoReplyScheduler.updateScheduledJob(organization);
      } catch (error) {
        console.error('Error updating scheduled job:', error);
        // Don't fail the request if scheduler update fails
      }
    }

    res.status(200).json({
      success: true,
      data: organization,
      message: 'Organization settings updated successfully'
    });
  } catch (error) {
    console.error('Update organization error:', error);
    next(error);
  }
};

/**
 * Get auto-reply settings
 * GET /api/organizations/:id/auto-reply-settings
 */
exports.getAutoReplySettings = async (req, res, next) => {
  try {
    const organization = await Organization.findById(req.params.id);

    if (!organization) {
      return res.status(404).json({
        success: false,
        error: 'Organization not found'
      });
    }

    // Check if user belongs to this organization
    if (req.user.organization._id.toString() !== organization._id.toString()) {
      return res.status(403).json({
        success: false,
        error: 'Access denied'
      });
    }

    res.status(200).json({
      success: true,
      data: organization.autoReplySettings || {
        enabled: false,
        enabledPlatforms: ['youtube', 'instagram', 'facebook', 'google'],
        enabledTypes: ['comment', 'review'],
        replyToNegative: false,
        replyToComplaints: false,
        minConfidence: 0.75,
        autoSend: false,
        requireApproval: true,
        maxRepliesPerDay: 50,
        repliesCountToday: 0
      }
    });
  } catch (error) {
    console.error('Get auto-reply settings error:', error);
    next(error);
  }
};

/**
 * Upload / replace organization logo
 * POST /api/organizations/:id/logo
 */
exports.uploadLogo = (req, res, next) => {
  logoUpload(req, res, async (err) => {
    if (err) {
      return res.status(400).json({ success: false, error: err.message });
    }
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'No file uploaded.' });
    }

    try {
      const organization = await Organization.findById(req.params.id);
      if (!organization) {
        return res.status(404).json({ success: false, error: 'Organization not found' });
      }

      if (req.user.organization._id.toString() !== organization._id.toString()) {
        return res.status(403).json({ success: false, error: 'Access denied' });
      }

      // Delete old logo file if it was a local upload
      await unlinkLocalLogoFile(organization.logo);

      // Public URL — served by GET /api/organizations/logos/<filename> (see organizations routes)
      const logoUrl = `/organizations/logos/${req.file.filename}`;
      organization.logo = logoUrl;
      await organization.save();

      res.status(200).json({
        success: true,
        data: { logo: logoUrl },
        message: 'Logo uploaded successfully'
      });
    } catch (error) {
      console.error('Upload logo error:', error);
      next(error);
    }
  });
};

/**
 * Delete organization logo
 * DELETE /api/organizations/:id/logo
 */
exports.deleteLogo = async (req, res, next) => {
  try {
    const organization = await Organization.findById(req.params.id);
    if (!organization) {
      return res.status(404).json({ success: false, error: 'Organization not found' });
    }

    if (req.user.organization._id.toString() !== organization._id.toString()) {
      return res.status(403).json({ success: false, error: 'Access denied' });
    }

    await unlinkLocalLogoFile(organization.logo);

    organization.logo = undefined;
    await organization.save();

    res.status(200).json({ success: true, message: 'Logo removed successfully' });
  } catch (error) {
    console.error('Delete logo error:', error);
    next(error);
  }
};
