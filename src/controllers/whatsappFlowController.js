/**
 * WhatsApp Flow Controller
 * CRUD for WhatsApp journey flows (multi-step template sequences).
 */
const WhatsAppFlow = require('../models/WhatsAppFlow');
const logger = require('../config/logger');

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
    const flow = await WhatsAppFlow.create({
      ...req.body,
      organization: req.user.organization._id,
      createdBy: req.user._id,
      status: 'draft'
    });
    return res.status(201).json({ success: true, data: flow });
  } catch (err) {
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
