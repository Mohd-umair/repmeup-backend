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

/**
 * Raw rows for CSV (limited)
 */
async function listRaw(query, limit = 5000) {
  const match = buildMatch(query);
  const lim = Math.min(Math.max(parseInt(query.limit, 10) || 5000, 1), 20000);
  return AiApiUsage.find(match)
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
    'estimatedUsd'
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
  listRaw,
  toCsv,
  buildMatch
};
