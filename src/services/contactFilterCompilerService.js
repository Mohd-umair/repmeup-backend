'use strict';

const mongoose = require('mongoose');

const OPERATORS = new Set(['eq', 'neq', 'in', 'nin', 'gt', 'gte', 'lt', 'lte', 'contains', 'exists']);
const MAX_CONDITIONS = 50;
const MAX_DEPTH = 4;
const MAX_ARRAY_VALUES = 100;
const CUSTOM_FIELD_KEY = /^[a-zA-Z0-9_]{1,80}$/;

const FIELD_MAP = {
  platform: 'channels.platform',
  lifecycle: 'lifecycleStage',
  lifecycleStage: 'lifecycleStage',
  sentiment: 'aiInsights.sentiment',
  intent: 'aiInsights.intent',
  owner: 'owner',
  team: 'team',
  tags: 'tags',
  lastActivity: 'lastInteractionAt',
  lastInteractionAt: 'lastInteractionAt',
  ltv: 'commerceMetrics.totalSpent',
  orderCount: 'commerceMetrics.totalOrders',
  leadScore: 'intelligence.leadScore',
  healthScore: 'intelligence.healthScore',
  engagementScore: 'intelligence.engagementScore',
  churnRisk: 'intelligence.churnRisk',
  engagement: 'intelligence.engagementScore',
  city: 'shipping.city',
  location: 'shipping.city',
  company: 'company',
  doNotContact: 'communicationPreferences.doNotContact',
  marketingConsent: 'communicationPreferences.marketingConsent'
};

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function badFilter(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

function scalar(value, label = 'Filter value') {
  if (value instanceof mongoose.Types.ObjectId) return value;
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return value;
  throw badFilter(`${label} must be a scalar value`);
}

function booleanValue(value) {
  if (value === true || value === 'true' || value === 1 || value === '1') return true;
  if (value === false || value === 'false' || value === 0 || value === '0') return false;
  throw badFilter('exists requires a boolean value');
}

function lastActivityRange(value) {
  const now = new Date();
  if (value === 'today') {
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    return { $gte: start };
  }
  if (value === 'last_7_days' || value === 7) {
    return { $gte: new Date(now.getTime() - 7 * 86400000) };
  }
  if (value === 'last_30_days' || value === 30) {
    return { $gte: new Date(now.getTime() - 30 * 86400000) };
  }
  if (value && typeof value === 'object') {
    const range = {};
    if (value.from) range.$gte = new Date(value.from);
    if (value.to) range.$lte = new Date(value.to);
    return range;
  }
  return null;
}

function engagementScoreRange(value) {
  const bands = {
    highly_engaged: { $gte: 70 },
    medium: { $gte: 40, $lt: 70 },
    low: { $gte: 1, $lt: 40 },
    inactive: { $eq: 0 }
  };
  return bands[value] || null;
}

function toObjectId(value) {
  if (!value) return value;
  if (mongoose.Types.ObjectId.isValid(value)) return new mongoose.Types.ObjectId(value);
  return value;
}

function compileCondition(condition, depth = 0) {
  if (!condition || typeof condition !== 'object') return null;

  if (condition.logic && Array.isArray(condition.conditions)) {
    return compileFilterQuery(condition, depth + 1);
  }

  const { field, operator = 'eq', value } = condition;
  if (!field) return null;

  if (field.startsWith('custom.')) {
    const key = field.slice(7);
    if (!CUSTOM_FIELD_KEY.test(key)) throw badFilter('Invalid custom field key');
    return compileOperator(`customFields.${key}`, operator, value);
  }

  if (field === 'campaign') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw badFilter('Campaign filter requires campaignId and condition');
    }
    const campaignId = value.campaignId || value.id;
    const allowedConditions = new Set(['sent', 'delivered', 'read', 'replied', 'did_not_reply', 'failed']);
    if (!mongoose.Types.ObjectId.isValid(campaignId) || !allowedConditions.has(value.condition || value.status)) {
      throw badFilter('Invalid campaign filter');
    }
    return {
      _campaignFilter: {
        campaignId: String(campaignId),
        condition: value.condition || value.status
      }
    };
  }

  if (field === 'lastActivity' || field === 'lastInteractionAt') {
    if (!['eq', 'lte', 'gte'].includes(operator)) {
      throw badFilter('Last activity filter only supports eq, lte, or gte operators');
    }
    const range = lastActivityRange(value);
    if (!range) {
      throw badFilter('Last activity value must be today, last_7_days, or last_30_days');
    }
    return { lastInteractionAt: range };
  }

  if (field === 'engagement') {
    if (operator !== 'eq') {
      throw badFilter('Engagement filter only supports the eq operator');
    }
    const range = engagementScoreRange(value);
    if (!range) {
      throw badFilter('Engagement value must be highly_engaged, medium, low, or inactive');
    }
    return { 'intelligence.engagementScore': range };
  }

  const mongoField = FIELD_MAP[field];
  if (!mongoField) throw badFilter(`Unsupported contact filter field: ${field}`);
  return compileOperator(mongoField, operator, value);
}

function compileOperator(mongoField, operator, value) {
  if (!OPERATORS.has(operator)) throw badFilter(`Unsupported filter operator: ${operator}`);
  if (mongoField === 'owner' || mongoField === 'team') value = toObjectId(value);

  switch (operator) {
    case 'eq':
      return { [mongoField]: scalar(value) };
    case 'neq':
      return { [mongoField]: { $ne: scalar(value) } };
    case 'in': {
      const values = Array.isArray(value) ? value : [value];
      if (values.length > MAX_ARRAY_VALUES) throw badFilter('Too many filter values');
      return { [mongoField]: { $in: values.map((item) => scalar(item)) } };
    }
    case 'nin': {
      const values = Array.isArray(value) ? value : [value];
      if (values.length > MAX_ARRAY_VALUES) throw badFilter('Too many filter values');
      return { [mongoField]: { $nin: values.map((item) => scalar(item)) } };
    }
    case 'gt':
      return { [mongoField]: { $gt: Number(value) } };
    case 'gte':
      return { [mongoField]: { $gte: Number(value) } };
    case 'lt':
      return { [mongoField]: { $lt: Number(value) } };
    case 'lte':
      return { [mongoField]: { $lte: Number(value) } };
    case 'contains':
      return { [mongoField]: new RegExp(escapeRegex(String(scalar(value)).slice(0, 200)), 'i') };
    case 'exists': {
      const exists = booleanValue(value);
      return exists
        ? { [mongoField]: { $exists: true, $ne: null } }
        : { $or: [{ [mongoField]: { $exists: false } }, { [mongoField]: null }] };
    }
    default:
      return null;
  }
}

function compileFilterQuery(filterQuery, depth = 0) {
  if (!filterQuery || typeof filterQuery !== 'object') {
    return { mongo: {}, campaignFilters: [] };
  }
  if (depth > MAX_DEPTH) throw badFilter('Filter nesting is too deep');

  const logic = filterQuery.logic === 'OR' ? '$or' : '$and';
  const conditions = Array.isArray(filterQuery.conditions) ? filterQuery.conditions : [];
  if (conditions.length > MAX_CONDITIONS) throw badFilter('Too many filter conditions');
  const parts = [];
  const campaignFilters = [];

  for (const condition of conditions) {
    const compiled = compileCondition(condition, depth);
    if (!compiled) continue;
    if (compiled._campaignFilter) {
      campaignFilters.push(compiled._campaignFilter);
      continue;
    }
    if (compiled.mongo || compiled.campaignFilters) {
      if (compiled.mongo && Object.keys(compiled.mongo).length) parts.push(compiled.mongo);
      campaignFilters.push(...(compiled.campaignFilters || []));
      continue;
    }
    parts.push(compiled);
  }

  if (logic === '$or' && campaignFilters.length) {
    throw badFilter('Campaign activity filters cannot be used inside an OR group');
  }

  const mongo = parts.length === 0
    ? {}
    : parts.length === 1
      ? parts[0]
      : { [logic]: parts };

  return { mongo, campaignFilters };
}

function buildBaseQuery(orgId, filterQuery = null, extra = {}) {
  const { mongo, campaignFilters } = compileFilterQuery(filterQuery);
  const query = {
    organization: orgId,
    isDeleted: false,
    ...extra
  };
  if (mongo && Object.keys(mongo).length) {
    Object.assign(query, mongo.$and || mongo.$or ? { [mongo.$and ? '$and' : '$or']: mongo.$and || mongo.$or } : mongo);
  }
  return { query, campaignFilters };
}

function searchClause(search) {
  if (!search || !String(search).trim()) return null;
  const raw = String(search).trim().slice(0, 200);
  const escaped = escapeRegex(raw);
  const regex = new RegExp(escaped, 'i');
  const digits = raw.replace(/\D/g, '');
  const or = [
    { primaryName: regex },
    { primaryPhone: regex },
    { primaryEmail: regex },
    { company: regex },
    { tags: regex },
    { 'channels.username': regex },
    { 'channels.platformUserId': regex },
    { 'channels.name': regex }
  ];
  if (digits.length >= 6) {
    or.push({ primaryPhone: new RegExp(escapeRegex(digits), 'i') });
    or.push({ 'channels.platformUserId': new RegExp(escapeRegex(digits), 'i') });
  }
  return { $or: or };
}

module.exports = {
  compileFilterQuery,
  buildBaseQuery,
  searchClause,
  lastActivityRange
};
