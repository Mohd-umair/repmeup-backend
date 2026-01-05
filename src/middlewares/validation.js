const Joi = require('joi');

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
    content: Joi.string().required(),
    useTemplate: Joi.boolean().optional(),
    templateId: Joi.string().optional(),
    templateVariables: Joi.object().optional()
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

// Validate label creation
exports.validateLabel = (req, res, next) => {
  const schema = Joi.object({
    name: Joi.string().required(),
    color: Joi.string().pattern(/^#[0-9A-F]{6}$/i).required(),
    description: Joi.string().optional(),
    icon: Joi.string().optional()
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
    category: Joi.string().optional(),
    title: Joi.string().required(),
    content: Joi.string().required(),
    keywords: Joi.array().items(Joi.string()).optional(),
    trainingContext: Joi.string().optional(),
    trainingWeight: Joi.number().min(1).max(10).optional()
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

// Validate response template
exports.validateResponseTemplate = (req, res, next) => {
  const schema = Joi.object({
    name: Joi.string().required(),
    content: Joi.string().required(),
    category: Joi.string().optional(),
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

  next();
};

