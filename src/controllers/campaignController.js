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
// Body: { rawText, mapping?, defaultParams? }
//   - When `mapping` is provided OR the template has variables, recipients are inserted
//     with per-recipient `templateParams` built from the CSV column → slot map.
//   - Otherwise the simpler phone[,name] path is used (backward-compatible).
exports.addRecipients = async (req, res) => {
  try {
    const { rawText, mapping, defaultParams, defaultCountry, countryCodeColumn } = req.body;
    if (!rawText || !String(rawText).trim()) {
      return res.status(400).json({ success: false, error: 'rawText is required' });
    }
    const orgId = req.user.organization._id;
    const campaignId = req.params.id;

    if (mapping && typeof mapping === 'object') {
      const result = await service.addRecipientsWithMapping({
        orgId,
        campaignId,
        rawText,
        mapping,
        defaultParams,
        defaultCountry,
        countryCodeColumn
      });
      return res.json({ success: true, ...result });
    }
    const result = await service.addRecipients({
      orgId,
      campaignId,
      rawText,
      defaultCountry,
      countryCodeColumn
    });
    res.json({ success: true, ...result });
  } catch (err) {
    handleError(res, err);
  }
};

// POST /campaigns/:id/recipients/csv/preview
// Returns headers + sample rows + suggested column → slot mapping
exports.previewRecipientCsv = async (req, res) => {
  try {
    const { rawText, defaultCountry, countryCodeColumn, phoneColumn } = req.body;
    if (!rawText || !String(rawText).trim()) {
      return res.status(400).json({ success: false, error: 'rawText is required' });
    }
    const result = await service.previewRecipientCsv({
      orgId: req.user.organization._id,
      campaignId: req.params.id,
      rawText,
      defaultCountry,
      countryCodeColumn,
      phoneColumn
    });
    res.json({ success: true, ...result });
  } catch (err) {
    handleError(res, err);
  }
};

exports.getAudienceDefaults = async (req, res) => {
  try {
    const result = await service.getAudienceDefaults({
      orgId: req.user.organization._id,
      campaignId: req.params.id
    });
    res.json({ success: true, ...result });
  } catch (err) {
    handleError(res, err);
  }
};

// GET /campaigns/:id/template-slots
// Returns the slot descriptor used by the editor to render dynamic inputs.
exports.getTemplateSlots = async (req, res) => {
  try {
    const result = await service.getTemplateSlotsForCampaign({
      orgId: req.user.organization._id,
      campaignId: req.params.id
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
// Note: `templateComponents` from the body is ignored — per-recipient components
// are now built at send time using the campaign's template snapshot + media + per-recipient params.
exports.launchCampaign = async (req, res) => {
  try {
    const campaign = await service.launchCampaign({
      orgId: req.user.organization._id,
      campaignId: req.params.id
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
// Body: { testPhone, testParams? }
//   - `testParams` is an optional slotKey → value map used to fill template variables.
//     When omitted, the most recent real recipient's params are used (or template examples).
exports.sendTestMessage = async (req, res) => {
  try {
    const { testPhone, testParams, defaultCountry } = req.body;
    if (!testPhone) {
      return res.status(400).json({ success: false, error: 'testPhone is required' });
    }
    const result = await service.sendTestMessage({
      orgId: req.user.organization._id,
      campaignId: req.params.id,
      testPhone,
      testParams: testParams && typeof testParams === 'object' ? testParams : null,
      defaultCountry
    });
    res.json({ success: true, result });
  } catch (err) {
    handleError(res, err);
  }
};
