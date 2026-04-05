const mongoose = require('mongoose');
const AiApiUsage = require('../models/AiApiUsage');

function parseDateStart(s) {
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

function parseDateEnd(s) {
  if (!s) return null;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  d.setHours(23, 59, 59, 999);
  return d;
}

function buildMatch(query) {
  const match = {};
  const orgId = query.organizationId || query.org;
  if (orgId && mongoose.Types.ObjectId.isValid(String(orgId))) {
    match.organization = new mongoose.Types.ObjectId(String(orgId));
  }
  if (query.feature) {
    match.feature = { $regex: escapeRegex(String(query.feature)), $options: 'i' };
  }
  if (query.apiKind) {
    match.apiKind = String(query.apiKind);
  }
  const start = parseDateStart(query.startDate || query.from);
  const end = parseDateEnd(query.endDate || query.to);
  if (start || end) {
    match.createdAt = {};
    if (start) match.createdAt.$gte = start;
    if (end) match.createdAt.$lte = end;
  }
  return match;
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * @param {Record<string, string>} query - organizationId, feature, apiKind, startDate, endDate, groupBy
 */
async function aggregateReport(query) {
  const match = buildMatch(query);
  const groupBy = (query.groupBy || 'feature').toLowerCase();

  let groupId;
  if (groupBy === 'organization') {
    groupId = { organization: '$organization' };
  } else if (groupBy === 'day') {
    groupId = {
      day: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } }
    };
  } else if (groupBy === 'feature_org') {
    groupId = { feature: '$feature', organization: '$organization' };
  } else {
    groupId = { feature: '$feature' };
  }

  const rows = await AiApiUsage.aggregate([
    { $match: match },
    {
      $group: {
        _id: groupId,
        calls: { $sum: 1 },
        promptTokens: { $sum: '$promptTokens' },
        completionTokens: { $sum: '$completionTokens' },
        totalTokens: { $sum: '$totalTokens' },
        estimatedUsd: { $sum: '$estimatedUsd' }
      }
    },
    { $sort: { estimatedUsd: -1 } }
  ]);

  const totals = await AiApiUsage.aggregate([
    { $match: match },
    {
      $group: {
        _id: null,
        calls: { $sum: 1 },
        promptTokens: { $sum: '$promptTokens' },
        completionTokens: { $sum: '$completionTokens' },
        totalTokens: { $sum: '$totalTokens' },
        estimatedUsd: { $sum: '$estimatedUsd' }
      }
    }
  ]);

  return {
    matchDescription: match,
    rows,
    totals: totals[0] || {
      calls: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      estimatedUsd: 0
    }
  };
}

/** Fields for list + CSV — exclude large prompt/completion snapshots */
const USAGE_SUMMARY_FIELDS =
  'organization user feature apiKind model promptTokens completionTokens totalTokens estimatedUsd applicationCreditsUsed creditOperation metadata createdAt updatedAt';

/**
 * Paginated call log for super-admin (no prompt bodies).
 */
async function listRecords(query) {
  const match = buildMatch(query);
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  let limit = parseInt(query.limit, 10) || 20;
  limit = Math.min(Math.max(1, limit), 100);
  const skip = (page - 1) * limit;

  const [total, items] = await Promise.all([
    AiApiUsage.countDocuments(match),
    AiApiUsage.find(match)
      .select(USAGE_SUMMARY_FIELDS)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate('organization', 'name slug')
      .populate('user', 'firstName lastName email')
      .lean()
  ]);

  return {
    items,
    pagination: {
      page,
      limit,
      total,
      pages: Math.ceil(total / limit) || 0
    }
  };
}

async function getRecordById(id) {
  if (!mongoose.Types.ObjectId.isValid(String(id))) return null;
  return AiApiUsage.findById(id)
    .populate('organization', 'name slug')
    .populate('user', 'firstName lastName email')
    .lean();
}

/**
 * Raw rows for CSV (limited)
 */
async function listRaw(query, limit = 5000) {
  const match = buildMatch(query);
  const lim = Math.min(Math.max(parseInt(query.limit, 10) || 5000, 1), 20000);
  return AiApiUsage.find(match)
    .select(USAGE_SUMMARY_FIELDS)
    .sort({ createdAt: -1 })
    .limit(lim)
    .lean();
}

function toCsv(rows) {
  const headers = [
    'createdAt',
    'organization',
    'feature',
    'apiKind',
    'model',
    'promptTokens',
    'completionTokens',
    'totalTokens',
    'estimatedUsd',
    'applicationCreditsUsed',
    'creditOperation'
  ];
  const lines = [headers.join(',')];
  for (const r of rows) {
    const vals = headers.map((h) => {
      let v = r[h];
      if (h === 'organization' && r.organization) v = String(r.organization);
      if (v == null) v = '';
      const s = String(v);
      if (s.includes(',') || s.includes('"') || s.includes('\n')) {
        return `"${s.replace(/"/g, '""')}"`;
      }
      return s;
    });
    lines.push(vals.join(','));
  }
  return lines.join('\n');
}

module.exports = {
  aggregateReport,
  listRecords,
  getRecordById,
  listRaw,
  toCsv,
  buildMatch
};
