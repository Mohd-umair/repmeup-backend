'use strict';

/**
 * Payment Analytics Service
 *
 * All aggregation runs in MongoDB. Angular receives pre-computed numbers — zero
 * processing on the frontend (per project rules).
 */

const Payment = require('../../models/Payment');
const Refund = require('../../models/Refund');
const PaymentIntegration = require('../../models/PaymentIntegration');
const PaymentEvent = require('../../models/PaymentEvent');
const logger = require('../../config/logger');

/**
 * High-level summary: total collected, pending, failed, refunded — scoped to
 * the org and an optional date/provider/channel/status filter.
 *
 * @param {string} organizationId
 * @param {object} filters  { from, to, provider, channel, status, currency }
 * @returns {object}
 */
async function getSummary(organizationId, filters = {}) {
  const match = _buildMatch(organizationId, filters);

  const [totals, byStatus, byCurrency] = await Promise.all([
    Payment.aggregate([
      { $match: match },
      {
        $group: {
          _id: null,
          totalAmount: { $sum: { $cond: [{ $eq: ['$status', 'paid'] }, '$amount', 0] } },
          pendingAmount: { $sum: { $cond: [{ $in: ['$status', ['created', 'pending', 'authorized']] }, '$amount', 0] } },
          refundedAmount: { $sum: '$refundedAmount' },
          totalCount: { $sum: 1 },
          paidCount: { $sum: { $cond: [{ $eq: ['$status', 'paid'] }, 1, 0] } },
          failedCount: { $sum: { $cond: [{ $eq: ['$status', 'failed'] }, 1, 0] } },
          expiredCount: { $sum: { $cond: [{ $eq: ['$status', 'expired'] }, 1, 0] } }
        }
      }
    ]),
    Payment.aggregate([
      { $match: match },
      { $group: { _id: '$status', count: { $sum: 1 }, amount: { $sum: '$amount' } } },
      { $sort: { count: -1 } }
    ]),
    Payment.aggregate([
      { $match: { ...match, status: 'paid' } },
      { $group: { _id: '$currency', amount: { $sum: '$amount' }, count: { $sum: 1 } } },
      { $sort: { amount: -1 } }
    ])
  ]);

  const t = totals[0] || {};
  return {
    totalCollected: t.totalAmount || 0,
    pendingAmount: t.pendingAmount || 0,
    refundedAmount: t.refundedAmount || 0,
    totalCount: t.totalCount || 0,
    paidCount: t.paidCount || 0,
    failedCount: t.failedCount || 0,
    expiredCount: t.expiredCount || 0,
    conversionRate: t.totalCount > 0 ? +(((t.paidCount || 0) / t.totalCount) * 100).toFixed(1) : 0,
    byStatus,
    byCurrency
  };
}

/**
 * Time-series: daily collected amounts for charting.
 * Returns [{date, amount, count}] sorted ascending.
 */
async function getTimeSeries(organizationId, filters = {}) {
  const match = _buildMatch(organizationId, { ...filters, status: 'paid' });

  const series = await Payment.aggregate([
    { $match: match },
    {
      $group: {
        _id: {
          year: { $year: '$paidAt' },
          month: { $month: '$paidAt' },
          day: { $dayOfMonth: '$paidAt' }
        },
        amount: { $sum: '$amount' },
        count: { $sum: 1 }
      }
    },
    { $sort: { '_id.year': 1, '_id.month': 1, '_id.day': 1 } },
    {
      $project: {
        _id: 0,
        date: {
          $dateToString: {
            format: '%Y-%m-%d',
            date: { $dateFromParts: { year: '$_id.year', month: '$_id.month', day: '$_id.day' } }
          }
        },
        amount: 1,
        count: 1
      }
    }
  ]);

  return series;
}

/**
 * Breakdown by provider — which gateway is generating most revenue.
 */
async function getByProvider(organizationId, filters = {}) {
  const match = _buildMatch(organizationId, filters);

  return Payment.aggregate([
    { $match: match },
    {
      $group: {
        _id: '$provider',
        totalAmount: { $sum: { $cond: [{ $eq: ['$status', 'paid'] }, '$amount', 0] } },
        paidCount: { $sum: { $cond: [{ $eq: ['$status', 'paid'] }, 1, 0] } },
        failedCount: { $sum: { $cond: [{ $eq: ['$status', 'failed'] }, 1, 0] } },
        totalCount: { $sum: 1 }
      }
    },
    { $sort: { totalAmount: -1 } }
  ]);
}

/**
 * Breakdown by channel — instagram vs whatsapp vs manual.
 */
async function getByChannel(organizationId, filters = {}) {
  const match = _buildMatch(organizationId, filters);

  return Payment.aggregate([
    { $match: match },
    {
      $group: {
        _id: '$channel',
        totalAmount: { $sum: { $cond: [{ $eq: ['$status', 'paid'] }, '$amount', 0] } },
        paidCount: { $sum: { $cond: [{ $eq: ['$status', 'paid'] }, 1, 0] } },
        totalCount: { $sum: 1 }
      }
    },
    { $sort: { totalAmount: -1 } }
  ]);
}

/**
 * Operational health: webhook failures, reconciliation drift, orphan captures.
 */
async function getOperationalHealth(organizationId) {
  const orgFilter = { organization: organizationId };
  const now = new Date();
  const oneDayAgo = new Date(now - 24 * 60 * 60 * 1000);
  const threeDaysAgo = new Date(now - 3 * 24 * 60 * 60 * 1000);

  const [
    integrations,
    recentWebhookErrors,
    pendingOld,
    expiredUnnotified
  ] = await Promise.all([
    PaymentIntegration.find({ ...orgFilter, status: 'connected' })
      .select('provider environment lastWebhookReceivedAt webhookFailureCount status')
      .lean(),
    PaymentEvent.countDocuments({
      organization: organizationId,
      normalizedEvent: { $regex: /^unknown\./i },
      receivedAt: { $gte: oneDayAgo }
    }),
    Payment.countDocuments({
      ...orgFilter,
      status: { $in: ['created', 'pending'] },
      createdAt: { $lte: threeDaysAgo }
    }),
    Payment.countDocuments({
      ...orgFilter,
      status: 'expired',
      updatedAt: { $gte: oneDayAgo }
    })
  ]);

  return {
    integrations: integrations.map((i) => ({
      provider: i.provider,
      environment: i.environment,
      status: i.status,
      lastWebhookAt: i.lastWebhookReceivedAt,
      webhookFailureCount: i.webhookFailureCount || 0,
      webhookHealthy: i.lastWebhookReceivedAt
        ? (now - new Date(i.lastWebhookReceivedAt)) < 48 * 60 * 60 * 1000
        : null
    })),
    recentUnknownWebhookEvents: recentWebhookErrors,
    pendingPaymentsOlderThan3Days: pendingOld,
    expiredLinksLast24h: expiredUnnotified
  };
}

/**
 * Top agents by payment requests created.
 */
async function getByAgent(organizationId, filters = {}) {
  const match = _buildMatch(organizationId, filters);

  return Payment.aggregate([
    { $match: { ...match, 'attribution.createdBy': { $ne: 'system' } } },
    {
      $group: {
        _id: '$attribution.agentId',
        totalAmount: { $sum: { $cond: [{ $eq: ['$status', 'paid'] }, '$amount', 0] } },
        paidCount: { $sum: { $cond: [{ $eq: ['$status', 'paid'] }, 1, 0] } },
        requestCount: { $sum: 1 }
      }
    },
    { $sort: { totalAmount: -1 } },
    { $limit: 20 }
  ]);
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function _buildMatch(organizationId, filters = {}) {
  const match = { organization: organizationId };

  if (filters.from || filters.to) {
    match.createdAt = {};
    if (filters.from) match.createdAt.$gte = new Date(filters.from);
    if (filters.to) match.createdAt.$lte = new Date(filters.to);
  }
  if (filters.provider) match.provider = filters.provider;
  if (filters.channel) match.channel = filters.channel;
  if (filters.status) match.status = filters.status;
  if (filters.currency) match.currency = String(filters.currency).toUpperCase();

  return match;
}

module.exports = {
  getSummary,
  getTimeSeries,
  getByProvider,
  getByChannel,
  getOperationalHealth,
  getByAgent
};
