'use strict';

const logger = require('../config/logger');
const audienceService = require('../services/audienceService');
const orchestrator = require('../services/campaignOrchestratorService');
const { validateCampaign } = require('../services/campaignValidationService');
const { analyzeCampaign } = require('../services/campaignReplyAnalysisService');
const { sendBatch } = require('../services/socialCampaignService');

function orgIdOf(req) {
  return req.user.organization._id || req.user.organization;
}

exports.createAudience = async (req, res, next) => {
  try {
    const data = await audienceService.createSnapshot({
      orgId: orgIdOf(req),
      userId: req.user._id,
      sourceType: req.body.sourceType || 'filter',
      sourceRef: req.body.sourceRef,
      filterQuery: req.body.filterQuery
    });
    return res.status(201).json({ success: true, data });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ success: false, error: error.message });
    next(error);
  }
};

exports.getAudience = async (req, res, next) => {
  try {
    const data = await audienceService.getSnapshot(orgIdOf(req), req.params.id);
    if (!data) return res.status(404).json({ success: false, error: 'Audience not found' });
    return res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

exports.previewAudience = async (req, res, next) => {
  try {
    const data = await audienceService.previewMembers({
      orgId: orgIdOf(req),
      snapshotId: req.params.id,
      channel: req.query.channel,
      page: req.query.page,
      limit: req.query.limit
    });
    return res.json({ success: true, data: data.items, pagination: data.pagination });
  } catch (error) {
    next(error);
  }
};

exports.materializeAudience = async (req, res, next) => {
  try {
    const data = await audienceService.materializeSnapshot(req.params.id, orgIdOf(req));
    if (!data) return res.status(404).json({ success: false, error: 'Audience not found' });
    return res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

exports.createCampaign = async (req, res, next) => {
  try {
    const data = await orchestrator.createDraft({
      orgId: orgIdOf(req),
      userId: req.user._id,
      name: req.body.name,
      channel: req.body.channel || 'whatsapp',
      audienceSnapshotId: req.body.audienceSnapshotId,
      connectionId: req.body.connectionId
    });
    return res.status(201).json({ success: true, data });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ success: false, error: error.message });
    next(error);
  }
};

exports.listCampaigns = async (req, res, next) => {
  try {
    const data = await orchestrator.listCampaigns({ orgId: orgIdOf(req), ...req.query });
    return res.json({ success: true, data: data.items, pagination: data.pagination });
  } catch (error) {
    next(error);
  }
};

exports.getCampaign = async (req, res, next) => {
  try {
    const data = await orchestrator.getCampaign(orgIdOf(req), req.params.id);
    if (!data) return res.status(404).json({ success: false, error: 'Campaign not found' });
    return res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

exports.updateCampaign = async (req, res, next) => {
  try {
    const data = await orchestrator.updateDraft(orgIdOf(req), req.params.id, req.body);
    return res.json({ success: true, data });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ success: false, error: error.message });
    next(error);
  }
};

exports.validate = async (req, res, next) => {
  try {
    const data = await validateCampaign(orgIdOf(req), req.params.id);
    return res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

exports.preview = async (req, res, next) => {
  try {
    const data = await orchestrator.previewPersonalization(orgIdOf(req), req.params.id, Number(req.query.offset) || 0);
    return res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

exports.generateContent = async (req, res, next) => {
  try {
    const data = await orchestrator.generateContent({ orgId: orgIdOf(req), ...req.body });
    return res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

exports.launch = async (req, res, next) => {
  try {
    const data = await orchestrator.launch({
      orgId: orgIdOf(req),
      userId: req.user._id,
      campaignId: req.params.id,
      sendNow: req.body.sendNow !== false
    });
    return res.json({ success: true, data });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ success: false, error: error.message, details: error.details });
    logger.error('launch campaign error', { error: error.message });
    next(error);
  }
};

exports.pause = async (req, res, next) => {
  try {
    return res.json({ success: true, data: await orchestrator.pause(orgIdOf(req), req.params.id) });
  } catch (error) {
    next(error);
  }
};

exports.resume = async (req, res, next) => {
  try {
    return res.json({ success: true, data: await orchestrator.resume(orgIdOf(req), req.params.id) });
  } catch (error) {
    next(error);
  }
};

exports.stats = async (req, res, next) => {
  try {
    return res.json({ success: true, data: await orchestrator.stats(orgIdOf(req), req.params.id) });
  } catch (error) {
    next(error);
  }
};

exports.followUp = async (req, res, next) => {
  try {
    const data = await orchestrator.createFollowUp({
      orgId: orgIdOf(req),
      userId: req.user._id,
      parentId: req.params.id,
      condition: req.body.condition || 'did_not_reply'
    });
    return res.status(201).json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

exports.analyze = async (req, res, next) => {
  try {
    const data = await analyzeCampaign(orgIdOf(req), req.params.id);
    return res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

exports.tickSocial = async (req, res, next) => {
  try {
    const data = await sendBatch({ orgId: orgIdOf(req), campaignId: req.params.id });
    return res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
};
