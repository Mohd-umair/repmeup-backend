const Joi = require('joi');
const { sanitizeString } = require('../utils/sanitize');

const objectId = () => Joi.string().pattern(/^[0-9a-fA-F]{24}$/);
const dateRange = () => Joi.object({
  startDate: Joi.date().optional(),
  endDate: Joi.date().optional()
}).optional();

// Validate registration
exports.validateRegistration = (req, res, next) => {
  const schema = Joi.object({
    email: Joi.string().email().required(),
    password: Joi.string().min(6).required(),
    firstName: Joi.string().required(),
    lastName: Joi.string().required(),
    organizationName: Joi.string().required(),
    role: Joi.string().valid('admin', 'manager', 'agent', 'viewer').optional()
  });

  const { error } = schema.validate(req.body);
  
  if (error) {
    return res.status(400).json({
      success: false,
      error: error.details[0].message
    });
  }

  next();
};

// Validate login
exports.validateLogin = (req, res, next) => {
  const schema = Joi.object({
    email: Joi.string().email().required(),
    password: Joi.string().required()
  });

  const { error } = schema.validate(req.body);
  
  if (error) {
    return res.status(400).json({
      success: false,
      error: error.details[0].message
    });
  }

  next();
};

// Validate interaction reply
exports.validateReply = (req, res, next) => {
  const schema = Joi.object({
    content: Joi.string().allow('').max(10000).optional(),
    useTemplate: Joi.boolean().optional(),
    templateId: objectId().optional(),
    templateVariables: Joi.object().optional(),
    attachmentUrl: Joi.string().uri({ scheme: ['http', 'https', 'data'] }).optional(),
    attachmentType: Joi.string().valid('image', 'video', 'file', 'audio').optional()
  });

  const { error } = schema.validate(req.body);
  
  if (error) {
    return res.status(400).json({
      success: false,
      error: error.details[0].message
    });
  }

  const hasContent = typeof req.body.content === 'string' && req.body.content.trim().length > 0;
  const hasAttachment = req.body.attachmentUrl && req.body.attachmentType;
  if (!hasContent && !hasAttachment) {
    return res.status(400).json({
      success: false,
      error: 'Either content or attachment (attachmentUrl + attachmentType) is required'
    });
  }

  /* Plain text for JSON API — do not HTML-escape (shows as &quot; in Angular {{ }}) */
  if (req.body.content && typeof req.body.content === 'string') {
    req.body.content = req.body.content.trim();
  }
  next();
};

// Validate label creation
exports.validateLabel = (req, res, next) => {
  const schema = Joi.object({
    name: Joi.string().required().max(100),
    color: Joi.string().pattern(/^#[0-9A-F]{6}$/i).required(),
    description: Joi.string().max(500).optional(),
    icon: Joi.string().max(50).optional()
  });

  const { error } = schema.validate(req.body);
  
  if (error) {
    return res.status(400).json({
      success: false,
      error: error.details[0].message
    });
  }

  next();
};

// Validate knowledge base entry
exports.validateKnowledgeBase = (req, res, next) => {
  const schema = Joi.object({
    type: Joi.string().valid('faq', 'product_info', 'policy', 'brand_voice', 'procedure').required(),
    category: Joi.string().max(200).optional(),
    title: Joi.string().required().max(500),
    content: Joi.string().required().max(100000),
    keywords: Joi.array().items(Joi.string().max(100)).max(50).optional(),
    trainingContext: Joi.string().max(5000).optional(),
    trainingWeight: Joi.number().min(1).max(10).optional()
  });

  const { error } = schema.validate(req.body);
  
  if (error) {
    return res.status(400).json({
      success: false,
      error: error.details[0].message
    });
  }

  // Sanitize string fields for safe storage/reflection
  if (req.body.title) req.body.title = sanitizeString(req.body.title, { maxLength: 500 });
  if (req.body.content) req.body.content = sanitizeString(req.body.content, { maxLength: 100000 });
  if (req.body.category) req.body.category = sanitizeString(req.body.category, { maxLength: 200 });
  if (Array.isArray(req.body.keywords)) req.body.keywords = req.body.keywords.map(k => sanitizeString(k, { maxLength: 100 }));
  if (req.body.trainingContext) req.body.trainingContext = sanitizeString(req.body.trainingContext, { maxLength: 5000 });
  next();
};

// Validate response template
exports.validateResponseTemplate = (req, res, next) => {
  const schema = Joi.object({
    name: Joi.string().required().max(200),
    content: Joi.string().required().max(10000),
    category: Joi.string().max(100).optional(),
    applicableFor: Joi.object({
      platforms: Joi.array().items(Joi.string().valid('instagram', 'facebook', 'whatsapp', 'youtube', 'google', 'website')).optional(),
      types: Joi.array().items(Joi.string().valid('comment', 'dm', 'review', 'mention')).optional(),
      sentiments: Joi.array().items(Joi.string().valid('positive', 'negative', 'neutral')).optional()
    }).optional()
  });

  const { error } = schema.validate(req.body);
  
  if (error) {
    return res.status(400).json({
      success: false,
      error: error.details[0].message
    });
  }

  if (req.body.name) req.body.name = sanitizeString(req.body.name, { maxLength: 200 });
  if (req.body.content) req.body.content = sanitizeString(req.body.content, { maxLength: 10000 });
  if (req.body.category) req.body.category = sanitizeString(req.body.category, { maxLength: 100 });
  next();
};

// Validate knowledge base manual create (no type required; source=manual)
exports.validateKnowledgeBaseManual = (req, res, next) => {
  const schema = Joi.object({
    type: Joi.string().valid('faq', 'product_info', 'policy', 'brand_voice', 'procedure', 'general').optional(),
    category: Joi.string().max(200).optional(),
    title: Joi.string().required().max(500),
    content: Joi.string().required().max(100000),
    tags: Joi.array().items(Joi.string().max(100)).max(50).optional(),
    priority: Joi.number().min(1).max(10).optional(),
    metadata: Joi.object().optional()
  }).options({ stripUnknown: true });

  const { error } = schema.validate(req.body);
  if (error) return res.status(400).json({ success: false, error: error.details[0].message });
  if (req.body.title) req.body.title = sanitizeString(req.body.title, { maxLength: 500 });
  if (req.body.content) req.body.content = sanitizeString(req.body.content, { maxLength: 100000 });
  if (req.body.category) req.body.category = sanitizeString(req.body.category, { maxLength: 200 });
  if (Array.isArray(req.body.tags)) req.body.tags = req.body.tags.map(t => sanitizeString(t, { maxLength: 100 }));
  next();
};

// Validate knowledge base update (partial)
exports.validateKnowledgeBaseUpdate = (req, res, next) => {
  const schema = Joi.object({
    title: Joi.string().max(500).optional(),
    content: Joi.string().max(100000).optional(),
    category: Joi.string().max(200).optional(),
    tags: Joi.array().items(Joi.string().max(100)).max(50).optional(),
    priority: Joi.number().min(1).max(10).optional(),
    metadata: Joi.object().optional(),
    isActive: Joi.boolean().optional()
  }).options({ stripUnknown: true }).min(1);

  const { error } = schema.validate(req.body);
  if (error) return res.status(400).json({ success: false, error: error.details[0].message });
  if (req.body.title) req.body.title = sanitizeString(req.body.title, { maxLength: 500 });
  if (req.body.content) req.body.content = sanitizeString(req.body.content, { maxLength: 100000 });
  if (req.body.category) req.body.category = sanitizeString(req.body.category, { maxLength: 200 });
  if (Array.isArray(req.body.tags)) req.body.tags = req.body.tags.map(t => sanitizeString(t, { maxLength: 100 }));
  next();
};

// --- Analytics ---
const platformList = ['instagram', 'facebook', 'whatsapp', 'youtube', 'google', 'website'];
const typeList = ['comment', 'dm', 'review', 'mention', 'post'];
const sentimentList = ['positive', 'negative', 'neutral'];
const statusList = ['unread', 'read', 'replied', 'resolved', 'archived', 'spam', 'assigned', 'pending'];

exports.validateAnalyticsDashboard = (req, res, next) => {
  const schema = Joi.object({
    dateRange: dateRange(),
    platforms: Joi.array().items(Joi.string().valid(...platformList)).optional(),
    types: Joi.array().items(Joi.string().valid(...typeList)).optional(),
    sentiment: Joi.array().items(Joi.string().valid(...sentimentList)).optional(),
    status: Joi.array().items(Joi.string().valid(...statusList)).optional()
  }).options({ stripUnknown: true });

  const { error } = schema.validate(req.body);
  if (error) return res.status(400).json({ success: false, error: error.details[0].message });
  next();
};

exports.validateAnalyticsExport = (req, res, next) => {
  const schema = Joi.object({
    dateRange: dateRange(),
    format: Joi.string().valid('csv', 'xlsx', 'pdf').optional(),
    reportType: Joi.string().valid('platform', 'agent').optional(),
    platforms: Joi.array().items(Joi.string().valid(...platformList)).optional()
  }).options({ stripUnknown: true });

  const { error } = schema.validate(req.body);
  if (error) return res.status(400).json({ success: false, error: error.details[0].message });
  next();
};

exports.validateAnalyticsAgents = (req, res, next) => {
  const schema = Joi.object({
    dateRange: dateRange(),
    agentId: objectId().optional()
  }).options({ stripUnknown: true });

  const { error } = schema.validate(req.body);
  if (error) return res.status(400).json({ success: false, error: error.details[0].message });
  next();
};

exports.validateAnalyticsEngagement = (req, res, next) => {
  const schema = Joi.object({
    dateRange: dateRange(),
    platforms: Joi.array().items(Joi.string().valid(...platformList)).optional()
  }).options({ stripUnknown: true });

  const { error } = schema.validate(req.body);
  if (error) return res.status(400).json({ success: false, error: error.details[0].message });
  next();
};

exports.validateAnalyticsPlatform = (req, res, next) => {
  const schema = Joi.object({
    dateRange: dateRange()
  }).options({ stripUnknown: true });

  const { error } = schema.validate(req.body);
  if (error) return res.status(400).json({ success: false, error: error.details[0].message });
  next();
};

// --- Organization update ---
exports.validateOrganizationUpdate = (req, res, next) => {
  const schema = Joi.object({
    name: Joi.string().max(200).optional(),
    industry: Joi.string().max(100).optional(),
    size: Joi.string().max(50).optional(),
    logo: Joi.string().max(500).allow('').optional(),
    whiteLabel: Joi.object().optional(),
    autoReplySettings: Joi.object().optional(),
    inboxSettings: Joi.object().optional()
  }).options({ stripUnknown: true });

  const { error } = schema.validate(req.body);
  if (error) return res.status(400).json({ success: false, error: error.details[0].message });
  next();
};

// --- Users ---
exports.validateUserCreate = (req, res, next) => {
  const schema = Joi.object({
    email: Joi.string().email().required(),
    password: Joi.string().min(6).max(128).required(),
    firstName: Joi.string().required().max(100),
    lastName: Joi.string().required().max(100),
    role: Joi.string().valid('admin', 'manager', 'agent', 'viewer').optional()
  }).options({ stripUnknown: true });

  const { error } = schema.validate(req.body);
  if (error) return res.status(400).json({ success: false, error: error.details[0].message });
  next();
};

exports.validateUserUpdate = (req, res, next) => {
  const schema = Joi.object({
    firstName: Joi.string().max(100).optional(),
    lastName: Joi.string().max(100).optional(),
    role: Joi.string().valid('admin', 'manager', 'agent', 'viewer').optional(),
    isActive: Joi.boolean().optional(),
    preferences: Joi.object().optional()
  }).options({ stripUnknown: true });

  const { error } = schema.validate(req.body);
  if (error) return res.status(400).json({ success: false, error: error.details[0].message });
  next();
};

// --- Inbox ---
exports.validateInboxAssign = (req, res, next) => {
  const schema = Joi.object({
    userId: Joi.alternatives().try(objectId(), Joi.string().valid('')).optional(),
    reason: Joi.string().max(500).optional()
  }).options({ stripUnknown: true });

  const { error } = schema.validate(req.body);
  if (error) return res.status(400).json({ success: false, error: error.details[0].message });
  if (req.body.reason && typeof req.body.reason === 'string') {
    req.body.reason = req.body.reason.trim();
  }
  next();
};

exports.validateInboxAddLabel = (req, res, next) => {
  const schema = Joi.object({
    labelId: objectId().required()
  }).options({ stripUnknown: true });

  const { error } = schema.validate(req.body);
  if (error) return res.status(400).json({ success: false, error: error.details[0].message });
  next();
};

exports.validateInboxAddNote = (req, res, next) => {
  const schema = Joi.object({
    note: Joi.string().required().max(5000),
    isPrivate: Joi.boolean().optional()
  }).options({ stripUnknown: true });

  const { error } = schema.validate(req.body);
  if (error) return res.status(400).json({ success: false, error: error.details[0].message });
  if (req.body.note && typeof req.body.note === 'string') {
    req.body.note = req.body.note.trim();
  }
  next();
};

exports.validateInboxUpdateStatus = (req, res, next) => {
  const schema = Joi.object({
    status: Joi.string().valid('unread', 'read', 'replied', 'resolved', 'archived', 'spam').required()
  }).options({ stripUnknown: true });

  const { error } = schema.validate(req.body);
  if (error) return res.status(400).json({ success: false, error: error.details[0].message });
  next();
};

exports.validateInboxBulkAssign = (req, res, next) => {
  const schema = Joi.object({
    interactionIds: Joi.array().items(objectId()).min(1).required(),
    userId: objectId().required()
  }).options({ stripUnknown: true });

  const { error } = schema.validate(req.body);
  if (error) return res.status(400).json({ success: false, error: error.details[0].message });
  next();
};

exports.validateInboxBulkStatus = (req, res, next) => {
  const schema = Joi.object({
    interactionIds: Joi.array().items(objectId()).min(1).required(),
    status: Joi.string().valid('unread', 'read', 'replied', 'resolved', 'archived', 'spam').required()
  }).options({ stripUnknown: true });

  const { error } = schema.validate(req.body);
  if (error) return res.status(400).json({ success: false, error: error.details[0].message });
  next();
};

exports.validateInboxBulkLabel = (req, res, next) => {
  const schema = Joi.object({
    interactionIds: Joi.array().items(objectId()).min(1).required(),
    labelId: objectId().required()
  }).options({ stripUnknown: true });

  const { error } = schema.validate(req.body);
  if (error) return res.status(400).json({ success: false, error: error.details[0].message });
  next();
};

exports.validateInboxAutoReplyGenerate = (req, res, next) => {
  const schema = Joi.object({
    interactionIds: Joi.array().items(objectId()).optional(),
    autoSend: Joi.boolean().optional()
  }).options({ stripUnknown: true });

  const { error } = schema.validate(req.body);
  if (error) return res.status(400).json({ success: false, error: error.details[0].message });
  next();
};

exports.validateInboxEscalate = (req, res, next) => {
  const schema = Joi.object({
    reason: Joi.string().max(500).optional()
  }).options({ stripUnknown: true });

  const { error } = schema.validate(req.body);
  if (error) return res.status(400).json({ success: false, error: error.details[0].message });
  if (req.body.reason && typeof req.body.reason === 'string') {
    req.body.reason = req.body.reason.trim();
  }
  next();
};

// --- Media library ---
exports.validateMediaUpdate = (req, res, next) => {
  const schema = Joi.object({
    tags: Joi.array().items(Joi.string().max(50)).max(20).optional(),
    description: Joi.string().max(1000).optional()
  }).options({ stripUnknown: true });

  const { error } = schema.validate(req.body);
  if (error) return res.status(400).json({ success: false, error: error.details[0].message });
  if (Array.isArray(req.body.tags)) req.body.tags = req.body.tags.map(t => sanitizeString(t, { maxLength: 50 }));
  if (req.body.description) req.body.description = sanitizeString(req.body.description, { maxLength: 1000 });
  next();
};

