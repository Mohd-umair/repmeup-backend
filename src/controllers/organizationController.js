const Organization = require('../models/Organization');
const { normalizeAutoReplyDelaySettings } = require('../utils/replyDelayHelper');
const multer = require('multer');
const path = require('path');
const fs = require('fs').promises;
const storageService = require('../services/storageService');

// ─── Multer setup for logo uploads ────────────────────────────────────────────
// Use memory storage when S3 is configured to avoid disk dependency
function buildLogoStorage() {
  if (storageService.isS3Configured()) {
    return multer.memoryStorage();
  }
  return multer.diskStorage({
    destination: (req, file, cb) => {
      const dir = path.join(__dirname, '../../uploads/logos');
      require('fs').mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase() || '.png';
      cb(null, `logo-${req.params.id}-${Date.now()}${ext}`);
    }
  });
}

const logoUpload = multer({
  storage: buildLogoStorage(),
  limits: { fileSize: 2 * 1024 * 1024 }, // 2 MB
  fileFilter: (req, file, cb) => {
    const ok = /jpeg|jpg|png|gif|svg\+xml|webp/.test(file.mimetype);
    ok ? cb(null, true) : cb(new Error('Only image files are allowed (JPEG, PNG, GIF, WebP, SVG)'));
  }
}).single('logo');

/**
 * Get the current authenticated user's organization
 * GET /api/organizations/me
 */
exports.getMyOrganization = async (req, res, next) => {
  try {
    const orgId = req.user.organization?._id || req.user.organization;
    const organization = await Organization.findById(orgId);

    if (!organization) {
      return res.status(404).json({ success: false, error: 'Organization not found' });
    }

    res.status(200).json({ success: true, data: organization });
  } catch (error) {
    console.error('Get my organization error:', error);
    next(error);
  }
};

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
      'whiteLabel',
      'orgCode'
    ];

    allowedFields.forEach(field => {
      if (req.body[field] !== undefined) {
        organization[field] = req.body[field];
      }
    });

    // Sanitize orgCode: strip non-alphanumeric, uppercase, max 6 chars
    if (organization.orgCode) {
      organization.orgCode = organization.orgCode.replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 6);
    }

    // Handle autoReplySettings separately (merge nested object)
    if (req.body.autoReplySettings !== undefined) {
      // Merge the autoReplySettings object instead of replacing
      if (!organization.autoReplySettings) {
        organization.autoReplySettings = {};
      }
      Object.keys(req.body.autoReplySettings).forEach(key => {
        if (req.body.autoReplySettings[key] !== undefined) {
          // Deep-merge nested sub-objects (e.g. fallbackSettings) so partial updates
          // don't wipe sibling fields that were not included in the request
          if (
            key === 'fallbackSettings' &&
            typeof req.body.autoReplySettings[key] === 'object' &&
            req.body.autoReplySettings[key] !== null &&
            !Array.isArray(req.body.autoReplySettings[key])
          ) {
            organization.autoReplySettings[key] = {
              ...(organization.autoReplySettings[key]?.toObject
                ? organization.autoReplySettings[key].toObject()
                : organization.autoReplySettings[key] || {}),
              ...req.body.autoReplySettings[key]
            };
            organization.markModified('autoReplySettings.fallbackSettings');
          } else {
            organization.autoReplySettings[key] = req.body.autoReplySettings[key];
          }
        }
      });
      normalizeAutoReplyDelaySettings(organization.autoReplySettings);
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

    // Handle per-channel automation mode (workflow_only | ai_only | hybrid)
    if (req.body.automationModeByChannel !== undefined) {
      const VALID_MODES = ['workflow_only', 'ai_only', 'hybrid'];
      const CHANNELS = ['whatsapp', 'instagram', 'facebook'];
      if (!organization.automationModeByChannel) {
        organization.automationModeByChannel = {};
      }
      CHANNELS.forEach(ch => {
        const val = req.body.automationModeByChannel[ch];
        if (val !== undefined && VALID_MODES.includes(val)) {
          organization.automationModeByChannel[ch] = val;
        }
      });
      organization.markModified('automationModeByChannel');
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

      if (organization.logo) {
        if (/^https?:\/\//i.test(organization.logo)) {
          await storageService.deleteObjectFromPublicUrl(organization.logo);
        } else if (
          organization.logo.startsWith('/uploads/logos/') ||
          organization.logo.startsWith('/organizations/logos/')
        ) {
          const rel = organization.logo.replace(/^\//, '');
          const oldPath = path.join(__dirname, '../..', rel);
          try {
            await fs.unlink(oldPath);
          } catch (_) {}
        }
      }

      let logoUrl;
      if (storageService.isS3Configured()) {
        // memory storage → req.file.buffer; disk storage → read from path
        const buf = req.file.buffer
          ? req.file.buffer
          : await fs.readFile(req.file.path).finally(() => {
              fs.unlink(req.file.path).catch(() => {});
            });
        const ext = path.extname(req.file.originalname).toLowerCase() || '.png';
        const filename = `logo-${req.params.id}-${Date.now()}${ext}`;
        const key = storageService.buildLogoKey(req.params.id, filename);
        const { publicUrl } = await storageService.uploadBuffer(key, buf, req.file.mimetype);
        logoUrl = publicUrl;
      } else {
        logoUrl = `/uploads/logos/${req.file.filename}`;
      }
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

    if (organization.logo) {
      if (/^https?:\/\//i.test(organization.logo)) {
        await storageService.deleteObjectFromPublicUrl(organization.logo);
      } else if (
        organization.logo.startsWith('/uploads/logos/') ||
        organization.logo.startsWith('/organizations/logos/')
      ) {
        const rel = organization.logo.replace(/^\//, '');
        const oldPath = path.join(__dirname, '../..', rel);
        try {
          await fs.unlink(oldPath);
        } catch (_) {}
      }
    }

    organization.logo = undefined;
    await organization.save();

    res.status(200).json({ success: true, message: 'Logo removed successfully' });
  } catch (error) {
    console.error('Delete logo error:', error);
    next(error);
  }
};

// ─── Quiet-hours helpers (reused from processAutoReply) ──────────────────────

function _parseHHMM(str) {
  const [h, m] = String(str || '00:00').split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

function _isQuietHoursActive(quietHours) {
  if (!quietHours?.enabled) return false;
  try {
    const tz = quietHours.timezone || 'UTC';
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false
    }).formatToParts(new Date());
    const h = parseInt(parts.find(p => p.type === 'hour')?.value || '0', 10);
    const m = parseInt(parts.find(p => p.type === 'minute')?.value || '0', 10);
    const now = h * 60 + m;
    const start = _parseHHMM(quietHours.start);
    const end   = _parseHHMM(quietHours.end);
    return start >= end
      ? (now >= start || now < end)   // overnight (e.g. 22:00–08:00)
      : (now >= start && now < end);
  } catch (_) { return false; }
}

/**
 * GET /api/organizations/:id/automation-status
 * Returns live automation state: auto-reply on/off, quiet hours, profile completeness.
 */
exports.getAutomationStatus = async (req, res, next) => {
  try {
    const orgId = req.params.id;

    if (req.user.organization._id.toString() !== orgId.toString() &&
        req.user.organization.toString() !== orgId.toString()) {
      return res.status(403).json({ success: false, error: 'Access denied' });
    }

    const PlatformConnection = require('../models/PlatformConnection');
    const KnowledgeBase      = require('../models/KnowledgeBase');
    const BrandConfig        = require('../models/BrandConfig');

    const [org, platformCount, kbCount, brandConfig] = await Promise.all([
      Organization.findById(orgId)
        .select('autoReplySettings automationModeByChannel')
        .lean(),
      PlatformConnection.countDocuments({ organization: orgId, isActive: true, status: 'connected' }),
      KnowledgeBase.countDocuments({ organization: orgId }),
      BrandConfig.findOne({ organization: orgId }).select('toneOfVoice').lean()
    ]);

    if (!org) {
      return res.status(404).json({ success: false, error: 'Organization not found' });
    }

    const ar = org.autoReplySettings || {};
    const qh = ar.quietHours || {};

    // Primary mode — prefer instagram channel; fall back to first configured channel
    const modeMap = org.automationModeByChannel || {};
    const primaryMode =
      modeMap.instagram || modeMap.facebook || modeMap.whatsapp || modeMap.youtube || 'ai_only';

    // Profile completeness (4 checkpoints)
    const completenessItems = [
      { key: 'platform',     label: 'Platform connected',    done: platformCount > 0, link: '/app/connections' },
      { key: 'knowledgeBase',label: 'Knowledge base',        done: kbCount > 0,       link: '/app/knowledge-base' },
      { key: 'autoReply',    label: 'Auto-reply configured', done: !!ar.enabled,      link: '/app/automation/ai-replies' },
      { key: 'brandVoice',   label: 'Brand voice set',       done: !!(brandConfig?.toneOfVoice && brandConfig.toneOfVoice !== 'balanced'), link: '/app/brand-config' }
    ];
    const score = Math.round(
      (completenessItems.filter(i => i.done).length / completenessItems.length) * 100
    );

    return res.status(200).json({
      success: true,
      data: {
        autoReply: {
          enabled:  !!ar.enabled,
          mode:     primaryMode,
          platforms: Array.isArray(ar.enabledPlatforms) ? ar.enabledPlatforms : [],
          quietHours: {
            enabled:     !!qh.enabled,
            isActiveNow: _isQuietHoursActive(qh),
            start:       qh.start     || '22:00',
            end:         qh.end       || '08:00',
            timezone:    qh.timezone  || 'UTC'
          },
          fallback: {
            enabled: !!(ar.fallbackSettings?.enabled),
            message: ar.fallbackSettings?.message || ''
          }
        },
        profileCompleteness: { score, items: completenessItems }
      }
    });
  } catch (error) {
    console.error('Get automation status error:', error);
    next(error);
  }
};
