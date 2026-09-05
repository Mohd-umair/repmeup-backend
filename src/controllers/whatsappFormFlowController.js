/**
 * WhatsApp Form Flow Controller — manage customer review/survey flows
 */
const WhatsAppFormFlow = require('../models/WhatsAppFormFlow');
const ReviewRequestSettings = require('../models/ReviewRequestSettings');
const PlatformConnection = require('../models/PlatformConnection');
const entitlementsService = require('../services/entitlementsService');
const { FEATURE_KEYS } = require('../config/featureCatalog');
const { buildFlowJson, getTemplate, listTemplates } = require('../config/whatsappFlowTemplates');
const metaFlowService = require('../integrations/whatsapp/metaFlowService');
const whatsappTemplateService = require('../services/whatsappTemplateService');
const logger = require('../config/logger');

async function assertFlowCap(organizationId) {
  const orgIdStr = organizationId.toString();
  const count = await WhatsAppFormFlow.countDocuments({
    organization: organizationId,
    status: 'published'
  });
  const quota = await entitlementsService.quota(orgIdStr, FEATURE_KEYS.WHATSAPP_FLOWS_MAX);
  if (!quota.isUnlimited && count >= quota.limit) {
    const err = new Error(`WhatsApp form flow limit reached (${count}/${quota.limit}). Upgrade to publish more flows.`);
    err.name = 'EntitlementError';
    err.statusCode = 402;
    err.code = 'QUOTA_EXCEEDED';
    err.featureKey = FEATURE_KEYS.WHATSAPP_FLOWS_MAX;
    throw err;
  }
}

async function resolveConnection(organizationId) {
  const connection = await PlatformConnection.findOne({
    organization: organizationId,
    platform: 'whatsapp',
    isActive: true
  }).lean();
  if (!connection) {
    throw new Error('WhatsApp connection not found. Configure your WhatsApp Business Account in settings.');
  }
  return connection;
}

exports.getTemplates = async (req, res, next) => {
  try {
    const templates = listTemplates();
    return res.json({ success: true, data: templates });
  } catch (err) {
    next(err);
  }
};

exports.listFlows = async (req, res, next) => {
  try {
    const orgId = req.user.organization._id;
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 12));
    const skip = (page - 1) * limit;

    const filter = { organization: orgId };
    if (req.query.status) {
      filter.status = req.query.status;
    }

    const [flows, total] = await Promise.all([
      WhatsAppFormFlow.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .select('-flowJson')
        .lean(),
      WhatsAppFormFlow.countDocuments(filter)
    ]);

    const pages = Math.max(1, Math.ceil(total / limit));
    return res.json({ success: true, data: flows, total, page, limit, pages });
  } catch (err) {
    next(err);
  }
};

exports.createFlow = async (req, res, next) => {
  try {
    await assertFlowCap(req.user.organization._id);

    const { templateKey, name, customization } = req.body;
    if (!templateKey || !name) {
      return res.status(400).json({ success: false, error: 'templateKey and name are required' });
    }

    const template = getTemplate(templateKey);
    const flowJson = buildFlowJson(templateKey, customization || {});

    const flow = await WhatsAppFormFlow.create({
      organization: req.user.organization._id,
      createdBy: req.user._id,
      templateKey,
      name,
      customization: customization || {},
      flowJson,
      status: 'draft'
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
    if (err.message.includes('Unknown template')) {
      return res.status(400).json({ success: false, error: err.message });
    }
    next(err);
  }
};

exports.getFlow = async (req, res, next) => {
  try {
    const flow = await WhatsAppFormFlow.findOne({
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
    const { name, customization } = req.body;
    const flow = await WhatsAppFormFlow.findOne({
      _id: req.params.id,
      organization: req.user.organization._id,
      status: 'draft'
    });

    if (!flow) {
      return res.status(404).json({
        success: false,
        error: 'Flow not found or cannot edit published flows'
      });
    }

    const updatedCustomization = { ...flow.customization, ...(customization || {}) };
    const flowJson = buildFlowJson(flow.templateKey, updatedCustomization);

    flow.name = name || flow.name;
    flow.customization = updatedCustomization;
    flow.flowJson = flowJson;
    await flow.save();

    return res.json({ success: true, data: flow });
  } catch (err) {
    next(err);
  }
};

exports.deleteFlow = async (req, res, next) => {
  try {
    const result = await WhatsAppFormFlow.findOneAndDelete({
      _id: req.params.id,
      organization: req.user.organization._id,
      status: { $in: ['draft', 'deprecated'] }
    });

    if (!result) {
      return res.status(404).json({
        success: false,
        error: 'Flow not found or cannot delete published flows'
      });
    }

    return res.json({ success: true, message: 'Flow deleted' });
  } catch (err) {
    next(err);
  }
};

exports.publishFlow = async (req, res, next) => {
  try {
    await assertFlowCap(req.user.organization._id);

    const flow = await WhatsAppFormFlow.findOne({
      _id: req.params.id,
      organization: req.user.organization._id,
      status: 'draft'
    });

    if (!flow) {
      return res.status(404).json({
        success: false,
        error: 'Flow not found or already published'
      });
    }

    const connection = await resolveConnection(req.user.organization._id);

    const flowJson = buildFlowJson(flow.templateKey, flow.customization);

    // Publishing is a multi-step Meta handshake and any step can fail. Reuse the
    // draft already created on a previous attempt instead of creating a second
    // one — flow names are unique per WABA, so re-creating both orphans the old
    // flow and makes every retry fail on the name collision.
    let metaFlowId = flow.metaFlowId;
    if (!metaFlowId) {
      // Meta needs a WABA-unique name; the id suffix keeps retries collision-free.
      const metaFlowName = `${flow.name} (${flow._id.toString().slice(-6)})`;
      const createFlowResult = await metaFlowService.createFlow(connection, metaFlowName, 'SURVEY');
      metaFlowId = createFlowResult.flowId;

      // Persist before the next call so a later failure doesn't strand the flow.
      flow.metaFlowId = metaFlowId;
      flow.metaFlowStatus = 'draft';
      await flow.save();
    }

    await metaFlowService.uploadFlowAsset(connection, metaFlowId, flowJson);

    await metaFlowService.publishFlow(connection, metaFlowId);

    const flowButtonTemplateName = `review_flow_${flow._id.toString().slice(-8)}`;
    let messageTemplateId = null;

    messageTemplateId = await createFlowButtonTemplate(
      req.user.organization._id,
      req.user._id,
      connection._id,
      flowButtonTemplateName,
      metaFlowId,
      flow.customization.businessName || 'Business'
    );

    flow.metaFlowStatus = 'published';
    flow.messageTemplateId = messageTemplateId || null;
    flow.templateApprovalStatus = messageTemplateId ? 'pending_approval' : 'unknown';
    flow.status = 'published';
    flow.publishedAt = new Date();
    await flow.save();

    logger.info(`[WhatsAppFormFlow] Published flow ${flow._id} to Meta as ${metaFlowId}`);

    return res.json({ success: true, data: flow });
  } catch (err) {
    logger.error('[WhatsAppFormFlow] Publish failed:', err.message);
    if (err?.name === 'EntitlementError') {
      return res.status(err.statusCode || 402).json({
        success: false,
        code: err.code,
        error: err.message,
        featureKey: err.featureKey
      });
    }
    // Meta's rejection reason is the only actionable part of a publish failure —
    // pass it through instead of collapsing it into a generic 500.
    return res.status(502).json({
      success: false,
      error: err.message || 'Could not publish this form to Meta.'
    });
  }
};

exports.deprecateFlow = async (req, res, next) => {
  try {
    const flow = await WhatsAppFormFlow.findOne({
      _id: req.params.id,
      organization: req.user.organization._id,
      status: 'published'
    });

    if (!flow || !flow.metaFlowId) {
      return res.status(404).json({
        success: false,
        error: 'Published flow not found'
      });
    }

    const connection = await resolveConnection(req.user.organization._id);

    await metaFlowService.deprecateFlow(connection, flow.metaFlowId);

    flow.status = 'deprecated';
    flow.deprecatedAt = new Date();
    await flow.save();

    logger.info(`[WhatsAppFormFlow] Deprecated flow ${flow._id}`);

    return res.json({ success: true, data: flow });
  } catch (err) {
    logger.error('[WhatsAppFormFlow] Deprecate failed:', err.message);
    next(err);
  }
};

async function createFlowButtonTemplate(organizationId, userId, connectionId, templateName, flowId, businessName) {
  try {
    const templateBody = `Hi {{1}}! We'd love to hear from you about your recent experience with ${businessName}.`;
    const payload = {
      name: templateName,
      category: 'UTILITY',
      language: 'en',
      parameter_format: 'POSITIONAL',
      components: [
        {
          type: 'BODY',
          text: templateBody
        },
        {
          type: 'BUTTONS',
          buttons: [
            {
              type: 'FLOW',
              text: 'Share Feedback',
              flowId: flowId
            }
          ]
        }
      ]
    };
    const result = await whatsappTemplateService.createTemplate(organizationId, userId, connectionId, payload);
    return result?._id || null;
  } catch (err) {
    logger.warn('[WhatsAppFormFlow] Template creation failed (non-fatal):', err.message);
    return null;
  }
}
