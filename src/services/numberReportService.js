/**
 * Number Report Service
 *
 * Aggregates per-connection (WhatsApp number) analytics:
 *   – Message volume (30-day time-series, inbound vs outbound)
 *   – Campaign performance (status breakdown, delivery/failure rates)
 *   – Template performance (top templates, usage count, delivery rate)
 *   – Sentiment breakdown (positive / neutral / negative)
 *   – Conversation funnel (total, resolved, auto-replied)
 *   – Overview KPIs
 */

const mongoose = require('mongoose');
const PlatformConnection = require('../models/PlatformConnection');
const Interaction = require('../models/Interaction');
const WhatsAppCampaign = require('../models/WhatsAppCampaign');
const WhatsAppCampaignRecipient = require('../models/WhatsAppCampaignRecipient');
const WhatsAppTemplate = require('../models/WhatsAppTemplate');

/**
 * Returns a full analytics report for a single WhatsApp number (PlatformConnection).
 * @param {string} orgId
 * @param {string} connectionId
 * @param {{ days?: number }} opts   – date range window, default 30 days
 */
async function getNumberReport(orgId, connectionId, opts = {}) {
  const days = Math.min(Math.max(parseInt(opts.days) || 30, 7), 90);
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const connOid = new mongoose.Types.ObjectId(connectionId);
  const orgOid  = new mongoose.Types.ObjectId(orgId);

  // Verify connection belongs to this org
  const connection = await PlatformConnection.findOne({
    _id: connOid,
    organization: orgOid,
    platform: 'whatsapp'
  }).select('platformDisplayName platformUsername platformData.displayPhoneNumber platformData.phoneNumber isActive').lean();

  if (!connection) {
    const err = new Error('Connection not found');
    err.statusCode = 404;
    throw err;
  }

  const [
    overview,
    volumeTimeSeries,
    campaignBreakdown,
    templatePerformance,
    sentimentBreakdown,
    conversationFunnel,
    recentCampaigns
  ] = await Promise.all([
    _overviewKpis(orgOid, connOid, since),
    _volumeTimeSeries(orgOid, connOid, since, days),
    _campaignBreakdown(orgOid, connOid, since),
    _templatePerformance(orgOid, connOid, since),
    _sentimentBreakdown(orgOid, connOid, since),
    _conversationFunnel(orgOid, connOid, since),
    _recentCampaigns(orgOid, connOid)
  ]);

  return {
    connection: {
      _id: connection._id,
      displayName: connection.platformDisplayName || connection.platformUsername || '',
      phone:
        connection.platformData?.displayPhoneNumber ||
        connection.platformData?.phoneNumber ||
        '',
      isActive: connection.isActive
    },
    period: { days, since },
    overview,
    volumeTimeSeries,
    campaignBreakdown,
    templatePerformance,
    sentimentBreakdown,
    conversationFunnel,
    recentCampaigns
  };
}

// ─── helpers ──────────────────────────────────────────────────────────────────

async function _overviewKpis(orgOid, connOid, since) {
  const [interactionStats, campaignStats] = await Promise.all([
    Interaction.aggregate([
      {
        $match: {
          organization: orgOid,
          platformConnection: connOid,
          platform: 'whatsapp',
          createdAt: { $gte: since }
        }
      },
      {
        $group: {
          _id: null,
          total: { $sum: 1 },
          inbound: { $sum: { $cond: [{ $eq: ['$direction', 'inbound'] }, 1, 0] } },
          outbound: { $sum: { $cond: [{ $eq: ['$direction', 'outbound'] }, 1, 0] } },
          autoReplied: { $sum: { $cond: ['$autoReplied', 1, 0] } },
          resolved: { $sum: { $cond: [{ $eq: ['$status', 'resolved'] }, 1, 0] } }
        }
      }
    ]),
    WhatsAppCampaign.aggregate([
      {
        $match: {
          organization: orgOid,
          connection: connOid,
          createdAt: { $gte: since }
        }
      },
      {
        $group: {
          _id: null,
          total: { $sum: 1 },
          totalSent: { $sum: '$stats.sent' },
          totalFailed: { $sum: '$stats.failed' },
          totalRecipients: { $sum: '$stats.total' }
        }
      }
    ])
  ]);

  const msg = interactionStats[0] || { total: 0, inbound: 0, outbound: 0, autoReplied: 0, resolved: 0 };
  const camp = campaignStats[0] || { total: 0, totalSent: 0, totalFailed: 0, totalRecipients: 0 };
  const deliveryRate = camp.totalRecipients > 0
    ? Math.round((camp.totalSent / camp.totalRecipients) * 100)
    : 0;

  return {
    totalMessages: msg.total,
    inboundMessages: msg.inbound,
    outboundMessages: msg.outbound,
    autoReplied: msg.autoReplied,
    resolvedConversations: msg.resolved,
    totalCampaigns: camp.total,
    campaignRecipients: camp.totalRecipients,
    campaignDelivered: camp.totalSent,
    campaignFailed: camp.totalFailed,
    deliveryRate
  };
}

async function _volumeTimeSeries(orgOid, connOid, since, days) {
  const rows = await Interaction.aggregate([
    {
      $match: {
        organization: orgOid,
        platformConnection: connOid,
        platform: 'whatsapp',
        createdAt: { $gte: since }
      }
    },
    {
      $group: {
        _id: {
          date: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
          direction: '$direction'
        },
        count: { $sum: 1 }
      }
    },
    { $sort: { '_id.date': 1 } }
  ]);

  // Build a full date map so days with 0 messages are included
  const dateMap = {};
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.now() - i * 24 * 60 * 60 * 1000);
    const key = d.toISOString().slice(0, 10);
    dateMap[key] = { date: key, inbound: 0, outbound: 0 };
  }

  for (const row of rows) {
    const { date, direction } = row._id;
    if (!dateMap[date]) dateMap[date] = { date, inbound: 0, outbound: 0 };
    if (direction === 'inbound') dateMap[date].inbound += row.count;
    else dateMap[date].outbound += row.count;
  }

  return Object.values(dateMap);
}

async function _campaignBreakdown(orgOid, connOid, since) {
  const rows = await WhatsAppCampaign.aggregate([
    {
      $match: {
        organization: orgOid,
        connection: connOid,
        createdAt: { $gte: since }
      }
    },
    {
      $group: {
        _id: '$status',
        count: { $sum: 1 },
        totalSent: { $sum: '$stats.sent' },
        totalFailed: { $sum: '$stats.failed' },
        totalRecipients: { $sum: '$stats.total' }
      }
    }
  ]);

  const byStatus = {};
  for (const r of rows) {
    byStatus[r._id] = {
      count: r.count,
      sent: r.totalSent,
      failed: r.totalFailed,
      recipients: r.totalRecipients
    };
  }
  return byStatus;
}

async function _templatePerformance(orgOid, connOid, since) {
  const rows = await WhatsAppCampaign.aggregate([
    {
      $match: {
        organization: orgOid,
        connection: connOid,
        status: { $in: ['completed', 'running', 'paused', 'failed'] },
        createdAt: { $gte: since },
        'templateSnapshot.name': { $exists: true }
      }
    },
    {
      $group: {
        _id: '$templateSnapshot.name',
        language: { $first: '$templateSnapshot.languageCode' },
        campaigns: { $sum: 1 },
        totalSent: { $sum: '$stats.sent' },
        totalFailed: { $sum: '$stats.failed' },
        totalRecipients: { $sum: '$stats.total' }
      }
    },
    { $sort: { totalRecipients: -1 } },
    { $limit: 10 }
  ]);

  return rows.map(r => ({
    name: r._id,
    language: r.language || 'en',
    campaigns: r.campaigns,
    totalRecipients: r.totalRecipients,
    delivered: r.totalSent,
    failed: r.totalFailed,
    deliveryRate: r.totalRecipients > 0
      ? Math.round((r.totalSent / r.totalRecipients) * 100)
      : 0
  }));
}

async function _sentimentBreakdown(orgOid, connOid, since) {
  const rows = await Interaction.aggregate([
    {
      $match: {
        organization: orgOid,
        platformConnection: connOid,
        platform: 'whatsapp',
        direction: 'inbound',
        sentiment: { $exists: true },
        createdAt: { $gte: since }
      }
    },
    {
      $group: {
        _id: '$sentiment',
        count: { $sum: 1 }
      }
    }
  ]);

  const result = { positive: 0, neutral: 0, negative: 0 };
  for (const r of rows) {
    if (r._id in result) result[r._id] = r.count;
  }
  return result;
}

async function _conversationFunnel(orgOid, connOid, since) {
  const rows = await Interaction.aggregate([
    {
      $match: {
        organization: orgOid,
        platformConnection: connOid,
        platform: 'whatsapp',
        direction: 'inbound',
        createdAt: { $gte: since }
      }
    },
    {
      $group: {
        _id: null,
        total: { $sum: 1 },
        replied: { $sum: { $cond: [{ $eq: ['$status', 'replied'] }, 1, 0] } },
        resolved: { $sum: { $cond: [{ $eq: ['$status', 'resolved'] }, 1, 0] } },
        autoReplied: { $sum: { $cond: ['$autoReplied', 1, 0] } },
        escalated: { $sum: { $cond: ['$requiresHumanResponse', 1, 0] } }
      }
    }
  ]);

  const r = rows[0] || { total: 0, replied: 0, resolved: 0, autoReplied: 0, escalated: 0 };
  return {
    total: r.total,
    replied: r.replied,
    resolved: r.resolved,
    autoReplied: r.autoReplied,
    escalated: r.escalated,
    unreplied: Math.max(0, r.total - r.replied - r.resolved)
  };
}

async function _recentCampaigns(orgOid, connOid) {
  return WhatsAppCampaign.find({ organization: orgOid, connection: connOid })
    .sort({ createdAt: -1 })
    .limit(5)
    .select('name status stats createdAt startedAt finishedAt templateSnapshot')
    .lean();
}

module.exports = { getNumberReport };
