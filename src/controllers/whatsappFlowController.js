/**
 * WhatsApp Flow Controller
 * CRUD for WhatsApp journey flows (multi-step template sequences).
 */
const WhatsAppFlow = require('../models/WhatsAppFlow');
const logger = require('../config/logger');
const entitlementsService = require('../services/entitlementsService');
const { FEATURE_KEYS } = require('../config/featureCatalog');

async function assertFlowCap(organizationId) {
  const orgIdStr = organizationId.toString();
  const count = await WhatsAppFlow.countDocuments({ organization: organizationId });
  const quota = await entitlementsService.quota(orgIdStr, FEATURE_KEYS.AUTOMATION_FLOWS_MAX);
  if (!quota.isUnlimited && count >= quota.limit) {
    const err = new Error(
      `WhatsApp automation flow limit reached (${count}/${quota.limit}). Upgrade to add more flows.`
    );
    err.name = 'EntitlementError';
    err.statusCode = 402;
    err.code = 'QUOTA_EXCEEDED';
    err.featureKey = FEATURE_KEYS.AUTOMATION_FLOWS_MAX;
    throw err;
  }
}

exports.listFlows = async (req, res, next) => {
  try {
    const flows = await WhatsAppFlow.find({ organization: req.user.organization._id })
      .sort({ createdAt: -1 })
      .lean();
    return res.json({ success: true, data: flows });
  } catch (err) {
    next(err);
  }
};

exports.createFlow = async (req, res, next) => {
  try {
    await assertFlowCap(req.user.organization._id);
    const flow = await WhatsAppFlow.create({
      ...req.body,
      organization: req.user.organization._id,
      createdBy: req.user._id,
      status: 'draft'
    });
    return res.status(201).json({ success: true, data: flow });
  } catch (err) {
    if (err?.name === 'EntitlementError') {
      return res.status(err.statusCode || 402).json({
        success: false,
        code: err.code,
        error: err.message,
        featureKey: err.featureKey,
        meta: err.meta
      });
    }
    logger.error('[whatsappFlowController] createFlow', { error: err.message });
    next(err);
  }
};

exports.getFlow = async (req, res, next) => {
  try {
    const flow = await WhatsAppFlow.findOne({
      _id: req.params.id,
      organization: req.user.organization._id
    }).populate('steps.templateId', 'name category status').lean();
    if (!flow) return res.status(404).json({ success: false, error: 'Flow not found' });
    return res.json({ success: true, data: flow });
  } catch (err) {
    next(err);
  }
};

exports.updateFlow = async (req, res, next) => {
  try {
    const flow = await WhatsAppFlow.findOneAndUpdate(
      { _id: req.params.id, organization: req.user.organization._id },
      { $set: req.body },
      { new: true, runValidators: true }
    ).lean();
    if (!flow) return res.status(404).json({ success: false, error: 'Flow not found' });
    return res.json({ success: true, data: flow });
  } catch (err) {
    next(err);
  }
};

exports.deleteFlow = async (req, res, next) => {
  try {
    await WhatsAppFlow.findOneAndDelete({ _id: req.params.id, organization: req.user.organization._id });
    return res.json({ success: true });
  } catch (err) {
    next(err);
  }
};

exports.activateFlow = async (req, res, next) => {
  try {
    const flow = await WhatsAppFlow.findOneAndUpdate(
      { _id: req.params.id, organization: req.user.organization._id },
      { $set: { status: 'active' } },
      { new: true }
    ).lean();
    if (!flow) return res.status(404).json({ success: false, error: 'Flow not found' });
    return res.json({ success: true, data: flow });
  } catch (err) {
    next(err);
  }
};

exports.pauseFlow = async (req, res, next) => {
  try {
    const flow = await WhatsAppFlow.findOneAndUpdate(
      { _id: req.params.id, organization: req.user.organization._id },
      { $set: { status: 'paused' } },
      { new: true }
    ).lean();
    if (!flow) return res.status(404).json({ success: false, error: 'Flow not found' });
    return res.json({ success: true, data: flow });
  } catch (err) {
    next(err);
  }
};
