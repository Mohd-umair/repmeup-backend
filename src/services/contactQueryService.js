'use strict';

const mongoose = require('mongoose');
const Contact = require('../models/Contact');
const ContactActivity = require('../models/ContactActivity');
const { compileFilterQuery, searchClause } = require('./contactFilterCompilerService');

const SORT_FIELDS = {
  lastInteractionAt: 'lastInteractionAt',
  createdAt: 'createdAt',
  primaryName: 'primaryName',
  lifecycleStage: 'lifecycleStage',
  healthScore: 'intelligence.healthScore',
  leadScore: 'intelligence.leadScore',
  engagementScore: 'intelligence.engagementScore',
  totalSpent: 'commerceMetrics.totalSpent'
};

function mergeQuery(orgId, filterQuery, extra = {}) {
  const { mongo, campaignFilters } = compileFilterQuery(filterQuery);
  const query = { organization: orgId, isDeleted: false, ...extra };
  if (mongo && Object.keys(mongo).length) {
    if (mongo.$and) query.$and = [...(query.$and || []), ...mongo.$and];
    else if (mongo.$or) query.$and = [...(query.$and || []), { $or: mongo.$or }];
    else Object.assign(query, mongo);
  }
  return { query, campaignFilters };
}

async function applyCampaignFilters(orgId, query, campaignFilters) {
  if (!campaignFilters.length) return query;
  const Campaign = require('../models/Campaign');
  const idsSets = [];
  for (const spec of campaignFilters) {
    const campaignId = spec.campaignId || spec.id || spec;
    const owned = await Campaign.exists({ _id: campaignId, organization: orgId });
    if (!owned) {
      idsSets.push([]);
      continue;
    }
    const condition = spec.condition || spec.status || 'sent';
    const typeMap = {
      sent: 'campaign_sent',
      delivered: 'campaign_delivered',
      read: 'campaign_read',
      replied: 'campaign_replied',
      failed: 'campaign_failed'
    };
    if (condition === 'did_not_reply') {
      const sent = await ContactActivity.distinct('contact', {
        organization: orgId,
        relatedCampaign: campaignId,
        type: 'campaign_sent'
      });
      const replied = await ContactActivity.distinct('contact', {
        organization: orgId,
        relatedCampaign: campaignId,
        type: 'campaign_replied'
      });
      const repliedSet = new Set(replied.map(String));
      idsSets.push(sent.filter((id) => !repliedSet.has(String(id))));
      continue;
    }
    const type = typeMap[condition] || 'campaign_sent';
    const ids = await ContactActivity.distinct('contact', {
      organization: orgId,
      relatedCampaign: campaignId,
      type
    });
    idsSets.push(ids);
  }
  if (!idsSets.length) return query;
  let intersection = idsSets[0].map(String);
  for (let i = 1; i < idsSets.length; i++) {
    const next = new Set(idsSets[i].map(String));
    intersection = intersection.filter((id) => next.has(id));
  }
  query._id = { $in: intersection };
  return query;
}

async function listContacts({
  orgId,
  search,
  filterQuery,
  platform,
  tag,
  lifecycleStage,
  owner,
  page = 1,
  limit = 20,
  sortField = 'lastInteractionAt',
  sortDir = 'desc'
}) {
  const extra = {};
  if (platform) extra['channels.platform'] = platform;
  if (tag) extra.tags = tag;
  if (lifecycleStage) extra.lifecycleStage = lifecycleStage;
  if (owner) extra.owner = owner;

  const { query, campaignFilters } = mergeQuery(orgId, filterQuery, extra);
  const searchPart = searchClause(search);
  if (searchPart) {
    query.$and = [...(query.$and || []), searchPart];
  }
  await applyCampaignFilters(orgId, query, campaignFilters);

  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
  const skip = (pageNum - 1) * limitNum;
  const sortKey = SORT_FIELDS[sortField] || 'lastInteractionAt';
  const sort = { [sortKey]: sortDir === 'asc' ? 1 : -1, createdAt: -1 };

  const [contacts, total] = await Promise.all([
    Contact.find(query)
      .select('-shippingAddress -mergedFrom')
      .populate('owner', 'firstName lastName email')
      .sort(sort)
      .skip(skip)
      .limit(limitNum)
      .lean(),
    Contact.countDocuments(query)
  ]);

  return {
    contacts,
    pagination: { total, page: pageNum, limit: limitNum, pages: Math.ceil(total / limitNum) }
  };
}

async function countContacts({ orgId, search, filterQuery, extra = {} }) {
  const { query, campaignFilters } = mergeQuery(orgId, filterQuery, extra);
  const searchPart = searchClause(search);
  if (searchPart) query.$and = [...(query.$and || []), searchPart];
  await applyCampaignFilters(orgId, query, campaignFilters);
  return Contact.countDocuments(query);
}

async function findContactIds({ orgId, filterQuery, contactIds, extra = {}, search, limit = 100000 }) {
  if (Array.isArray(contactIds) && contactIds.length) {
    const validIds = contactIds
      .slice(0, 5000)
      .filter((id) => mongoose.Types.ObjectId.isValid(id));
    const rows = await Contact.find({
      _id: { $in: validIds },
      organization: orgId,
      isDeleted: false
    }).select('_id').lean();
    return rows.map((r) => r._id);
  }
  const { query, campaignFilters } = mergeQuery(orgId, filterQuery, extra);
  const searchPart = searchClause(search);
  if (searchPart) query.$and = [...(query.$and || []), searchPart];
  await applyCampaignFilters(orgId, query, campaignFilters);
  const safeLimit = Math.min(100000, Math.max(1, Number(limit) || 100000));
  const rows = await Contact.find(query).select('_id').limit(safeLimit).lean();
  return rows.map((r) => r._id);
}

function emptyFilter() {
  return { logic: 'AND', conditions: [] };
}

module.exports = {
  listContacts,
  countContacts,
  findContactIds,
  applyCampaignFilters,
  mergeQuery,
  emptyFilter
};
