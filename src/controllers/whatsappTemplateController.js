/**
 * WhatsApp Template Controller
 *
 * Thin HTTP layer — delegates all business logic to whatsappTemplateService.
 * Routes:
 *   POST   /api/whatsapp-templates             – create
 *   GET    /api/whatsapp-templates             – list (from Meta + DB sync)
 *   GET    /api/whatsapp-templates/:templateId – single template
 *   DELETE /api/whatsapp-templates/:templateId – delete
 */

const templateService = require('../services/whatsappTemplateService');

/**
 * @desc    Upload media for a template HEADER example (Meta Resumable Upload → handle `h`)
 * @route   POST /api/whatsapp-templates/upload-header-example
 * @access  Private  (multipart field: file, optional: connectionId)
 */
exports.uploadHeaderExample = async (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        error: 'No file uploaded. Send multipart field "file".'
      });
    }

    const connectionId = req.body?.connectionId
      ? String(req.body.connectionId).trim()
      : null;

    const { handle, fileType, suggestedHeaderFormat } = await templateService.uploadHeaderExampleAsset(
      req.user.organization._id,
      connectionId || null,
      req.file
    );

    res.status(200).json({
      success: true,
      handle,
      fileType,
      suggestedHeaderFormat
    });
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({
        success: false,
        error: error.message
      });
    }
    next(error);
  }
};

/**
 * @desc    Create a new WhatsApp message template on Meta
 * @route   POST /api/whatsapp-templates
 * @access  Private
 */
exports.createTemplate = async (req, res, next) => {
  try {
    const orgId = req.user.organization._id;
    const entitlementsService = require('../services/entitlementsService');
    const WhatsAppTemplate = require('../models/WhatsAppTemplate');
    const { FEATURE_KEYS } = require('../config/featureCatalog');
    const templateCount = await WhatsAppTemplate.countDocuments({ organization: orgId });
    await entitlementsService.assert(orgId.toString(), FEATURE_KEYS.WHATSAPP_TEMPLATES_MAX, templateCount + 1);

    const { connectionId, name, category, language, parameter_format, components } = req.body;

    const template = await templateService.createTemplate(
      req.user.organization._id,
      req.user._id,
      connectionId || null,
      { name, category, language, parameter_format, components }
    );

    res.status(201).json({
      success: true,
      data: template,
      message: 'Template submitted to Meta for review.'
    });
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({
        success: false,
        error: error.message,
        code: error.code || null,
        details: error.details || null
      });
    }
    next(error);
  }
};

/**
 * @desc    List all templates for the organisation (from Meta, DB-synced)
 * @route   GET /api/whatsapp-templates
 * @access  Private
 */
exports.listTemplates = async (req, res, next) => {
  try {
    const { connectionId, category } = req.query;

    const result = await templateService.listTemplates(
      req.user.organization._id,
      connectionId || null,
      { category: category || null }
    );

    res.status(200).json({ success: true, ...result });
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({
        success: false,
        error: error.message,
        code: error.code || null
      });
    }
    next(error);
  }
};

/**
 * @desc    Get a single template detail from Meta
 * @route   GET /api/whatsapp-templates/:templateId
 * @access  Private
 */
exports.getTemplate = async (req, res, next) => {
  try {
    const { connectionId } = req.query;

    const data = await templateService.getTemplate(
      req.user.organization._id,
      connectionId || null,
      req.params.templateId
    );

    res.status(200).json({ success: true, data });
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({
        success: false,
        error: error.message
      });
    }
    next(error);
  }
};

/**
 * @desc    Delete a template from Meta and soft-delete locally
 * @route   DELETE /api/whatsapp-templates/:templateId
 * @access  Private
 */
exports.deleteTemplate = async (req, res, next) => {
  try {
    // Accept name/connectionId from query string (DELETE body unreliable across proxies)
    const name = req.query.name || req.body?.name;
    const connectionId = req.query.connectionId || req.body?.connectionId;

    if (!name) {
      return res.status(400).json({
        success: false,
        error: 'Template name is required (query param ?name=) to delete.'
      });
    }

    await templateService.deleteTemplate(
      req.user.organization._id,
      connectionId || null,
      req.params.templateId,
      name
    );

    res.status(200).json({ success: true, message: 'Template deleted successfully.' });
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({
        success: false,
        error: error.message
      });
    }
    next(error);
  }
};
