'use strict';

/**
 * Super-admin read models for the Interakt integration.
 *
 * Read-only and platform-wide (no organization scope) — these endpoints sit behind
 * the super-admin gate in routes/super-admin/index.js. All queries use lean() and
 * bounded page sizes; the log collection grows with every onboarding attempt.
 */

const mongoose = require('mongoose');
const InteraktLog = require('../models/InteraktLog');
const PlatformConnection = require('../models/PlatformConnection');

const MAX_LIMIT = 100;

function toInt(v, fallback, max) {
  const n = parseInt(v, 10);
  if (Number.isNaN(n) || n < 1) return fallback;
  return max ? Math.min(n, max) : n;
}

/** Whitelisted filters — never build a query straight from req.query. */
function buildLogFilter(q = {}) {
  const filter = {};
  if (q.status && ['success', 'failed'].includes(q.status)) filter.status = q.status;
  if (q.direction && ['inbound', 'outbound'].includes(q.direction)) filter.direction = q.direction;
  if (q.action) filter.action = String(q.action).slice(0, 64);
  if (q.wabaId) filter.wabaId = String(q.wabaId).slice(0, 64);
  if (q.phoneNumberId) filter.phoneNumberId = String(q.phoneNumberId).slice(0, 64);
  if (q.organization && mongoose.Types.ObjectId.isValid(q.organization)) {
    filter.organization = new mongoose.Types.ObjectId(q.organization);
  }
  if (q.from || q.to) {
    filter.createdAt = {};
    if (q.from) filter.createdAt.$gte = new Date(q.from);
    if (q.to) filter.createdAt.$lte = new Date(q.to);
  }
  // Free-text across the fields an operator actually searches by.
  if (q.search) {
    const rx = new RegExp(String(q.search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').slice(0, 80), 'i');
    filter.$or = [{ reason: rx }, { wabaId: rx }, { phoneNumberId: rx }, { action: rx }];
  }
  return filter;
}

/** Paginated log list for the panel table. */
async function listLogs(query = {}) {
  const page = toInt(query.page, 1);
  const limit = toInt(query.limit, 25, MAX_LIMIT);
  const filter = buildLogFilter(query);

  const [rows, total] = await Promise.all([
    InteraktLog.find(filter)
      .select('-request -response')          // bodies only on the detail view
      .populate('organization', 'name slug')
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    InteraktLog.countDocuments(filter)
  ]);

  return { rows, total, page, limit, pages: Math.ceil(total / limit) || 1 };
}

/** Single log row including the sanitized request/response bodies. */
async function getLogById(id) {
  if (!mongoose.Types.ObjectId.isValid(id)) return null;
  return InteraktLog.findById(id)
    .populate('organization', 'name slug')
    .populate('platformConnection', 'platformUserId platformDisplayName status')
    .lean();
}

/** Headline counters + the most common failure reasons. */
async function getStats(query = {}) {
  const days = toInt(query.days, 30);
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const scope = { createdAt: { $gte: since } };

  const [byStatus, byAction, topReasons, connections] = await Promise.all([
    InteraktLog.aggregate([{ $match: scope }, { $group: { _id: '$status', count: { $sum: 1 } } }]),
    InteraktLog.aggregate([
      { $match: scope },
      { $group: { _id: { action: '$action', status: '$status' }, count: { $sum: 1 } } },
      { $sort: { count: -1 } }
    ]),
    InteraktLog.aggregate([
      { $match: { ...scope, status: 'failed', reason: { $ne: null } } },
      { $group: { _id: '$reason', count: { $sum: 1 }, lastSeen: { $max: '$createdAt' } } },
      { $sort: { count: -1 } },
      { $limit: 10 }
    ]),
    PlatformConnection.aggregate([
      { $match: { platform: 'whatsapp', 'platformData.provider': 'interakt' } },
      { $group: { _id: '$status', count: { $sum: 1 } } }
    ])
  ]);

  const statusMap = Object.fromEntries(byStatus.map((r) => [r._id, r.count]));
  const success = statusMap.success || 0;
  const failed = statusMap.failed || 0;
  const total = success + failed;

  return {
    windowDays: days,
    total,
    success,
    failed,
    successRate: total ? Math.round((success / total) * 1000) / 10 : null,
    byAction: byAction.map((r) => ({ action: r._id.action, status: r._id.status, count: r.count })),
    topFailureReasons: topReasons.map((r) => ({ reason: r._id, count: r.count, lastSeen: r.lastSeen })),
    interaktConnectionsByStatus: Object.fromEntries(connections.map((r) => [r._id, r.count]))
  };
}

/**
 * Every connected account across all organizations.
 *
 * Deliberately not WhatsApp-only: the panel's job is "show me every tenant's
 * connections", and support questions are rarely scoped to one channel up front.
 * accessToken is excluded at the query level so a credential can never reach the UI.
 */
async function listConnections(query = {}) {
  const page = toInt(query.page, 1);
  const limit = toInt(query.limit, 25, MAX_LIMIT);

  const filter = {};
  if (query.platform) filter.platform = String(query.platform).slice(0, 32);
  if (query.status) filter.status = String(query.status).slice(0, 32);
  if (query.provider === 'interakt' || query.provider === 'meta') {
    filter['platformData.provider'] = query.provider === 'interakt'
      ? 'interakt'
      : { $ne: 'interakt' };   // legacy rows have no provider field at all
  }
  if (query.organization && mongoose.Types.ObjectId.isValid(query.organization)) {
    filter.organization = new mongoose.Types.ObjectId(query.organization);
  }
  if (query.search) {
    const rx = new RegExp(String(query.search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').slice(0, 80), 'i');
    filter.$or = [{ platformDisplayName: rx }, { platformUserId: rx }, { platformUsername: rx }];
  }

  const [rows, total] = await Promise.all([
    PlatformConnection.find(filter)
      .select('-accessToken -refreshToken')   // never ship credentials to the panel
      .populate('organization', 'name slug')
      .populate('createdBy', 'firstName lastName email')
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    PlatformConnection.countDocuments(filter)
  ]);

  return {
    rows: rows.map((r) => ({
      _id: r._id,
      organization: r.organization,
      createdBy: r.createdBy,
      platform: r.platform,
      accountName: r.platformDisplayName || r.platformUsername || r.platformUserId,
      platformUserId: r.platformUserId,
      status: r.status,
      isActive: r.isActive,
      provider: r.platformData?.provider || 'meta',
      wabaId: r.platformData?.wabaId || r.platformData?.businessAccountId || null,
      phoneNumberId: r.platformData?.phoneNumberId || null,
      connectionType: r.metadata?.connectionType || null,
      interaktRegisteredAt: r.platformData?.interaktRegisteredAt || null,
      interaktWebhookConfiguredAt: r.platformData?.interaktWebhookConfiguredAt || null,
      interaktLastError: r.platformData?.interaktLastError || null,
      tokenExpiry: r.tokenExpiry || null,
      lastSyncAt: r.lastSyncAt || null,
      createdAt: r.createdAt
    })),
    total,
    page,
    limit,
    pages: Math.ceil(total / limit) || 1
  };
}

module.exports = { listLogs, getLogById, getStats, listConnections };
