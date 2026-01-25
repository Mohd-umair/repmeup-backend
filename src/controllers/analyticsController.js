const Interaction = require('../models/Interaction');
const PlatformConnection = require('../models/PlatformConnection');

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
      matchFilter['aiAnalysis.sentiment'] = { $in: sentiment };
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
                  { $and: [{ $ne: ['$repliedAt', null] }, { $ne: ['$platformCreatedAt', null] }] },
                  { $subtract: ['$repliedAt', '$platformCreatedAt'] },
                  0
                ]
              }
            },
            respondedCount: {
              $sum: {
                $cond: [{ $ne: ['$repliedAt', null] }, 1, 0]
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
                  { $and: [{ $ne: ['$repliedAt', null] }, { $ne: ['$platformCreatedAt', null] }] },
                  { $subtract: ['$repliedAt', '$platformCreatedAt'] },
                  0
                ]
              }
            },
            respondedCount: {
              $sum: {
                $cond: [{ $ne: ['$repliedAt', null] }, 1, 0]
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
            _id: '$aiAnalysis.sentiment',
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
            repliedAt: { $ne: null },
            platformCreatedAt: { $ne: null }
          }
        },
        {
          $project: {
            responseTime: {
              $divide: [
                { $subtract: ['$repliedAt', '$platformCreatedAt'] },
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
                _id: '$aiAnalysis.sentiment',
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
 * Export analytics data
 */
exports.exportData = async (req, res, next) => {
  try {
    const organizationId = req.user.organization._id;
    const { dateRange, format } = req.body;

    // TODO: Implement export logic based on format (csv, xlsx, pdf)
    // For now, return a placeholder

    res.status(200).json({
      success: true,
      message: `Export as ${format} will be available soon`
    });

  } catch (error) {
    console.error('❌ [Analytics] Export error:', error);
    next(error);
  }
};

