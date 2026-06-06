/**
 * Automation Flow Controller — unified cross-channel flow builder API.
 */
const AutomationFlow = require('../models/AutomationFlow');
const flowValidationService = require('../services/flow/flowValidationService');
const flowNodeDefaultsService = require('../services/flow/flowNodeDefaultsService');
const entitlementsService = require('../services/entitlementsService');
const { FEATURE_KEYS } = require('../config/featureCatalog');
const { isTriggerType } = require('../config/flowNodeCatalog');
const logger = require('../config/logger');

async function assertFlowCap(organizationId) {
  const orgIdStr = organizationId.toString();
  const count = await AutomationFlow.countDocuments({ organization: organizationId, isBlueprint: false });
  const quota = await entitlementsService.quota(orgIdStr, FEATURE_KEYS.AUTOMATION_FLOWS_MAX);
  if (!quota.isUnlimited && count >= quota.limit) {
    const err = new Error(`Automation flow limit reached (${count}/${quota.limit}). Upgrade to add more flows.`);
    err.name = 'EntitlementError';
    err.statusCode = 402;
    err.code = 'QUOTA_EXCEEDED';
    err.featureKey = FEATURE_KEYS.AUTOMATION_FLOWS_MAX;
    throw err;
  }
}

function normalizeFlowBody(body) {
  const trigger = (body.nodes || []).find((n) => isTriggerType(n.type));
  return {
    name: body.name,
    description: body.description || '',
    channels: body.channels || ['whatsapp'],
    nodes: body.nodes || [],
    edges: body.edges || [],
    entryNodeId: body.entryNodeId || trigger?.id || '',
    settings: body.settings || {},
    isBlueprint: !!body.isBlueprint
  };
}

exports.getNodeCatalog = async (req, res, next) => {
  try {
    const channels = req.query.channels
      ? String(req.query.channels).split(',').map((c) => c.trim().toLowerCase()).filter(Boolean)
      : undefined;
    const category = req.query.category || undefined;
    const orgId = req.user?.organization?._id;
    const catalog = await flowNodeDefaultsService.getCatalogWithDefaults(orgId, { channels, category });
    return res.json({ success: true, data: catalog });
  } catch (err) {
    next(err);
  }
};

exports.listFlows = async (req, res, next) => {
  try {
    const orgId = req.user.organization._id;
    let filter;

    if (req.query.blueprints === 'true') {
      filter = {
        isBlueprint: true,
        $or: [{ organization: orgId }, { organization: null }]
      };
    } else if (req.query.blueprints === 'all') {
      filter = { organization: orgId };
    } else {
      filter = { organization: orgId, isBlueprint: { $ne: true } };
    }

    const page  = Math.max(1, parseInt(req.query.page,  10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 12));
    const skip  = (page - 1) * limit;

    const [flows, total] = await Promise.all([
      AutomationFlow.find(filter).sort({ updatedAt: -1 }).skip(skip).limit(limit).lean(),
      AutomationFlow.countDocuments(filter)
    ]);

    const pages = Math.max(1, Math.ceil(total / limit));
    return res.json({ success: true, data: flows, total, page, limit, pages });
  } catch (err) {
    next(err);
  }
};


exports.createFlow = async (req, res, next) => {
  try {
    if (!req.body.isBlueprint) await assertFlowCap(req.user.organization._id);
    const payload = normalizeFlowBody(req.body);
    const flow = await AutomationFlow.create({
      ...payload,
      organization: req.body.isBlueprint ? null : req.user.organization._id,
      createdBy: req.user._id,
      status: 'draft',
      version: 1
    });
    return res.status(201).json({ success: true, data: flow });
  } catch (err) {
    if (err?.name === 'EntitlementError') {
      return res.status(err.statusCode || 402).json({
        success: false,
        code: err.code,
        error: err.message,
        featureKey: err.featureKey
      });
    }
    next(err);
  }
};

exports.getFlow = async (req, res, next) => {
  try {
    const flow = await AutomationFlow.findOne({
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
    const payload = normalizeFlowBody(req.body);
    const validation = flowValidationService.validate({ ...payload, name: payload.name || 'Untitled' });
    if (!validation.valid && req.body.strictValidate) {
      return res.status(400).json({ success: false, error: 'Validation failed', details: validation.errors });
    }

    const flow = await AutomationFlow.findOneAndUpdate(
      { _id: req.params.id, organization: req.user.organization._id, isBlueprint: { $ne: true } },
      { $set: payload },
      { new: true, runValidators: true }
    ).lean();

    if (!flow) return res.status(404).json({ success: false, error: 'Flow not found' });
    return res.json({ success: true, data: flow, validation });
  } catch (err) {
    next(err);
  }
};

exports.deleteFlow = async (req, res, next) => {
  try {
    const result = await AutomationFlow.findOneAndDelete({
      _id: req.params.id,
      organization: req.user.organization._id,
      isBlueprint: { $ne: true }
    });
    if (!result) return res.status(404).json({ success: false, error: 'Flow not found' });
    return res.json({ success: true });
  } catch (err) {
    next(err);
  }
};

exports.publishFlow = async (req, res, next) => {
  try {
    const existing = await AutomationFlow.findOne({
      _id: req.params.id,
      organization: req.user.organization._id
    }).lean();
    if (!existing) return res.status(404).json({ success: false, error: 'Flow not found' });

    const validation = flowValidationService.validate(existing);
    if (!validation.valid) {
      return res.status(400).json({ success: false, error: 'Cannot publish invalid flow', details: validation.errors });
    }

    const flow = await AutomationFlow.findOneAndUpdate(
      { _id: req.params.id },
      { $set: { status: 'active', version: (existing.version || 1) + 1 } },
      { new: true }
    ).lean();
    return res.json({ success: true, data: flow });
  } catch (err) {
    next(err);
  }
};

exports.pauseFlow = async (req, res, next) => {
  try {
    const flow = await AutomationFlow.findOneAndUpdate(
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

exports.duplicateFlow = async (req, res, next) => {
  try {
    await assertFlowCap(req.user.organization._id);
    const source = await AutomationFlow.findOne({
      _id: req.params.id,
      $or: [
        { organization: req.user.organization._id },
        { isBlueprint: true, organization: null }
      ]
    }).lean();
    if (!source) return res.status(404).json({ success: false, error: 'Flow not found' });

    const copy = await AutomationFlow.create({
      organization: req.user.organization._id,
      createdBy: req.user._id,
      name: `${source.name} (copy)`,
      description: source.description,
      channels: source.channels,
      nodes: source.nodes,
      edges: source.edges,
      entryNodeId: source.entryNodeId,
      settings: source.settings,
      status: 'draft',
      version: 1,
      isBlueprint: false
    });
    return res.status(201).json({ success: true, data: copy });
  } catch (err) {
    if (err?.name === 'EntitlementError') {
      return res.status(err.statusCode || 402).json({ success: false, error: err.message });
    }
    next(err);
  }
};

exports.testFlow = async (req, res, next) => {
  try {
    const flow = await AutomationFlow.findOne({
      _id: req.params.id,
      organization: req.user.organization._id
    }).lean();
    if (!flow) return res.status(404).json({ success: false, error: 'Flow not found' });

    const validation = flowValidationService.validate(flow);
    const flowExecutorService = require('../services/flow/flowExecutorService');
    const steps = [];
    for (const node of flow.nodes || []) {
      steps.push({ nodeId: node.id, type: node.type, label: node.label || node.type });
    }
    return res.json({
      success: true,
      data: {
        validation,
        startNodeId: flowExecutorService.getStartNodeId(flow),
        stepPreview: steps
      }
    });
  } catch (err) {
    next(err);
  }
};

exports.getFlowStats = async (req, res, next) => {
  try {
    const flow = await AutomationFlow.findOne({
      _id: req.params.id,
      organization: req.user.organization._id
    }).select('stats name status version').lean();
    if (!flow) return res.status(404).json({ success: false, error: 'Flow not found' });
    return res.json({ success: true, data: flow });
  } catch (err) {
    next(err);
  }
};

exports.validateFlow = async (req, res, next) => {
  try {
    const body = req.body.nodes ? req.body : await AutomationFlow.findOne({
      _id: req.params.id,
      organization: req.user.organization._id
    }).lean();
    if (!body) return res.status(404).json({ success: false, error: 'Flow not found' });
    const validation = flowValidationService.validate(body);
    return res.json({ success: true, data: validation });
  } catch (err) {
    next(err);
  }
};
