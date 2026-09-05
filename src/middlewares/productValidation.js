'use strict';

/**
 * Route-boundary validation for product create/update (Joi, same pattern as
 * middlewares/validation.js). Commerce field rules live in
 * utils/productCommerceFields.js — single source of truth shared with the
 * model and the lenient import coercer.
 */

const Joi = require('joi');
const { buildCommerceJoiSchema, DEFAULT_CURRENCY } = require('../utils/productCommerceFields');

const stringArray = () => Joi.array().items(Joi.string().trim().max(500)).max(100);

const baseFields = {
  name: Joi.string().trim().max(200),
  sku: Joi.string().trim().max(100).allow(''),
  description: Joi.string().trim().max(9999).allow(''),
  price: Joi.number().min(0),
  currency: Joi.string().trim().uppercase().pattern(/^[A-Z]{3}$/)
    .message('currency must be a 3-letter ISO code (e.g. INR)'),
  discountPercent: Joi.number().min(0).max(100),
  images: stringArray(),
  paymentUrl: Joi.string().trim().uri({ scheme: ['http', 'https'] }).max(2048).allow(''),
  websiteUrl: Joi.string().trim().uri({ scheme: 'https' }).max(2048).allow('')
    .messages({ 'string.uriCustomScheme': 'websiteUrl must be an https:// URL' }),
  sizes: stringArray(),
  colors: stringArray(),
  stock: Joi.number().integer().min(0).allow(null),
  commerce: buildCommerceJoiSchema()
};

function respondInvalid(res, error) {
  return res.status(400).json({
    success: false,
    error: error.details.map((d) => d.message).join('; ')
  });
}

/** Strip ''-valued keys so they don't overwrite stored values with blanks (commerce only). */
function pruneEmptyCommerce(value) {
  if (!value || typeof value.commerce !== 'object' || value.commerce === null) return value;
  const cleaned = {};
  for (const [k, v] of Object.entries(value.commerce)) {
    if (v === '' || v == null) continue;
    if (typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date)) {
      const inner = Object.fromEntries(Object.entries(v).filter(([, iv]) => iv !== '' && iv != null));
      if (Object.keys(inner).length) cleaned[k] = inner;
      continue;
    }
    cleaned[k] = v;
  }
  value.commerce = Object.keys(cleaned).length ? cleaned : undefined;
  return value;
}

exports.validateProductCreate = (req, res, next) => {
  const schema = Joi.object({
    ...baseFields,
    name: baseFields.name.required(),
    price: baseFields.price.required(),
    currency: baseFields.currency.default(DEFAULT_CURRENCY)
  }).options({ stripUnknown: true });

  const { error, value } = schema.validate(req.body || {}, { abortEarly: false });
  if (error) return respondInvalid(res, error);
  req.body = pruneEmptyCommerce(value);
  next();
};

exports.validateProductUpdate = (req, res, next) => {
  const schema = Joi.object({
    ...baseFields,
    isActive: Joi.boolean()
  }).options({ stripUnknown: true });

  const { error, value } = schema.validate(req.body || {}, { abortEarly: false });
  if (error) return respondInvalid(res, error);
  req.body = pruneEmptyCommerce(value);
  next();
};
