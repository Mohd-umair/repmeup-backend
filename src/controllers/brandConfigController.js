const BrandConfig = require('../models/BrandConfig');
const auditLogController = require('./auditLogController');
const aiService = require('../services/aiService');
const { runWithAiContextAndUsageId } = require('../services/aiRequestContext');
const aiCreditService = require('../services/aiCreditService');
const brandProfileService = require('../services/brandProfileService');
const brandProfileSourceService = require('../services/brandProfileSourceService');
const PlatformPost = require('../models/PlatformPost');
const { validateBrandConfigUpdate, validateProfileOverrides } = require('../utils/brandConfigValidation');

/**
 * @desc    Get brand config for current user's organization
 * @route   GET /api/brand-config
 * @access  Private
 */
exports.getBrandConfig = async (req, res) => {
  try {
    const organizationId = req.user.organization?._id || req.user.organization;
    if (!organizationId) {
      return res.status(400).json({ success: false, error: 'Organization not found' });
    }

    let config = await BrandConfig.findOne({ organization: organizationId });
    if (!config) {
      config = await BrandConfig.create({
        organization: organizationId,
        toneOfVoice: 'professional',
        personalityTags: [],
        bannedWords: [],
        approvedHashtags: [],
        legalDisclaimers: ''
      });
    }

    // Profiles are tied to the accounts that produced them. Clear analyzed
    // values (and their overrides) after an account switch so Brand Hub cannot
    // display or reuse traits learned from a disconnected account.
    const activeConnectionIds = await brandProfileSourceService.getActiveConnectionIds(organizationId);
    if (
      config.brandProfile?.analyzedAt
      && !brandProfileSourceService.isProfileCurrent(config.brandProfile, activeConnectionIds)
    ) {
      config = await BrandConfig.findOneAndUpdate(
        { organization: organizationId },
        { $set: { brandProfile: {}, brandProfileOverrides: null } },
        { new: true }
      );
    }

    res.status(200).json({
      success: true,
      data: config
    });
  } catch (error) {
    console.error('Get brand config error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to get brand config'
    });
  }
};

/**
 * @desc    Generate a brand voice preview (sample post using current config)
 * @route   POST /api/brand-config/preview
 * @access  Private
 */
exports.getPreview = async (req, res) => {
  try {
    const organizationId = req.user.organization?._id || req.user.organization;
    if (!organizationId) {
      return res.status(400).json({ success: false, error: 'Organization not found' });
    }

    // Credit gate — 1 credit per preview generation
    const creditCheck = await aiCreditService.checkCredits(organizationId, 1);
    if (!creditCheck.allowed) {
      return res.status(403).json({
        success: false,
        code: 'AI_CREDITS_EXCEEDED',
        message: creditCheck.error || 'Insufficient AI credits'
      });
    }

    const { result, aiApiUsageId } = await runWithAiContextAndUsageId(
      {
        organizationId,
        userId: req.user._id,
        feature: 'brand_config.preview'
      },
      () =>
        aiService.generatePost(
          'Write one short sample post that reflects our brand voice. One or two sentences only.',
          ['instagram'],
          'same',
          'post',
          organizationId
        )
    );

    // Deduct 1 credit and link to the vendor API usage record
    try {
      await aiCreditService.deductCredits(
        organizationId,
        1,
        { operation: 'brand_config_preview', userId: req.user._id },
        { aiApiUsageId }
      );
    } catch (creditErr) {
      console.warn('Brand preview credit deduction failed (non-fatal):', creditErr.message);
    }

    const sample = result?.posts?.all ?? result?.platformPosts?.instagram ?? '';
    const previewText = typeof sample === 'string' ? sample : (sample?.content || sample?.text || '');
    res.status(200).json({
      success: true,
      data: { preview: previewText || 'No preview generated.' }
    });
  } catch (error) {
    console.error('Brand preview error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to generate preview'
    });
  }
};

/**
 * @desc    Update brand config
 * @route   PUT /api/brand-config
 * @access  Private
 */
exports.updateBrandConfig = async (req, res) => {
  try {
    const organizationId = req.user.organization?._id || req.user.organization;
    if (!organizationId) {
      return res.status(400).json({ success: false, error: 'Organization not found' });
    }

    const { errors, values: updateFields } = validateBrandConfigUpdate(req.body);
    if (errors.length) {
      return res.status(400).json({ success: false, error: errors.join('; '), errors });
    }
    if (!Object.keys(updateFields).length) {
      return res.status(400).json({ success: false, error: 'No valid fields to update' });
    }

    let config = await BrandConfig.findOneAndUpdate(
      { organization: organizationId },
      { $set: updateFields },
      { new: true, upsert: true, runValidators: true }
    );

    await auditLogController.log(
      organizationId,
      'brand_config',
      config._id,
      'updated',
      req.user._id,
      { fields: Object.keys(updateFields) }
    );

    res.status(200).json({
      success: true,
      data: config
    });
  } catch (error) {
    console.error('Update brand config error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to update brand config'
    });
  }
};

/**
 * @desc    Mark voice as re-trained (updates voiceLastTrainedAt)
 * @route   POST /api/brand-config/retrain
 * @access  Private
 */
exports.retrainVoice = async (req, res) => {
  try {
    const organizationId = req.user.organization?._id || req.user.organization;
    if (!organizationId) {
      return res.status(400).json({ success: false, error: 'Organization not found' });
    }

    const config = await BrandConfig.findOneAndUpdate(
      { organization: organizationId },
      { $set: { voiceLastTrainedAt: new Date() } },
      { new: true, upsert: true }
    );

    res.status(200).json({
      success: true,
      data: config
    });
  } catch (error) {
    console.error('Retrain voice error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to update voice trained timestamp'
    });
  }
};

/**
 * @desc    Analyze recent posts and build brand profile
 * @route   POST /api/brand-config/analyze
 * @access  Private (admin/manager)
 */
exports.analyzeBrandProfile = async (req, res) => {
  try {
    const organizationId = req.user.organization?._id || req.user.organization;
    if (!organizationId) {
      return res.status(400).json({ success: false, error: 'Organization not found' });
    }

    const activeConnectionIds = await brandProfileSourceService.getActiveConnectionIds(organizationId);
    const postCount = activeConnectionIds.length
      ? await PlatformPost.countDocuments({
        organization: organizationId,
        platformConnection: { $in: activeConnectionIds }
      })
      : 0;
    if (postCount < 3) {
      return res.status(400).json({
        success: false,
        error: `Need at least 3 synced posts to analyze (you have ${postCount}). Sync your platforms first.`
      });
    }

    const result = await brandProfileService.analyzeOrgContent(organizationId);
    if (!result.success) {
      return res.status(400).json({ success: false, error: result.error });
    }

    const config = await BrandConfig.findOne({ organization: organizationId });
    res.status(200).json({ success: true, data: config });
  } catch (error) {
    console.error('Analyze brand profile error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Brand profile analysis failed'
    });
  }
};

/**
 * @desc    Save manual overrides for auto-analyzed brand profile values
 * @route   PUT /api/brand-config/profile-overrides
 * @access  Private (admin/manager)
 */
exports.updateProfileOverrides = async (req, res) => {
  try {
    const organizationId = req.user.organization?._id || req.user.organization;
    if (!organizationId) {
      return res.status(400).json({ success: false, error: 'Organization not found' });
    }

    const { errors, value: overrides } = validateProfileOverrides(req.body.overrides);
    if (errors.length) {
      return res.status(400).json({ success: false, error: errors.join('; '), errors });
    }

    const config = await BrandConfig.findOneAndUpdate(
      { organization: organizationId },
      { $set: { brandProfileOverrides: overrides } },
      { new: true, upsert: true, runValidators: true }
    );

    await auditLogController.log(
      organizationId,
      'brand_config',
      config._id,
      'profile_overrides_updated',
      req.user._id,
      { fields: overrides ? Object.keys(overrides) : [] }
    );

    res.status(200).json({ success: true, data: config });
  } catch (error) {
    console.error('Update profile overrides error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to update overrides'
    });
  }
};

/**
 * @desc    Clear / reset the AI-analyzed brand profile (keeps manual settings)
 * @route   DELETE /api/brand-config/brand-profile
 * @access  Private (admin/manager)
 */
exports.clearBrandProfile = async (req, res) => {
  try {
    const organizationId = req.user.organization?._id || req.user.organization;
    if (!organizationId) {
      return res.status(400).json({ success: false, error: 'Organization not found' });
    }

    const config = await BrandConfig.findOneAndUpdate(
      { organization: organizationId },
      { $set: { brandProfile: {}, brandProfileOverrides: null } },
      { new: true }
    );

    if (!config) {
      return res.status(404).json({ success: false, error: 'Brand config not found' });
    }

    await auditLogController.log(
      organizationId,
      'brand_config',
      config._id,
      'profile_cleared',
      req.user._id,
      {}
    );

    res.status(200).json({ success: true, data: config, message: 'Brand profile cleared' });
  } catch (error) {
    console.error('Clear brand profile error:', error);
    res.status(500).json({ success: false, error: error.message || 'Failed to clear profile' });
  }
};
