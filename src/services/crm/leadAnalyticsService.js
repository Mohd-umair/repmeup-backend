const Lead = require('../../models/Lead');
const LeadActivity = require('../../models/LeadActivity');
const leadService = require('./leadService');

const TIMEZONE = 'Asia/Kolkata';

// $dateToString formats — portable across MongoDB versions (unlike $dateTrunc)
const PERIOD_FORMATS = {
  day: '%Y-%m-%d',
  week: '%G-W%V',
  month: '%Y-%m'
};

function buildDateMatch({ dateFrom, dateTo } = {}) {
  const createdAt = {};
  if (dateFrom) createdAt.$gte = new Date(dateFrom);
  if (dateTo) createdAt.$lte = new Date(dateTo);
  return Object.keys(createdAt).length ? { createdAt } : {};
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

/**
 * Headline numbers for the dashboard tiles + status/source breakdowns.
 * All derived values (winRate, percentages) are computed here so the
 * frontend only renders.
 */
async function getSummary(range = {}) {
  const match = { isDeleted: false, ...buildDateMatch(range) };

  const [facets] = await Lead.aggregate([
    { $match: match },
    {
      $facet: {
        byStatus: [
          { $group: { _id: '$status', count: { $sum: 1 }, value: { $sum: '$estimatedValue' } } }
        ],
        bySource: [
          { $group: { _id: '$source', count: { $sum: 1 } } },
          { $sort: { count: -1 } }
        ],
        totals: [
          {
            $group: {
              _id: null,
              total: { $sum: 1 },
              won: { $sum: { $cond: [{ $eq: ['$status', 'won'] }, 1, 0] } },
              lost: { $sum: { $cond: [{ $eq: ['$status', 'lost'] }, 1, 0] } },
              pipelineValue: {
                $sum: {
                  $cond: [{ $in: ['$status', leadService.OPEN_STATUSES] }, '$estimatedValue', 0]
                }
              },
              wonValue: { $sum: { $cond: [{ $eq: ['$status', 'won'] }, '$estimatedValue', 0] } }
            }
          }
        ]
      }
    }
  ]);

  const totals = facets.totals[0] || { total: 0, won: 0, lost: 0, pipelineValue: 0, wonValue: 0 };
  const decided = totals.won + totals.lost;
  const total = totals.total;

  const statusCounts = new Map(facets.byStatus.map((s) => [s._id, s]));
  const byStatus = leadService.STATUS_ORDER.map((status) => {
    const row = statusCounts.get(status) || { count: 0, value: 0 };
    return {
      status,
      count: row.count,
      value: row.value,
      pct: total ? round1((row.count / total) * 100) : 0
    };
  });

  const bySource = facets.bySource.map((s) => ({
    source: s._id,
    count: s.count,
    pct: total ? round1((s.count / total) * 100) : 0
  }));

  const overdueTasks = await LeadActivity.countDocuments({
    isTask: true,
    completedAt: null,
    dueAt: { $lt: new Date() }
  });

  return {
    total,
    won: totals.won,
    lost: totals.lost,
    open: total - decided,
    winRate: decided ? round1((totals.won / decided) * 100) : 0,
    pipelineValue: totals.pipelineValue,
    wonValue: totals.wonValue,
    overdueTasks,
    byStatus,
    bySource
  };
}

/**
 * Leads created over time, split by source or status. Returns zero-filled
 * periods plus 0-100 normalized bar heights so the chart template does no math.
 */
async function getTimeSeries({ interval = 'day', groupBy = 'source', dateFrom, dateTo } = {}) {
  const to = dateTo ? new Date(dateTo) : new Date();
  const from = dateFrom
    ? new Date(dateFrom)
    : new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000);

  const rows = await Lead.aggregate([
    { $match: { isDeleted: false, createdAt: { $gte: from, $lte: to } } },
    {
      $group: {
        _id: {
          period: {
            $dateToString: { format: PERIOD_FORMATS[interval], date: '$createdAt', timezone: TIMEZONE }
          },
          key: `$${groupBy}`
        },
        count: { $sum: 1 }
      }
    },
    { $sort: { '_id.period': 1 } }
  ]);

  const periods = [...new Set(rows.map((r) => r._id.period))].sort();
  const keys = [...new Set(rows.map((r) => r._id.key))].sort();

  const lookup = new Map(rows.map((r) => [`${r._id.period}|${r._id.key}`, r.count]));
  const totalsPerPeriod = periods.map((p) =>
    keys.reduce((sum, k) => sum + (lookup.get(`${p}|${k}`) || 0), 0)
  );
  const maxTotal = Math.max(1, ...totalsPerPeriod);

  const series = keys.map((key) => ({
    key,
    points: periods.map((p) => lookup.get(`${p}|${key}`) || 0)
  }));

  return {
    interval,
    groupBy,
    periods,
    series,
    totals: totalsPerPeriod.map((count) => ({
      count,
      heightPct: round1((count / maxTotal) * 100)
    }))
  };
}

/**
 * Reached-stage funnel. A lead "reached" a stage if it was created at that
 * stage (system activity meta.initialStatus) or moved into it later
 * (status_change meta.to). Two indexed queries + a JS set merge — exact and
 * cheap at platform-lead volume (thousands); revisit with $unionWith at scale.
 */
async function getFunnel(range = {}) {
  const leadIds = (
    await Lead.find({ isDeleted: false, ...buildDateMatch(range) }).select('_id').lean()
  ).map((l) => l._id);

  const reached = new Map(leadService.STATUS_ORDER.map((s) => [s, new Set()]));

  if (leadIds.length) {
    const [creations, transitions] = await Promise.all([
      LeadActivity.find({
        lead: { $in: leadIds },
        type: 'system',
        'meta.initialStatus': { $exists: true }
      })
        .select('lead meta.initialStatus')
        .lean(),
      LeadActivity.aggregate([
        { $match: { lead: { $in: leadIds }, type: 'status_change' } },
        { $group: { _id: { lead: '$lead', to: '$meta.to' } } }
      ])
    ]);

    for (const c of creations) {
      const set = reached.get(c.meta.initialStatus);
      if (set) set.add(String(c.lead));
    }
    for (const t of transitions) {
      const set = reached.get(t._id.to);
      if (set) set.add(String(t._id.lead));
    }
  }

  const total = leadIds.length;
  let prevCount = null;
  const stages = leadService.STATUS_ORDER.filter((s) => s !== 'lost').map((status) => {
    const count = reached.get(status).size;
    const stage = {
      status,
      count,
      pctOfTotal: total ? round1((count / total) * 100) : 0,
      // null when there is no meaningful previous-stage base (first stage or empty prev)
      conversionFromPrev:
        prevCount === null || prevCount === 0 ? null : round1((count / prevCount) * 100)
    };
    prevCount = count;
    return stage;
  });

  return { total, lost: reached.get('lost').size, stages };
}

/**
 * Average days spent in each stage, from durationMs written at transition time.
 */
async function getTimeInStage() {
  const rows = await LeadActivity.aggregate([
    { $match: { type: 'status_change', 'meta.durationMs': { $gt: 0 } } },
    {
      $group: {
        _id: '$meta.from',
        avgMs: { $avg: '$meta.durationMs' },
        transitions: { $sum: 1 }
      }
    }
  ]);

  const byStage = new Map(rows.map((r) => [r._id, r]));
  return leadService.STATUS_ORDER.filter((s) => s !== 'won' && s !== 'lost').map((status) => {
    const row = byStage.get(status);
    return {
      status,
      avgDays: row ? round1(row.avgMs / (24 * 60 * 60 * 1000)) : null,
      transitions: row ? row.transitions : 0
    };
  });
}

module.exports = { getSummary, getTimeSeries, getFunnel, getTimeInStage };
