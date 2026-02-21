const Interaction = require('../models/Interaction');
const PlatformConnection = require('../models/PlatformConnection');
const User = require('../models/User');
const exportService = require('../services/exportService');

/**
 * Analytics Controller - Scalable analytics data aggregation
 * Optimized queries with caching and aggregation pipelines
 */

/**
 * Get analytics dashboard
 */
exports.getDashboard = async (req, res, next) => {
  try {
    const organizationId = req.user.organization._id;
    const { dateRange, platforms, types, sentiment, status } = req.body;

    // Parse date range
    const startDate = dateRange?.startDate ? new Date(dateRange.startDate) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const endDate = dateRange?.endDate ? new Date(dateRange.endDate) : new Date();

    // Build query filter
    const matchFilter = {
      organization: organizationId,
      platformCreatedAt: { $gte: startDate, $lte: endDate }
    };

    if (platforms && platforms.length > 0) {
      matchFilter.platform = { $in: platforms };
    }
    if (types && types.length > 0) {
      matchFilter.type = { $in: types };
    }
    if (sentiment && sentiment.length > 0) {
      matchFilter['sentiment'] = { $in: sentiment };
    }
    if (status && status.length > 0) {
      matchFilter.status = { $in: status };
    }

    // Parallel aggregation queries for performance
    const [
      totalInteractions,
      responseMetrics,
      platformMetrics,
      sentimentBreakdown,
      timeSeriesData,
      responseTimeMetrics
    ] = await Promise.all([
      // Total interactions count
      Interaction.countDocuments(matchFilter),

      // Response metrics
      Interaction.aggregate([
        { $match: matchFilter },
        {
          $group: {
            _id: null,
            totalResponded: {
              $sum: {
                $cond: [{ $gt: [{ $size: { $ifNull: ['$replies', []] } }, 0] }, 1, 0]
              }
            },
            totalResponseTime: {
              $sum: {
                $cond: [
                  { $and: [{ $ne: ['$respondedAt', null] }, { $ne: ['$platformCreatedAt', null] }] },
                  { $subtract: ['$respondedAt', '$platformCreatedAt'] },
                  0
                ]
              }
            },
            respondedCount: {
              $sum: {
                $cond: [{ $ne: ['$respondedAt', null] }, 1, 0]
              }
            }
          }
        }
      ]),

      // Platform-wise metrics
      Interaction.aggregate([
        { $match: matchFilter },
        {
          $group: {
            _id: '$platform',
            totalInteractions: { $sum: 1 },
            responded: {
              $sum: {
                $cond: [{ $gt: [{ $size: { $ifNull: ['$replies', []] } }, 0] }, 1, 0]
              }
            },
            pending: {
              $sum: {
                $cond: [{ $eq: [{ $size: { $ifNull: ['$replies', []] } }, 0] }, 1, 0]
              }
            },
            totalResponseTime: {
              $sum: {
                $cond: [
                  { $and: [{ $ne: ['$respondedAt', null] }, { $ne: ['$platformCreatedAt', null] }] },
                  { $subtract: ['$respondedAt', '$platformCreatedAt'] },
                  0
                ]
              }
            },
            respondedCount: {
              $sum: {
                $cond: [{ $ne: ['$respondedAt', null] }, 1, 0]
              }
            }
          }
        },
        {
          $project: {
            platform: '$_id',
            totalInteractions: 1,
            responded: 1,
            pending: 1,
            avgResponseTime: {
              $cond: [
                { $gt: ['$respondedCount', 0] },
                { $divide: ['$totalResponseTime', '$respondedCount'] },
                0
              ]
            }
          }
        }
      ]),

      // Sentiment breakdown
      Interaction.aggregate([
        { $match: matchFilter },
        {
          $group: {
            _id: '$sentiment',
            count: { $sum: 1 }
          }
        }
      ]),

      // Time series data (daily)
      Interaction.aggregate([
        { $match: matchFilter },
        {
          $group: {
            _id: {
              $dateToString: { format: '%Y-%m-%d', date: '$platformCreatedAt' }
            },
            interactions: { $sum: 1 },
            responses: {
              $sum: {
                $cond: [{ $gt: [{ $size: { $ifNull: ['$replies', []] } }, 0] }, 1, 0]
              }
            }
          }
        },
        { $sort: { _id: 1 } },
        {
          $project: {
            date: '$_id',
            interactions: 1,
            responses: 1,
            _id: 0
          }
        }
      ]),

      // Response time distribution
      Interaction.aggregate([
        {
          $match: {
            ...matchFilter,
            respondedAt: { $ne: null },
            platformCreatedAt: { $ne: null }
          }
        },
        {
          $project: {
            responseTime: {
              $divide: [
                { $subtract: ['$respondedAt', '$platformCreatedAt'] },
                60000 // Convert to minutes
              ]
            }
          }
        },
        {
          $facet: {
            stats: [
              {
                $group: {
                  _id: null,
                  avg: { $avg: '$responseTime' },
                  min: { $min: '$responseTime' },
                  max: { $max: '$responseTime' },
                  times: { $push: '$responseTime' }
                }
              }
            ],
            distribution: [
              {
                $bucket: {
                  groupBy: '$responseTime',
                  boundaries: [0, 60, 1440, Infinity],
                  default: 'over',
                  output: {
                    count: { $sum: 1 }
                  }
                }
              }
            ]
          }
        }
      ])
    ]);

    // Process response metrics
    const responseData = responseMetrics[0] || {
      totalResponded: 0,
      totalResponseTime: 0,
      respondedCount: 0
    };

    const responseRate = totalInteractions > 0
      ? (responseData.totalResponded / totalInteractions) * 100
      : 0;

    const avgResponseTime = responseData.respondedCount > 0
      ? responseData.totalResponseTime / responseData.respondedCount / 60000 // Convert to minutes
      : 0;

    // Process sentiment breakdown
    const sentimentData = {
      positive: 0,
      neutral: 0,
      negative: 0,
      total: totalInteractions
    };

    sentimentBreakdown.forEach(item => {
      if (item._id === 'positive') sentimentData.positive = item.count;
      else if (item._id === 'neutral') sentimentData.neutral = item.count;
      else if (item._id === 'negative') sentimentData.negative = item.count;
    });

    // Calculate sentiment score (0-100)
    const sentimentScore = totalInteractions > 0
      ? ((sentimentData.positive * 100 + sentimentData.neutral * 50) / totalInteractions)
      : 50;

    // Process response time metrics
    const responseTimeData = responseTimeMetrics[0];
    const stats = responseTimeData?.stats[0] || { avg: 0, min: 0, max: 0, times: [] };
    const distribution = responseTimeData?.distribution || [];

    // Calculate median
    const times = stats.times || [];
    times.sort((a, b) => a - b);
    const median = times.length > 0
      ? times.length % 2 === 0
        ? (times[times.length / 2 - 1] + times[times.length / 2]) / 2
        : times[Math.floor(times.length / 2)]
      : 0;

    // Distribution counts
    const within1Hour = distribution.find(d => d._id === 0)?.count || 0;
    const within24Hours = distribution.find(d => d._id === 60)?.count || 0;
    const over24Hours = distribution.find(d => d._id === 1440)?.count || 0;

    // Build dashboard response
    const dashboard = {
      dateRange: {
        startDate,
        endDate,
        preset: dateRange?.preset || 'custom'
      },
      overview: {
        totalInteractions: {
          label: 'Total Interactions',
          value: totalInteractions,
          icon: 'fas fa-comments',
          color: '#3B82F6',
          change: 0, // TODO: Calculate from previous period
          changeType: 'increase'
        },
        responseRate: {
          label: 'Response Rate',
          value: Math.round(responseRate),
          icon: 'fas fa-reply',
          color: '#10B981',
          change: 0,
          changeType: 'increase'
        },
        avgResponseTime: {
          label: 'Avg Response Time',
          value: Math.round(avgResponseTime),
          icon: 'fas fa-clock',
          color: '#F59E0B',
          change: 0,
          changeType: 'decrease'
        },
        sentimentScore: {
          label: 'Sentiment Score',
          value: Math.round(sentimentScore),
          icon: 'fas fa-smile',
          color: '#D0FF00',
          change: 0,
          changeType: 'increase'
        }
      },
      platformMetrics: platformMetrics.map(p => ({
        platform: p.platform,
        totalInteractions: p.totalInteractions,
        responded: p.responded,
        pending: p.pending,
        avgResponseTime: Math.round(p.avgResponseTime / 60000) // Convert to minutes
      })),
      timeSeries: timeSeriesData,
      sentimentBreakdown: sentimentData,
      responseTimeMetrics: {
        avg: Math.round(stats.avg || 0),
        median: Math.round(median),
        fastest: Math.round(stats.min || 0),
        slowest: Math.round(stats.max || 0),
        within1Hour,
        within24Hours,
        over24Hours
      }
    };

    res.status(200).json({
      success: true,
      data: dashboard
    });

  } catch (error) {
    console.error('❌ [Analytics] Dashboard error:', error);
    next(error);
  }
};

/**
 * Get platform-specific analytics
 */
exports.getPlatformAnalytics = async (req, res, next) => {
  try {
    const organizationId = req.user.organization._id;
    const { platform } = req.params;
    const { dateRange } = req.body;

    const startDate = dateRange?.startDate ? new Date(dateRange.startDate) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const endDate = dateRange?.endDate ? new Date(dateRange.endDate) : new Date();

    const analytics = await Interaction.aggregate([
      {
        $match: {
          organization: organizationId,
          platform,
          platformCreatedAt: { $gte: startDate, $lte: endDate }
        }
      },
      {
        $facet: {
          overview: [
            {
              $group: {
                _id: null,
                total: { $sum: 1 },
                responded: {
                  $sum: {
                    $cond: [{ $gt: [{ $size: { $ifNull: ['$replies', []] } }, 0] }, 1, 0]
                  }
                }
              }
            }
          ],
          byType: [
            {
              $group: {
                _id: '$type',
                count: { $sum: 1 }
              }
            }
          ],
          bySentiment: [
            {
              $group: {
                _id: '$sentiment',
                count: { $sum: 1 }
              }
            }
          ]
        }
      }
    ]);

    res.status(200).json({
      success: true,
      data: analytics[0]
    });

  } catch (error) {
    console.error('❌ [Analytics] Platform analytics error:', error);
    next(error);
  }
};

/**
 * Export analytics data (CSV / XLSX / PDF)
 */
exports.exportData = async (req, res, next) => {
  try {
    const organizationId = req.user.organization._id;
    const { dateRange, format = 'csv', reportType = 'platform', platforms } = req.body;

    const startDate = dateRange?.startDate ? new Date(dateRange.startDate) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const endDate = dateRange?.endDate ? new Date(dateRange.endDate) : new Date();

    const matchFilter = {
      organization: organizationId,
      platformCreatedAt: { $gte: startDate, $lte: endDate }
    };
    if (platforms?.length) matchFilter.platform = { $in: platforms };

    const fmtDate = (d) => d.toLocaleDateString('en-GB');
    const dateRangeLabel = { start: fmtDate(startDate), end: fmtDate(endDate) };

    let reportData, filename, contentType;

    if (reportType === 'agent') {
      // Reuse agent analytics aggregation
      const agentData = await _getAgentData(organizationId, startDate, endDate);
      const { csv, excelSheets, pdfSections } = exportService.formatAgentReport(agentData, dateRangeLabel);
      reportData = { csv, excelSheets, pdfSections, title: 'Agent Performance Report' };
    } else {
      // Default: fetch dashboard analytics
      const [platformMetrics, sentimentData, rtData] = await Promise.all([
        Interaction.aggregate([
          { $match: matchFilter },
          {
            $group: {
              _id: '$platform',
              totalInteractions: { $sum: 1 },
              responded: { $sum: { $cond: [{ $gt: [{ $size: { $ifNull: ['$replies', []] } }, 0] }, 1, 0] } },
              avgResponseTime: { $avg: '$responseTime' },
              avgSentiment: { $avg: { $switch: { branches: [{ case: { $eq: ['$sentiment', 'positive'] }, then: 100 }, { case: { $eq: ['$sentiment', 'negative'] }, then: 0 }], default: 50 } } }
            }
          },
          {
            $project: {
              platform: '$_id', _id: 0, totalInteractions: 1, responded: 1,
              pending: { $subtract: ['$totalInteractions', '$responded'] },
              avgResponseTime: { $ifNull: ['$avgResponseTime', 0] },
              sentimentScore: { $ifNull: [{ $round: ['$avgSentiment', 1] }, 50] }
            }
          }
        ]),
        Interaction.aggregate([
          { $match: matchFilter },
          {
            $group: {
              _id: '$sentiment',
              count: { $sum: 1 }
            }
          }
        ]),
        Interaction.aggregate([
          { $match: { ...matchFilter, responseTime: { $exists: true, $gt: 0 } } },
          {
            $group: {
              _id: null,
              avg: { $avg: '$responseTime' },
              median: { $avg: '$responseTime' },
              within1Hour: { $sum: { $cond: [{ $lte: ['$responseTime', 60] }, 1, 0] } },
              within24Hours: { $sum: { $cond: [{ $and: [{ $gt: ['$responseTime', 60] }, { $lte: ['$responseTime', 1440] }] }, 1, 0] } },
              over24Hours: { $sum: { $cond: [{ $gt: ['$responseTime', 1440] }, 1, 0] } }
            }
          }
        ])
      ]);

      const sentimentBreakdown = { positive: 0, neutral: 0, negative: 0, total: 0 };
      sentimentData.forEach(s => {
        if (s._id) sentimentBreakdown[s._id] = s.count;
        sentimentBreakdown.total += s.count;
      });

      const analytics = { platformMetrics, sentimentBreakdown, responseTimeMetrics: rtData[0] || {} };

      let formatted;
      if (reportType === 'sentiment') {
        formatted = exportService.formatSentimentReport(analytics, dateRangeLabel);
        reportData = { ...formatted, title: 'Sentiment Analysis Report' };
      } else if (reportType === 'response') {
        formatted = exportService.formatResponseReport(analytics, dateRangeLabel);
        reportData = { ...formatted, title: 'Response Performance Report' };
      } else {
        formatted = exportService.formatPlatformReport(analytics, dateRangeLabel);
        reportData = { ...formatted, title: 'Platform Comparison Report' };
      }
    }

    const safeName = reportData.title.replace(/\s+/g, '-').toLowerCase();

    if (format === 'csv') {
      contentType = 'text/csv; charset=utf-8';
      filename = `${safeName}-${Date.now()}.csv`;
      res.setHeader('Content-Type', contentType);
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      return res.send(reportData.csv);
    }

    if (format === 'xlsx') {
      contentType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
      filename = `${safeName}-${Date.now()}.xlsx`;
      const buffer = await exportService.generateExcel(reportData.title, reportData.excelSheets);
      res.setHeader('Content-Type', contentType);
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      return res.send(buffer);
    }

    if (format === 'pdf') {
      contentType = 'application/pdf';
      filename = `${safeName}-${Date.now()}.pdf`;
      const buffer = await exportService.generatePDF({
        title: reportData.title,
        dateRange: dateRangeLabel,
        sections: reportData.pdfSections
      });
      res.setHeader('Content-Type', contentType);
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      return res.send(buffer);
    }

    res.status(400).json({ success: false, error: 'Invalid export format. Use csv, xlsx, or pdf.' });

  } catch (error) {
    console.error('❌ [Analytics] Export error:', error);
    next(error);
  }
};

// ─── Internal helper ──────────────────────────────────────────────────────────
async function _getAgentData(organizationId, startDate, endDate) {
  const agentStats = await Interaction.aggregate([
    { $match: { organization: organizationId } },
    // Use the *most recent* of: updatedAt (assign/reply/resolve), createdAt, platformCreatedAt
    // so interactions that were assigned or resolved in the period are included
    {
      $addFields: {
        _computedDate: {
          $max: [
            { $ifNull: ['$updatedAt', new Date(0)] },
            { $ifNull: ['$resolvedAt', new Date(0)] },
            { $ifNull: ['$respondedAt', new Date(0)] },
            { $ifNull: ['$platformCreatedAt', new Date(0)] },
            { $ifNull: ['$createdAt', new Date(0)] }
          ]
        }
      }
    },
    { $match: { _computedDate: { $gte: startDate, $lte: endDate } } },
    // Attribute to assignedTo if set, else first reply's sentBy
    {
      $addFields: {
        effectiveAgentId: {
          $ifNull: [
            '$assignedTo',
            { $arrayElemAt: [ { $map: { input: { $ifNull: ['$replies', []] }, as: 'r', in: '$$r.sentBy' } }, 0 ] }
          ]
        },
        responseTimeMinutes: {
          $cond: [
            { $gt: [{ $ifNull: ['$firstResponseTime', 0] }, 0] },
            { $divide: ['$firstResponseTime', 60000] },
            null
          ]
        }
      }
    },
    { $match: { effectiveAgentId: { $exists: true, $ne: null } } },
    {
      $group: {
        _id: '$effectiveAgentId',
        totalAssigned: { $sum: 1 },
        totalResolved: {
          $sum: { $cond: [{ $in: ['$status', ['replied', 'resolved']] }, 1, 0] }
        },
        avgResponseTime: { $avg: '$responseTimeMinutes' },
        sentimentPositive: { $sum: { $cond: [{ $eq: ['$sentiment', 'positive'] }, 1, 0] } },
        sentimentNeutral: { $sum: { $cond: [{ $eq: ['$sentiment', 'neutral'] }, 1, 0] } },
        sentimentNegative: { $sum: { $cond: [{ $eq: ['$sentiment', 'negative'] }, 1, 0] } }
      }
    },
    {
      $lookup: { from: 'users', localField: '_id', foreignField: '_id', as: 'user' }
    },
    { $unwind: { path: '$user', preserveNullAndEmptyArrays: true } },
    {
      $project: {
        userId: '$_id', _id: 0,
        name: { $concat: [{ $ifNull: ['$user.firstName', 'Unknown'] }, ' ', { $ifNull: ['$user.lastName', ''] }] },
        totalAssigned: 1, totalResolved: 1,
        avgResponseTime: { $round: [{ $ifNull: ['$avgResponseTime', 0] }, 0] },
        sentimentBreakdown: { positive: '$sentimentPositive', neutral: '$sentimentNeutral', negative: '$sentimentNegative' },
        performanceScore: {
          $round: [{
            $multiply: [
              { $cond: [{ $gt: ['$totalAssigned', 0] }, { $divide: ['$totalResolved', '$totalAssigned'] }, 0] },
              100
            ]
          }, 1]
        }
      }
    },
    { $sort: { performanceScore: -1 } }
  ]);

  const totals = agentStats.reduce((acc, a) => {
    acc.totalResponseTime += a.avgResponseTime;
    acc.totalResolved += a.totalResolved;
    acc.totalAssigned += a.totalAssigned;
    return acc;
  }, { totalResponseTime: 0, totalResolved: 0, totalAssigned: 0 });

  const count = agentStats.length || 1;
  return {
    agents: agentStats,
    teamAverages: {
      avgResponseTime: Math.round(totals.totalResponseTime / count),
      resolutionRate: totals.totalAssigned ? +((totals.totalResolved / totals.totalAssigned) * 100).toFixed(1) : 0
    }
  };
}

/**
 * Agent Analytics endpoint
 */
exports.getAgentAnalytics = async (req, res, next) => {
  try {
    const organizationId = req.user.organization._id;
    const { dateRange, agentId } = req.body;
    const startDate = dateRange?.startDate ? new Date(dateRange.startDate) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const endDate = dateRange?.endDate ? new Date(dateRange.endDate) : new Date();

    const data = await _getAgentData(organizationId, startDate, endDate);

    if (agentId) {
      data.agents = data.agents.filter(a => String(a.userId) === String(agentId));
    }

    res.status(200).json({ success: true, data });
  } catch (error) {
    console.error('❌ [Analytics] Agent analytics error:', error);
    next(error);
  }
};

/**
 * Engagement Analytics endpoint
 */
exports.getEngagementAnalytics = async (req, res, next) => {
  try {
    const organizationId = req.user.organization._id;
    const { dateRange, platforms } = req.body;
    const startDate = dateRange?.startDate ? new Date(dateRange.startDate) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const endDate = dateRange?.endDate ? new Date(dateRange.endDate) : new Date();

    const matchFilter = {
      organization: organizationId,
      platformCreatedAt: { $gte: startDate, $lte: endDate }
    };
    if (platforms?.length) matchFilter.platform = { $in: platforms };

    const [overview, byPlatform, topInteractions, timeSeries] = await Promise.all([
      Interaction.aggregate([
        { $match: matchFilter },
        {
          $group: {
            _id: null,
            totalLikes: { $sum: { $ifNull: ['$engagement.likes', 0] } },
            totalShares: { $sum: { $ifNull: ['$engagement.shares', 0] } },
            totalViews: { $sum: { $ifNull: ['$engagement.views', 0] } },
            totalInteractions: { $sum: 1 }
          }
        }
      ]),
      Interaction.aggregate([
        { $match: matchFilter },
        {
          $group: {
            _id: '$platform',
            likes: { $sum: { $ifNull: ['$engagement.likes', 0] } },
            shares: { $sum: { $ifNull: ['$engagement.shares', 0] } },
            views: { $sum: { $ifNull: ['$engagement.views', 0] } },
            count: { $sum: 1 }
          }
        },
        {
          $project: {
            platform: '$_id', _id: 0, likes: 1, shares: 1, views: 1,
            engagementRate: {
              $cond: [{ $gt: ['$count', 0] },
                { $round: [{ $multiply: [{ $divide: [{ $add: ['$likes', '$shares'] }, '$count'] }, 100] }, 2] },
                0]
            }
          }
        },
        { $sort: { likes: -1 } }
      ]),
      Interaction.find(matchFilter)
        .sort({ 'engagement.likes': -1 })
        .limit(10)
        .select('platform content engagement.likes engagement.shares createdAt')
        .lean(),
      Interaction.aggregate([
        { $match: matchFilter },
        {
          $group: {
            _id: { $dateToString: { format: '%Y-%m-%d', date: '$platformCreatedAt' } },
            likes: { $sum: { $ifNull: ['$engagement.likes', 0] } },
            shares: { $sum: { $ifNull: ['$engagement.shares', 0] } },
            views: { $sum: { $ifNull: ['$engagement.views', 0] } }
          }
        },
        { $sort: { _id: 1 } },
        { $project: { date: '$_id', _id: 0, likes: 1, shares: 1, views: 1 } }
      ])
    ]);

    const ov = overview[0] || { totalLikes: 0, totalShares: 0, totalViews: 0, totalInteractions: 0 };
    const avgEngagementRate = ov.totalInteractions
      ? +((((ov.totalLikes + ov.totalShares) / ov.totalInteractions) * 100).toFixed(2))
      : 0;

    res.status(200).json({
      success: true,
      data: {
        overview: { ...ov, avgEngagementRate },
        byPlatform,
        topInteractions,
        timeSeries
      }
    });
  } catch (error) {
    console.error('❌ [Analytics] Engagement analytics error:', error);
    next(error);
  }
};

