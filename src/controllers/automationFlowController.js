/**
 * Automation Flow Controller — unified cross-channel flow builder API.
 */
const AutomationFlow = require('../models/AutomationFlow');
const FlowEnrollment = require('../models/FlowEnrollment');
const flowValidationService = require('../services/flow/flowValidationService');
const flowNodeDefaultsService = require('../services/flow/flowNodeDefaultsService');
const entitlementsService = require('../services/entitlementsService');
const { FEATURE_KEYS } = require('../config/featureCatalog');
const { isTriggerType } = require('../config/flowNodeCatalog');
const flowKeywordOverlapService = require('../services/flow/flowKeywordOverlapService');
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

/**
 * Design-time keyword-overlap check, called (debounced) by the Flow Builder UI while
 * editing a trigger.keyword node, and by publishFlow (server-side, so this can't be
 * bypassed) at activation time. See flowKeywordOverlapService for the matching rule.
 */
exports.checkKeywordOverlap = async (req, res, next) => {
  try {
    const { keywords, channels, flowId } = req.body || {};
    const conflicts = await flowKeywordOverlapService.findOverlappingFlows({
      organizationId: req.user.organization._id,
      channels: Array.isArray(channels) && channels.length ? channels : ['whatsapp'],
      keywords: Array.isArray(keywords) ? keywords : [],
      excludeFlowId: flowId || null
    });
    return res.json({ success: true, conflicts });
  } catch (err) {
    next(err);
  }
};

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

    // Design-time multi-flow guard (server-side — cannot be bypassed by skipping the UI
    // warning). Blocks activation if this flow's keyword(s) overlap an already-active flow
    // on the same channel, unless the caller explicitly acknowledges it.
    const overlap = await flowKeywordOverlapService.resolveOverlapForPublish(existing, req.user.organization._id, !!req.body.acknowledgeOverlap);
    if (overlap.blocked) {
      return res.status(409).json({
        success: false,
        error: 'This flow’s keyword(s) overlap with another active flow — a customer message could trigger both and get multiple replies.',
        code: 'KEYWORD_OVERLAP',
        conflicts: overlap.conflicts
      });
    }

    const flow = await AutomationFlow.findOneAndUpdate(
      { _id: req.params.id },
      {
        $set: {
          status: 'active',
          version: (existing.version || 1) + 1,
          ...(overlap.acknowledgedOverlapUpdate ? { acknowledgedOverlap: overlap.acknowledgedOverlapUpdate } : {})
        }
      },
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

    const startNodeId = flowExecutorService.getStartNodeId(flow);

    // Build a synthetic enrollment for dry-run execution
    const syntheticEnrollment = {
      _id: 'dryrun-0000',
      organization: flow.organization,
      flow: flow._id,
      contact: null,
      status: 'active',
      currentNodeId: startNodeId,
      variables: {},
      history: [],
      nextRunAt: null,
      lastError: ''
    };

    let executionResult = null;
    if (startNodeId) {
      try {
        executionResult = await flowExecutorService.runEnrollment({
          enrollment: syntheticEnrollment,
          flow,
          interaction: null,
          organizationId: flow.organization,
          dryRun: true
        });
      } catch (execErr) {
        logger.warn('[testFlow] dry-run execution error', { flowId: flow._id, error: execErr.message });
        executionResult = { status: 'failed', lastError: execErr.message, history: [], variables: {} };
      }
    }

    // Build human-readable step list from execution history
    const nodeMap = new Map((flow.nodes || []).map((n) => [n.id, n]));
    const stepPreview = (executionResult?.history || []).map((h) => {
      const n = nodeMap.get(h.nodeId);
      return { nodeId: h.nodeId, type: n?.type || '', label: n?.label || h.nodeId, event: h.event };
    });

    // Include unvisited nodes as a fallback when there is no execution history (no trigger/edge)
    const fallbackSteps = stepPreview.length === 0
      ? (flow.nodes || []).map((n) => ({ nodeId: n.id, type: n.type, label: n.label || n.type, event: 'not_executed' }))
      : [];

    return res.json({
      success: true,
      data: {
        validation,
        startNodeId,
        simulationStatus: executionResult?.status || 'no_trigger',
        lastError: executionResult?.lastError || '',
        variables: executionResult?.variables || {},
        stepPreview: stepPreview.length ? stepPreview : fallbackSteps
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

/**
 * GET /:id/enrollments — paginated list of enrollments for a specific flow.
 * Query: page (default 1), limit (default 20, max 100), status (filter)
 */
exports.listEnrollments = async (req, res, next) => {
  try {
    const flow = await AutomationFlow.findOne({
      _id: req.params.id,
      organization: req.user.organization._id
    }).select('_id name').lean();
    if (!flow) return res.status(404).json({ success: false, error: 'Flow not found' });

    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
    const skip = (page - 1) * limit;
    const statusFilter = req.query.status;

    const query = { flow: flow._id, organization: req.user.organization._id };
    if (statusFilter && ['active', 'waiting', 'completed', 'failed', 'dropped'].includes(statusFilter)) {
      query.status = statusFilter;
    }

    const [enrollments, total] = await Promise.all([
      FlowEnrollment.find(query)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .select('_id platform platformUserId contact status currentNodeId lastError createdAt updatedAt flowVersion')
        .populate('contact', 'name phone email flowsOptedOut')
        .lean(),
      FlowEnrollment.countDocuments(query)
    ]);

    return res.json({
      success: true,
      data: {
        flow: { _id: flow._id, name: flow.name },
        enrollments,
        pagination: { page, limit, total, pages: Math.ceil(total / limit) }
      }
    });
  } catch (err) {
    next(err);
  }
};

/**
 * GET /:id/enrollments/:eid — full detail of a single enrollment including history.
 */
exports.getEnrollment = async (req, res, next) => {
  try {
    const flow = await AutomationFlow.findOne({
      _id: req.params.id,
      organization: req.user.organization._id
    }).select('_id name nodes').lean();
    if (!flow) return res.status(404).json({ success: false, error: 'Flow not found' });

    const enrollment = await FlowEnrollment.findOne({
      _id: req.params.eid,
      flow: flow._id,
      organization: req.user.organization._id
    })
      .populate('contact', 'name phone email flowsOptedOut')
      .lean();
    if (!enrollment) return res.status(404).json({ success: false, error: 'Enrollment not found' });

    // Resolve node labels for the history entries so the client can display them.
    const nodeMap = new Map((flow.nodes || []).map((n) => [n.id, n]));
    const enrichedHistory = (enrollment.history || []).map((h) => {
      const n = nodeMap.get(h.nodeId);
      return { ...h, nodeLabel: n?.label || h.nodeId, nodeType: n?.type || '' };
    });

    return res.json({
      success: true,
      data: {
        ...enrollment,
        history: enrichedHistory,
        flow: { _id: flow._id, name: flow.name }
      }
    });
  } catch (err) {
    next(err);
  }
};
