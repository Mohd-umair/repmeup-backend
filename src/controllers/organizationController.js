const Organization = require('../models/Organization');

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

