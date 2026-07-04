const Joi = require('joi');
const Lead = require('../models/Lead');
const LeadActivity = require('../models/LeadActivity');

// validation.js keeps its objectId() helper private, so define our own
const objectId = () => Joi.string().hex().length(24);

function reject(res, error) {
  return res.status(400).json({ success: false, error: error.details[0].message });
}

function validateBody(schema) {
  return (req, res, next) => {
    const { error, value } = schema.validate(req.body, {
      abortEarly: true,
      stripUnknown: true
    });
    if (error) return reject(res, error);
    req.body = value;
    next();
  };
}

function validateQuery(schema) {
  return (req, res, next) => {
    const { error } = schema.validate(req.query, {
      abortEarly: true,
      allowUnknown: true
    });
    if (error) return reject(res, error);
    next();
  };
}

exports.validateLeadCreate = validateBody(
  Joi.object({
    name: Joi.string().trim().max(200).required(),
    email: Joi.string().trim().email().max(320).allow('').optional(),
    phone: Joi.string().trim().max(40).allow('').optional(),
    company: Joi.string().trim().max(200).allow('').optional(),
    priority: Joi.string().valid(...Lead.LEAD_PRIORITIES).optional(),
    estimatedValue: Joi.number().min(0).optional(),
    tags: Joi.array().items(Joi.string().trim().max(50)).max(20).optional(),
    assignedTo: objectId().allow(null, '').optional()
  }).or('email', 'phone')
);

exports.validateLeadUpdate = validateBody(
  Joi.object({
    name: Joi.string().trim().max(200).optional(),
    email: Joi.string().trim().email().max(320).allow('').optional(),
    phone: Joi.string().trim().max(40).allow('').optional(),
    company: Joi.string().trim().max(200).allow('').optional(),
    priority: Joi.string().valid(...Lead.LEAD_PRIORITIES).optional(),
    estimatedValue: Joi.number().min(0).optional(),
    tags: Joi.array().items(Joi.string().trim().max(50)).max(20).optional(),
    lostReason: Joi.string().trim().max(500).allow('').optional(),
    convertedToOrganization: objectId().allow(null, '').optional()
  }).min(1)
);

exports.validateLeadStatus = validateBody(
  Joi.object({
    status: Joi.string().valid(...Lead.LEAD_STATUSES).required(),
    lostReason: Joi.string().trim().max(500).allow('').optional()
  })
);

exports.validateLeadAssign = validateBody(
  Joi.object({
    userId: objectId().allow(null, '').required()
  })
);

exports.validateActivityCreate = validateBody(
  Joi.object({
    type: Joi.string().valid(...LeadActivity.USER_ACTIVITY_TYPES).required(),
    body: Joi.string().trim().min(1).max(5000).required(),
    isTask: Joi.boolean().default(false),
    dueAt: Joi.date().iso().when('isTask', {
      is: true,
      then: Joi.required(),
      otherwise: Joi.optional().allow(null)
    })
  })
);

exports.validateLeadListQuery = validateQuery(
  Joi.object({
    page: Joi.number().integer().min(1).optional(),
    limit: Joi.number().integer().min(1).max(100).optional(),
    search: Joi.string().max(100).allow('').optional(),
    status: Joi.string().valid(...Lead.LEAD_STATUSES).optional(),
    source: Joi.string().valid(...Lead.LEAD_SOURCES).optional(),
    priority: Joi.string().valid(...Lead.LEAD_PRIORITIES).optional(),
    assignedTo: Joi.alternatives().try(objectId(), Joi.valid('unassigned')).optional(),
    tag: Joi.string().max(50).optional(),
    dateFrom: Joi.date().iso().optional(),
    dateTo: Joi.date().iso().optional(),
    overdueOnly: Joi.string().valid('true', 'false').optional(),
    sortBy: Joi.string()
      .valid('createdAt', 'lastActivityAt', 'nextFollowUpAt', 'estimatedValue')
      .optional(),
    sortDir: Joi.string().valid('asc', 'desc').optional()
  })
);

exports.validateFollowUpsQuery = validateQuery(
  Joi.object({
    window: Joi.string().valid('overdue', 'today', 'week').optional(),
    page: Joi.number().integer().min(1).optional(),
    limit: Joi.number().integer().min(1).max(100).optional()
  })
);

exports.validateAnalyticsQuery = validateQuery(
  Joi.object({
    dateFrom: Joi.date().iso().optional(),
    dateTo: Joi.date().iso().optional(),
    interval: Joi.string().valid('day', 'week', 'month').optional(),
    groupBy: Joi.string().valid('source', 'status').optional()
  })
);
