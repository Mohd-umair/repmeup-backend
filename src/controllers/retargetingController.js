/**
 * Retargeting Controller
 * CRUD for retargeting flows + audience preview.
 */
const RetargetingFlow = require('../models/RetargetingFlow');
const retargetingService = require('../services/retargetingService');
const logger = require('../config/logger');

exports.listFlows = async (req, res, next) => {
  try {
    const flows = await RetargetingFlow.find({ organization: req.user.organization._id })
      .sort({ createdAt: -1 })
      .lean();
    return res.json({ success: true, data: flows });
  } catch (err) {
    next(err);
  }
};

exports.createFlow = async (req, res, next) => {
  try {
    const flow = await RetargetingFlow.create({
      ...req.body,
      organization: req.user.organization._id,
      createdBy: req.user._id,
      status: 'draft'
    });
    return res.status(201).json({ success: true, data: flow });
  } catch (err) {
    logger.error('[retargetingController] createFlow', { error: err.message });
    next(err);
  }
};

exports.getFlow = async (req, res, next) => {
  try {
    const flow = await RetargetingFlow.findOne({
      _id: req.params.id,
      organization: req.user.organization._id
    }).lean();
    if (!flow) return res.status(404).json({ success: false, error: 'Flow not found' });
    return res.json({ success: true, data: flow });
  } catch (err) {
    next(err);
  }
};

exports.updateFlow = async (req, res, next) => {
  try {
    const flow = await RetargetingFlow.findOneAndUpdate(
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
    await RetargetingFlow.findOneAndDelete({ _id: req.params.id, organization: req.user.organization._id });
    return res.json({ success: true });
  } catch (err) {
    next(err);
  }
};

exports.previewAudience = async (req, res, next) => {
  try {
    const { audienceType, filters } = req.body;
    const count = await retargetingService.estimateAudienceSize(
      req.user.organization._id,
      audienceType,
      filters || {}
    );
    return res.json({ success: true, data: { estimatedSize: count } });
  } catch (err) {
    next(err);
  }
};
