'use strict';

const CustomFieldDefinition = require('../models/CustomFieldDefinition');

function slugKey(label) {
  return String(label || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 80);
}

async function list(orgId) {
  return CustomFieldDefinition.find({ organization: orgId }).sort({ order: 1, createdAt: 1 }).lean();
}

async function create(orgId, body) {
  const key = body.key || slugKey(body.label);
  if (!/^[a-zA-Z0-9_]{1,80}$/.test(key)) {
    throw Object.assign(new Error('Custom field key may contain only letters, numbers, and underscores'), { status: 400 });
  }
  const options = Array.isArray(body.options)
    ? body.options.slice(0, 100).map((option) => String(option).trim().slice(0, 120)).filter(Boolean)
    : [];
  return CustomFieldDefinition.create({
    organization: orgId,
    key,
    label: body.label,
    type: body.type,
    options,
    required: Boolean(body.required),
    order: Number(body.order) || 0
  });
}

async function update(orgId, id, body) {
  const doc = await CustomFieldDefinition.findOne({ _id: id, organization: orgId });
  if (!doc) return null;
  if (body.label !== undefined) doc.label = body.label;
  if (body.type !== undefined) doc.type = body.type;
  if (body.options !== undefined) {
    doc.options = Array.isArray(body.options)
      ? body.options.slice(0, 100).map((option) => String(option).trim().slice(0, 120)).filter(Boolean)
      : [];
  }
  if (body.required !== undefined) doc.required = body.required;
  if (body.order !== undefined) doc.order = body.order;
  await doc.save();
  return doc;
}

async function validateContactValues(orgId, values) {
  if (!values || typeof values !== 'object' || Array.isArray(values)) {
    throw Object.assign(new Error('customFields must be an object'), { status: 400 });
  }
  const definitions = await CustomFieldDefinition.find({ organization: orgId }).lean();
  const byKey = new Map(definitions.map((definition) => [definition.key, definition]));
  const sanitized = {};
  for (const [key, raw] of Object.entries(values)) {
    const definition = byKey.get(key);
    if (!definition) throw Object.assign(new Error(`Unknown custom field: ${key}`), { status: 400 });
    if (raw == null || raw === '') {
      sanitized[key] = null;
      continue;
    }
    if (['number', 'currency'].includes(definition.type)) {
      const number = Number(raw);
      if (!Number.isFinite(number)) throw Object.assign(new Error(`${definition.label} must be a number`), { status: 400 });
      sanitized[key] = number;
    } else if (definition.type === 'boolean') {
      if (![true, false, 'true', 'false'].includes(raw)) {
        throw Object.assign(new Error(`${definition.label} must be true or false`), { status: 400 });
      }
      sanitized[key] = raw === true || raw === 'true';
    } else if (definition.type === 'date') {
      const date = new Date(raw);
      if (Number.isNaN(date.getTime())) throw Object.assign(new Error(`${definition.label} must be a valid date`), { status: 400 });
      sanitized[key] = date;
    } else if (definition.type === 'dropdown') {
      const value = String(raw).slice(0, 500);
      if (definition.options.length && !definition.options.includes(value)) {
        throw Object.assign(new Error(`${definition.label} has an invalid option`), { status: 400 });
      }
      sanitized[key] = value;
    } else if (definition.type === 'multiselect') {
      const selected = Array.isArray(raw) ? raw.slice(0, 100).map(String) : [];
      if (!Array.isArray(raw) || selected.some((value) => !definition.options.includes(value))) {
        throw Object.assign(new Error(`${definition.label} has invalid options`), { status: 400 });
      }
      sanitized[key] = selected;
    } else {
      sanitized[key] = String(raw).slice(0, 2000);
    }
  }
  return sanitized;
}

async function remove(orgId, id) {
  return CustomFieldDefinition.deleteOne({ _id: id, organization: orgId });
}

module.exports = { list, create, update, remove, slugKey, validateContactValues };
