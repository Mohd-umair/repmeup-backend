/**
 * Campaign Controller
 *
 * Thin HTTP layer — all business logic is delegated to campaignService.
 *
 * Routes (all under /api/v1/campaigns):
 *   GET    /                         list campaigns
 *   POST   /                         create draft
 *   GET    /:id                      get campaign
 *   PUT    /:id                      update draft
 *   DELETE /:id                      delete
 *   POST   /:id/recipients           add recipients (paste / CSV)
 *   DELETE /:id/recipients           clear all recipients
 *   GET    /:id/recipients           list recipients (paginated)
 *   POST   /:id/launch               launch (immediate or scheduled)
 *   POST   /:id/pause                pause running campaign
 *   POST   /:id/resume               resume paused campaign
 *   POST   /:id/cancel               cancel campaign
 *   GET    /:id/stats                live delivery stats
 *   POST   /:id/test                 send test message to one number
 */

const service = require('../services/campaignService');

function handleError(res, err) {
  if (err.statusCode) {
    return res.status(err.statusCode).json({ success: false, error: err.message });
  }
  console.error('[CampaignController] Unexpected error', err);
  return res.status(500).json({ success: false, error: 'Internal server error' });
}

// GET /campaigns
exports.listCampaigns = async (req, res) => {
  try {
    const orgId = req.user.organization._id;
    const { page = 1, limit = 20, status } = req.query;
    const result = await service.listCampaigns({
      orgId,
      page: parseInt(page),
      limit: Math.min(parseInt(limit), 100),
      status
    });
    res.json({ success: true, ...result });
  } catch (err) {
    handleError(res, err);
  }
};

// POST /campaigns
exports.createCampaign = async (req, res) => {
  try {
    const orgId = req.user.organization._id;
    const userId = req.user._id;
    const { name, connectionId, templateRefId } = req.body;

    if (!name || !connectionId) {
      return res.status(400).json({ success: false, error: 'name and connectionId are required' });
    }

    const campaign = await service.createCampaign({ orgId, userId, name, connectionId, templateRefId });
    res.status(201).json({ success: true, campaign });
  } catch (err) {
    handleError(res, err);
  }
};

// GET /campaigns/:id
exports.getCampaign = async (req, res) => {
  try {
    const campaign = await service.getCampaign({
      orgId: req.user.organization._id,
      campaignId: req.params.id
    });
    res.json({ success: true, campaign });
  } catch (err) {
    handleError(res, err);
  }
};

// PUT /campaigns/:id
exports.updateCampaign = async (req, res) => {
  try {
    const campaign = await service.updateCampaign({
      orgId: req.user.organization._id,
      campaignId: req.params.id,
      updates: req.body
    });
    res.json({ success: true, campaign });
  } catch (err) {
    handleError(res, err);
  }
};

// DELETE /campaigns/:id
exports.deleteCampaign = async (req, res) => {
  try {
    const result = await service.deleteCampaign({
      orgId: req.user.organization._id,
      campaignId: req.params.id
    });
    res.json({ success: true, ...result });
  } catch (err) {
    handleError(res, err);
  }
};

// POST /campaigns/:id/recipients
exports.addRecipients = async (req, res) => {
  try {
    const { rawText } = req.body;
    if (!rawText || !rawText.trim()) {
      return res.status(400).json({ success: false, error: 'rawText is required' });
    }
    const result = await service.addRecipients({
      orgId: req.user.organization._id,
      campaignId: req.params.id,
      rawText
    });
    res.json({ success: true, ...result });
  } catch (err) {
    handleError(res, err);
  }
};

// DELETE /campaigns/:id/recipients
exports.clearRecipients = async (req, res) => {
  try {
    const result = await service.clearRecipients({
      orgId: req.user.organization._id,
      campaignId: req.params.id
    });
    res.json({ success: true, ...result });
  } catch (err) {
    handleError(res, err);
  }
};

// GET /campaigns/:id/recipients/report
exports.getRecipientsReport = async (req, res) => {
  try {
    const { page = 1, limit = 50, reportStatus, search } = req.query;
    const result = await service.getRecipientsReport({
      orgId: req.user.organization._id,
      campaignId: req.params.id,
      page: parseInt(page, 10),
      limit: Math.min(parseInt(limit, 10) || 50, 200),
      reportStatus: reportStatus || undefined,
      search: search || undefined
    });
    res.json({ success: true, ...result });
  } catch (err) {
    handleError(res, err);
  }
};

// GET /campaigns/:id/recipients
exports.getRecipients = async (req, res) => {
  try {
    const { page = 1, limit = 50, status } = req.query;
    const result = await service.getRecipients({
      orgId: req.user.organization._id,
      campaignId: req.params.id,
      page: parseInt(page),
      limit: Math.min(parseInt(limit), 200),
      status
    });
    res.json({ success: true, ...result });
  } catch (err) {
    handleError(res, err);
  }
};

// POST /campaigns/:id/launch
exports.launchCampaign = async (req, res) => {
  try {
    const { templateComponents } = req.body;
    const campaign = await service.launchCampaign({
      orgId: req.user.organization._id,
      campaignId: req.params.id,
      templateComponents: templateComponents || []
    });
    res.json({ success: true, campaign });
  } catch (err) {
    handleError(res, err);
  }
};

// POST /campaigns/:id/pause
exports.pauseCampaign = async (req, res) => {
  try {
    const campaign = await service.pauseCampaign({
      orgId: req.user.organization._id,
      campaignId: req.params.id
    });
    res.json({ success: true, campaign });
  } catch (err) {
    handleError(res, err);
  }
};

// POST /campaigns/:id/resume
exports.resumeCampaign = async (req, res) => {
  try {
    const campaign = await service.resumeCampaign({
      orgId: req.user.organization._id,
      campaignId: req.params.id
    });
    res.json({ success: true, campaign });
  } catch (err) {
    handleError(res, err);
  }
};

// POST /campaigns/:id/cancel
exports.cancelCampaign = async (req, res) => {
  try {
    const campaign = await service.cancelCampaign({
      orgId: req.user.organization._id,
      campaignId: req.params.id
    });
    res.json({ success: true, campaign });
  } catch (err) {
    handleError(res, err);
  }
};

// GET /campaigns/:id/stats
exports.getCampaignStats = async (req, res) => {
  try {
    const stats = await service.getCampaignStats({
      orgId: req.user.organization._id,
      campaignId: req.params.id
    });
    res.json({ success: true, stats });
  } catch (err) {
    handleError(res, err);
  }
};

// POST /campaigns/:id/test
exports.sendTestMessage = async (req, res) => {
  try {
    const { testPhone, templateComponents } = req.body;
    if (!testPhone) {
      return res.status(400).json({ success: false, error: 'testPhone is required' });
    }
    const result = await service.sendTestMessage({
      orgId: req.user.organization._id,
      campaignId: req.params.id,
      testPhone,
      templateComponents: templateComponents || []
    });
    res.json({ success: true, result });
  } catch (err) {
    handleError(res, err);
  }
};
