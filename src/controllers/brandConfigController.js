const BrandConfig = require('../models/BrandConfig');
const auditLogController = require('./auditLogController');
const aiService = require('../services/aiService');
const { runWithAiContextAndUsageId } = require('../services/aiRequestContext');
const aiCreditService = require('../services/aiCreditService');

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

    const { toneOfVoice, personalityTags, bannedWords, approvedHashtags, legalDisclaimers } = req.body;

    const updateFields = {};
    if (toneOfVoice !== undefined) updateFields.toneOfVoice = toneOfVoice;
    if (Array.isArray(personalityTags)) updateFields.personalityTags = personalityTags.map(s => String(s).trim()).filter(Boolean);
    if (Array.isArray(bannedWords)) updateFields.bannedWords = bannedWords.map(s => String(s).trim()).filter(Boolean);
    if (Array.isArray(approvedHashtags)) updateFields.approvedHashtags = approvedHashtags.map(s => String(s).trim()).filter(Boolean);
    if (legalDisclaimers !== undefined) updateFields.legalDisclaimers = String(legalDisclaimers || '').trim();

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
