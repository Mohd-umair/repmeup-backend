/**
 * Analytics Service
 *
 * Single source of truth for analytics aggregations and DTO shaping.
 * Controllers call the orchestrators here; caching + HTTP concerns stay in
 * the controller so this module is pure and fully unit-testable.
 *
 * Structure
 * ─────────
 *   1. Filter builders    — buildMatchFilter, buildPrevMatchFilter
 *   2. Pure math helpers  — calcChange, computeResponseRate, etc.
 *   3. Aggregation fns    — one per Mongo pipeline, each named for what it
 *                           returns (not for the endpoint that uses it)
 *   4. Orchestrators      — getDashboardData, getPlatformAnalyticsData,
 *                           getEngagementAnalyticsData, getAgentData,
 *                           getExportData, getContentPerformanceData
 *
 * Invariants
 * ──────────
 *   - Every aggregation is scoped to the caller organizationId.
 *   - No HTTP, no caching, no logging side-effects — that stays in the
 *     controller so each function here is a pure (ish) DB query.
 *   - DTO shape of getDashboardData, getPlatformAnalyticsData, etc. is a
 *     public contract — frontend depends on it. Don't rename fields
 *     without coordinating with the UI.
 */

const mongoose = require('mongoose');
const Interaction = require('../models/Interaction');
const ProductOrder = require('../models/ProductOrder');
const ScheduledPost = require('../models/ScheduledPost');

/**
 * Always return a Mongoose ObjectId from whatever form `id` arrives in.
 *
 * WHY THIS EXISTS
 * ───────────────
 * The `protect` middleware caches `req.user` in Redis.  When the cached copy
 * is deserialised from JSON, every ObjectId field becomes a plain *string*.
 * Mongoose's `countDocuments()` / `findOne()` apply schema-level casting and
 * silently coerce "string" → ObjectId, so those queries still work.
 * Mongoose's `aggregate()` however does NOT cast — it passes the raw JS value
 * straight to the MongoDB driver.  A `$match: { organization: "stringId" }`
 * stage will match ZERO documents because MongoDB stores ObjectIds, not
 * strings, so the strict comparison fails.
 *
 * Wrapping every organizationId used in an aggregation pipeline with this
 * helper guarantees type safety regardless of whether the value originated
 * from a fresh DB fetch (ObjectId) or a Redis cache hit (string).
 */
function toObjectId(id) {
  if (id instanceof mongoose.Types.ObjectId) return id;
  return new mongoose.Types.ObjectId(String(id));
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. Filter builders
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Build the $match stage used by most dashboard / engagement queries.
 *
 * @param {string|object} organizationId
 * @param {object}  [filters]
 * @param {Date}    filters.startDate
 * @param {Date}    filters.endDate
 * @param {string[]} [filters.platforms]
 * @param {string[]} [filters.types]
 * @param {string[]} [filters.sentiment]
 * @param {string[]} [filters.status]
 */
function buildMatchFilter(organizationId, filters = {}) {
  const { startDate, endDate, platforms, types, sentiment, status } = filters;
  const f = {
    organization: toObjectId(organizationId),
    platformCreatedAt: { $gte: startDate, $lte: endDate }
  };
  if (platforms?.length) f.platform = { $in: platforms };
  if (types?.length) f.type = { $in: types };
  if (sentiment?.length) f.sentiment = { $in: sentiment };
  if (status?.length) f.status = { $in: status };
  return f;
}

/**
 * Shift the date window backwards by its own length to produce the
 * previous-period filter for change calculations.
 */
function buildPrevMatchFilter(matchFilter) {
  const { $gte: start, $lte: end } = matchFilter.platformCreatedAt;
  const periodMs = end.getTime() - start.getTime();
  return {
    ...matchFilter,
    platformCreatedAt: {
      $gte: new Date(start.getTime() - periodMs),
      $lte: start
    }
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// 2. Pure math helpers
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Percentage change between two numbers. Returns a 1-decimal number.
 *   - previous == 0 && current > 0 → 100 (100% growth from nothing)
 *   - previous == 0 && current == 0 → 0
 */
function calcChange(current, previous) {
  if (previous === 0) return current > 0 ? 100 : 0;
  return +((((current - previous) / previous) * 100).toFixed(1));
}

/** response-rate percentage (0-100). */
function computeResponseRate(totalInteractions, totalResponded) {
  return totalInteractions > 0 ? (totalResponded / totalInteractions) * 100 : 0;
}

/** Avg response time in minutes. Caller-provided metrics are in ms. */
function computeAvgResponseTime(totalResponseTime, respondedCount) {
  return respondedCount > 0 ? totalResponseTime / respondedCount / 60000 : 0;
}

/**
 * Milliseconds from customer message → first response.
 * Uses first reply at/after the customer message (not stale thread replies),
 * valid respondedAt, stored firstResponseTime, and DM last inbound timestamp.
 */
const RESPONSE_TIME_MS_EXPR = {
  $let: {
    vars: {
      platformAt: { $ifNull: ['$platformCreatedAt', '$createdAt'] },
      lastInbound: {
        $let: {
          vars: {
            lastMsg: { $arrayElemAt: [{ $ifNull: ['$metadata.incomingMessages', []] }, -1] }
          },
          in: {
            $cond: [
              { $ifNull: ['$$lastMsg.timestamp', false] },
              { $toDate: '$$lastMsg.timestamp' },
              null
            ]
          }
        }
      },
      storedMs: { $ifNull: ['$firstResponseTime', 0] }
    },
    in: {
      $let: {
        vars: {
          baseline: {
            $cond: [
              {
                $and: [
                  { $eq: ['$type', 'dm'] },
                  { $ne: ['$$lastInbound', null] },
                  { $gt: ['$$lastInbound', '$$platformAt'] }
                ]
              },
              '$$lastInbound',
              '$$platformAt'
            ]
          }
        },
        in: {
          $let: {
            vars: {
              repliesAfterBaseline: {
                $filter: {
                  input: { $ifNull: ['$replies', []] },
                  as: 'reply',
                  cond: {
                    $and: [
                      { $ne: ['$$reply.sentAt', null] },
                      { $gte: ['$$reply.sentAt', '$$baseline'] }
                    ]
                  }
                }
              }
            },
            in: {
              $let: {
                vars: {
                  firstReplyAfter: {
                    $arrayElemAt: [
                      { $sortArray: { input: '$$repliesAfterBaseline', sortBy: { sentAt: 1 } } },
                      0
                    ]
                  },
                  validRespondedAt: {
                    $cond: [
                      {
                        $and: [
                          { $ne: ['$respondedAt', null] },
                          { $gte: ['$respondedAt', '$$baseline'] }
                        ]
                      },
                      '$respondedAt',
                      null
                    ]
                  }
                },
                in: {
                  $cond: [
                    { $gt: ['$$storedMs', 0] },
                    '$$storedMs',
                    {
                      $let: {
                        vars: {
                          firstAt: {
                            $ifNull: ['$$firstReplyAfter.sentAt', '$$validRespondedAt']
                          }
                        },
                        in: {
                          $cond: [
                            {
                              $and: [
                                { $ne: ['$$firstAt', null] },
                                { $ne: ['$$baseline', null] }
                              ]
                            },
                            {
                              $max: [
                                0,
                                { $subtract: ['$$firstAt', '$$baseline'] }
                              ]
                            },
                            null
                          ]
                        }
                      }
                    }
                  ]
                }
              }
            }
          }
        }
      }
    }
  }
};

function addResponseTimeMsStage() {
  return { $addFields: { _responseTimeMs: RESPONSE_TIME_MS_EXPR } };
}

const HAS_COMPUTABLE_RESPONSE_TIME_MS = {
  $and: [
    { $ne: ['$_responseTimeMs', null] },
    { $gt: ['$_responseTimeMs', 0] }
  ]
};

function mergeResponseMetricRows(primary, supplemental) {
  const a = primary || { totalResponded: 0, totalResponseTime: 0, respondedCount: 0 };
  const b = supplemental || { totalResponseTime: 0, respondedCount: 0 };
  return {
    totalResponded: a.totalResponded || 0,
    totalResponseTime: (a.totalResponseTime || 0) + (b.totalResponseTime || 0),
    respondedCount: (a.respondedCount || 0) + (b.respondedCount || 0)
  };
}

/** Sentiment score 0-100: positive=100, neutral=50, negative=0. Default 50 when empty. */
function computeSentimentScore({ positive = 0, neutral = 0 } = {}, total = 0) {
  return total > 0 ? ((positive * 100 + neutral * 50) / total) : 50;
}

/** Median of a numeric array. Mutates via sort — callers should pass a copy if needed. */
function computeMedian(nums) {
  if (!nums || nums.length === 0) return 0;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/** Fold `[{ _id: 'positive', count: N }, …]` into { positive, neutral, negative, total }. */
function foldSentimentBreakdown(rows, totalOverride = null) {
  const out = { positive: 0, neutral: 0, negative: 0, total: 0 };
  rows.forEach((item) => {
    if (item._id === 'positive') out.positive = item.count;
    else if (item._id === 'neutral') out.neutral = item.count;
    else if (item._id === 'negative') out.negative = item.count;
  });
  out.total = totalOverride != null ? totalOverride : (out.positive + out.neutral + out.negative);
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════
// 3. Aggregation functions — one per pipeline
// ═══════════════════════════════════════════════════════════════════════════

function countInteractions(matchFilter) {
  return Interaction.countDocuments(matchFilter);
}

/**
 * Returns [{ totalResponded, totalResponseTime, respondedCount }]
 */
async function aggregateInteractionResponseMetrics(matchFilter) {
  const rows = await Interaction.aggregate([
    { $match: matchFilter },
    addResponseTimeMsStage(),
    {
      $group: {
        _id: null,
        totalResponded: {
          $sum: {
            $cond: [{ $gt: [{ $size: { $ifNull: ['$replies', []] } }, 0] }, 1, 0]
          }
        },
        totalResponseTime: {
          $sum: { $cond: [HAS_COMPUTABLE_RESPONSE_TIME_MS, '$_responseTimeMs', 0] }
        },
        respondedCount: {
          $sum: { $cond: [HAS_COMPUTABLE_RESPONSE_TIME_MS, 1, 0] }
        }
      }
    }
  ]);
  return rows[0] || { totalResponded: 0, totalResponseTime: 0, respondedCount: 0 };
}

/**
 * Comment-to-DM / follow flows often create ProductOrders without updating Interaction.replies.
 */
async function aggregateProductOrderResponseMetrics(matchFilter) {
  const dateWindow = matchFilter.platformCreatedAt;
  if (!dateWindow) return { totalResponseTime: 0, respondedCount: 0 };

  const rows = await ProductOrder.aggregate([
    {
      $match: {
        organization: matchFilter.organization,
        commentInteractionId: { $exists: true, $ne: null },
        status: { $nin: ['cancelled'] }
      }
    },
    {
      $lookup: {
        from: Interaction.collection.name,
        localField: 'commentInteractionId',
        foreignField: '_id',
        as: 'interaction'
      }
    },
    { $unwind: '$interaction' },
    {
      $match: {
        'interaction.platformCreatedAt': dateWindow,
        'interaction.respondedAt': null,
        $expr: { $eq: [{ $size: { $ifNull: ['$interaction.replies', []] } }, 0] }
      }
    },
    {
      $project: {
        responseTimeMs: {
          $max: [
            0,
            {
              $subtract: [
                '$createdAt',
                { $ifNull: ['$interaction.platformCreatedAt', '$interaction.createdAt'] }
              ]
            }
          ]
        }
      }
    },
    {
      $group: {
        _id: null,
        totalResponseTime: {
          $sum: { $cond: [{ $gt: ['$responseTimeMs', 0] }, '$responseTimeMs', 0] }
        },
        respondedCount: {
          $sum: { $cond: [{ $gt: ['$responseTimeMs', 0] }, 1, 0] }
        }
      }
    }
  ]);
  return rows[0] || { totalResponseTime: 0, respondedCount: 0 };
}

async function aggregateResponseMetrics(matchFilter) {
  const [fromInteractions, fromOrders] = await Promise.all([
    aggregateInteractionResponseMetrics(matchFilter),
    aggregateProductOrderResponseMetrics(matchFilter)
  ]);
  return [mergeResponseMetricRows(fromInteractions, fromOrders)];
}

/**
 * Per-platform metrics: totalInteractions, responded, pending, avgResponseTime (ms).
 */
function aggregatePlatformMetrics(matchFilter) {
  return Interaction.aggregate([
    { $match: matchFilter },
    addResponseTimeMsStage(),
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
          $sum: { $cond: [HAS_COMPUTABLE_RESPONSE_TIME_MS, '$_responseTimeMs', 0] }
        },
        respondedCount: {
          $sum: { $cond: [HAS_COMPUTABLE_RESPONSE_TIME_MS, 1, 0] }
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
  ]);
}

/** Raw sentiment rows: [{ _id: 'positive', count: N }, …] */
function aggregateSentimentBreakdown(matchFilter) {
  return Interaction.aggregate([
    { $match: matchFilter },
    { $group: { _id: '$sentiment', count: { $sum: 1 } } }
  ]);
}

/** Daily time series: [{ date, interactions, responses }] */
function aggregateTimeSeries(matchFilter) {
  return Interaction.aggregate([
    { $match: matchFilter },
    {
      $group: {
        _id: { $dateToString: { format: '%Y-%m-%d', date: '$platformCreatedAt' } },
        interactions: { $sum: 1 },
        responses: {
          $sum: {
            $cond: [{ $gt: [{ $size: { $ifNull: ['$replies', []] } }, 0] }, 1, 0]
          }
        }
      }
    },
    { $sort: { _id: 1 } },
    { $project: { date: '$_id', interactions: 1, responses: 1, _id: 0 } }
  ]);
}

/**
 * Facet query returning { stats: [{ avg,min,max,times }], distribution: [{_id,count}] }
 * Bucket boundaries are in MINUTES: [0, 60, 1440, Infinity].
 */
function aggregateResponseTimeDistribution(matchFilter) {
  return Interaction.aggregate([
    { $match: matchFilter },
    addResponseTimeMsStage(),
    { $match: { $expr: HAS_COMPUTABLE_RESPONSE_TIME_MS } },
    {
      $project: {
        responseTime: { $divide: ['$_responseTimeMs', 60000] }
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
              output: { count: { $sum: 1 } }
            }
          }
        ]
      }
    }
  ]);
}

/**
 * Intent bucket breakdown with bucket metadata joined in.
 * Returns: [{ _id, count, name, color, icon, order }]
 */
function aggregateIntentBreakdown(matchFilter) {
  return Interaction.aggregate([
    { $match: { ...matchFilter, intentBucket: { $exists: true, $ne: null } } },
    { $group: { _id: '$intentBucket', count: { $sum: 1 } } },
    {
      $lookup: {
        from: 'intentbuckets',
        localField: '_id',
        foreignField: '_id',
        as: 'bucket'
      }
    },
    { $unwind: { path: '$bucket', preserveNullAndEmptyArrays: true } },
    {
      $project: {
        _id: 1,
        count: 1,
        name:  { $ifNull: ['$bucket.name',  'Unknown'] },
        color: { $ifNull: ['$bucket.color', '#6B7280'] },
        icon:  { $ifNull: ['$bucket.icon',  'fas fa-tag'] },
        order: { $ifNull: ['$bucket.order', 999] }
      }
    },
    { $sort: { count: -1 } }
  ]);
}

/** Returns [{ aiReplies, humanReplies, totalReplies }] (individual reply messages, not threads). */
function aggregateAiVsHumanReplies(matchFilter) {
  return Interaction.aggregate([
    { $match: matchFilter },
    { $unwind: { path: '$replies', preserveNullAndEmptyArrays: false } },
    {
      $group: {
        _id: null,
        aiReplies: { $sum: { $cond: [{ $eq: ['$replies.wasAutoGenerated', true] }, 1, 0] } },
        humanReplies: { $sum: { $cond: [{ $ne: ['$replies.wasAutoGenerated', true] }, 1, 0] } },
        totalReplies: { $sum: 1 }
      }
    }
  ]);
}

/**
 * Top 5 posts by comment count, joined with ScheduledPost for content/media URL.
 */
function aggregateTopInteractions(matchFilter, limit = 5) {
  return Interaction.aggregate([
    { $match: { ...matchFilter, 'metadata.postId': { $exists: true, $ne: null } } },
    {
      $group: {
        _id: '$metadata.postId',
        platform: { $first: '$platform' },
        postUrl: { $first: '$metadata.postUrl' },
        interactionMediaUrl: { $first: '$metadata.mediaUrl' },
        commentCount: { $sum: 1 },
        totalLikes: { $sum: { $ifNull: ['$engagement.likes', 0] } },
        totalViews: { $sum: { $ifNull: ['$engagement.views', 0] } },
        positiveCount: { $sum: { $cond: [{ $eq: ['$sentiment', 'positive'] }, 1, 0] } },
        negativeCount: { $sum: { $cond: [{ $eq: ['$sentiment', 'negative'] }, 1, 0] } },
        neutralCount: { $sum: { $cond: [{ $eq: ['$sentiment', 'neutral'] }, 1, 0] } },
        latestDate: { $max: '$platformCreatedAt' },
        latestContent: { $first: '$content' }
      }
    },
    { $sort: { commentCount: -1 } },
    { $limit: limit },
    {
      $lookup: {
        from: 'scheduledposts',
        localField: '_id',
        foreignField: 'platformPostId',
        as: 'scheduledPost'
      }
    },
    { $unwind: { path: '$scheduledPost', preserveNullAndEmptyArrays: true } },
    {
      $project: {
        platform: 1,
        postUrl: 1,
        commentCount: 1,
        totalLikes: 1,
        totalViews: 1,
        positiveCount: 1,
        negativeCount: 1,
        neutralCount: 1,
        latestDate: 1,
        latestContent: 1,
        postContent: '$scheduledPost.content',
        postMediaUrl: { $ifNull: ['$scheduledPost.mediaUrl', '$interactionMediaUrl'] }
      }
    }
  ]);
}

// ── Platform analytics ─────────────────────────────────────────────────────
function aggregatePlatformFacet(organizationId, platform, startDate, endDate) {
  return Interaction.aggregate([
    {
      $match: {
        organization: toObjectId(organizationId),
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
        byType: [{ $group: { _id: '$type', count: { $sum: 1 } } }],
        bySentiment: [{ $group: { _id: '$sentiment', count: { $sum: 1 } } }]
      }
    }
  ]);
}

// ── Engagement analytics ───────────────────────────────────────────────────
function aggregateEngagementOverview(matchFilter) {
  return Interaction.aggregate([
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
  ]);
}

function aggregateEngagementByPlatform(matchFilter) {
  return Interaction.aggregate([
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
  ]);
}

function findEngagementTopInteractions(matchFilter, limit = 10) {
  return Interaction.find(matchFilter)
    .sort({ 'engagement.likes': -1 })
    .limit(limit)
    .select('platform content engagement.likes engagement.shares createdAt')
    .lean();
}

function aggregateEngagementTimeSeries(matchFilter) {
  return Interaction.aggregate([
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
  ]);
}

// ── Agent analytics ────────────────────────────────────────────────────────
function aggregateAgentData(organizationId, startDate, endDate) {
  return Interaction.aggregate([
    { $match: { organization: toObjectId(organizationId) } },
    // Use the most recent of the five relevant timestamps so interactions
    // updated (assigned / replied / resolved) in the window are included.
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
    {
      $addFields: {
        effectiveAgentId: {
          $ifNull: [
            '$assignedTo',
            {
              $arrayElemAt: [
                { $map: { input: { $ifNull: ['$replies', []] }, as: 'r', in: '$$r.sentBy' } },
                0
              ]
            }
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
    { $lookup: { from: 'users', localField: '_id', foreignField: '_id', as: 'user' } },
    { $unwind: { path: '$user', preserveNullAndEmptyArrays: true } },
    {
      $project: {
        userId: '$_id', _id: 0,
        name: {
          $concat: [
            { $ifNull: ['$user.firstName', 'Unknown'] }, ' ',
            { $ifNull: ['$user.lastName', ''] }
          ]
        },
        totalAssigned: 1, totalResolved: 1,
        avgResponseTime: { $round: [{ $ifNull: ['$avgResponseTime', 0] }, 0] },
        sentimentBreakdown: {
          positive: '$sentimentPositive',
          neutral: '$sentimentNeutral',
          negative: '$sentimentNegative'
        },
        performanceScore: {
          $round: [{
            $multiply: [
              {
                $cond: [
                  { $gt: ['$totalAssigned', 0] },
                  { $divide: ['$totalResolved', '$totalAssigned'] },
                  0
                ]
              },
              100
            ]
          }, 1]
        }
      }
    },
    { $sort: { performanceScore: -1 } }
  ]);
}

// ── Export-specific aggregations (subset of what dashboard computes) ───────
function aggregateExportPlatformMetrics(matchFilter) {
  return Interaction.aggregate([
    { $match: matchFilter },
    {
      $group: {
        _id: '$platform',
        totalInteractions: { $sum: 1 },
        responded: { $sum: { $cond: [{ $gt: [{ $size: { $ifNull: ['$replies', []] } }, 0] }, 1, 0] } },
        avgResponseTime: { $avg: '$responseTime' },
        avgSentiment: {
          $avg: {
            $switch: {
              branches: [
                { case: { $eq: ['$sentiment', 'positive'] }, then: 100 },
                { case: { $eq: ['$sentiment', 'negative'] }, then: 0 }
              ],
              default: 50
            }
          }
        }
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
  ]);
}

function aggregateExportResponseTimeMetrics(matchFilter) {
  return Interaction.aggregate([
    { $match: { ...matchFilter, responseTime: { $exists: true, $gt: 0 } } },
    {
      $group: {
        _id: null,
        avg: { $avg: '$responseTime' },
        median: { $avg: '$responseTime' },
        within1Hour: { $sum: { $cond: [{ $lte: ['$responseTime', 60] }, 1, 0] } },
        within24Hours: {
          $sum: {
            $cond: [
              {
                $and: [{ $gt: ['$responseTime', 60] }, { $lte: ['$responseTime', 1440] }]
              },
              1, 0
            ]
          }
        },
        over24Hours: { $sum: { $cond: [{ $gt: ['$responseTime', 1440] }, 1, 0] } }
      }
    }
  ]);
}

// ═══════════════════════════════════════════════════════════════════════════
// 4. Orchestrators — one per public endpoint
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Build the full dashboard DTO (the shape the frontend consumes).
 *
 * @param {string|object} organizationId
 * @param {object}  filters — see buildMatchFilter
 * @param {object}  [meta]
 * @param {string}  [meta.preset='custom'] — echo of the preset name for the UI
 * @returns {Promise<object>}
 */
async function getDashboardData(organizationId, filters, meta = {}) {
  const matchFilter = buildMatchFilter(organizationId, filters);
  const prevMatchFilter = buildPrevMatchFilter(matchFilter);

  const [
    totalInteractions,
    responseMetrics,
    platformMetrics,
    sentimentBreakdown,
    timeSeriesData,
    responseTimeMetrics,
    intentBreakdown,
    aiVsHumanReplies,
    topInteractions,
    prevTotalInteractions,
    prevResponseMetrics,
    prevSentimentBreakdown
  ] = await Promise.all([
    countInteractions(matchFilter),
    aggregateResponseMetrics(matchFilter),
    aggregatePlatformMetrics(matchFilter),
    aggregateSentimentBreakdown(matchFilter),
    aggregateTimeSeries(matchFilter),
    aggregateResponseTimeDistribution(matchFilter),
    aggregateIntentBreakdown(matchFilter),
    aggregateAiVsHumanReplies(matchFilter),
    aggregateTopInteractions(matchFilter),
    countInteractions(prevMatchFilter),
    aggregateResponseMetrics(prevMatchFilter),
    aggregateSentimentBreakdown(prevMatchFilter)
  ]);

  return assembleDashboardDto({
    totalInteractions,
    responseMetrics,
    platformMetrics,
    sentimentBreakdown,
    timeSeriesData,
    responseTimeMetrics,
    intentBreakdown,
    aiVsHumanReplies,
    topInteractions,
    prevTotalInteractions,
    prevResponseMetrics,
    prevSentimentBreakdown,
    startDate: filters.startDate,
    endDate: filters.endDate,
    preset: meta.preset || 'custom'
  });
}

/**
 * Pure transform from raw aggregation results to the dashboard DTO.
 * Extracted so we can unit-test the shaping without hitting Mongo.
 */
function assembleDashboardDto(inputs) {
  const {
    totalInteractions,
    responseMetrics,
    platformMetrics,
    sentimentBreakdown,
    timeSeriesData,
    responseTimeMetrics,
    intentBreakdown,
    aiVsHumanReplies,
    topInteractions,
    prevTotalInteractions,
    prevResponseMetrics,
    prevSentimentBreakdown,
    startDate,
    endDate,
    preset
  } = inputs;

  // ── Current period ─────────────────────────────────────────────────────
  const responseData = responseMetrics[0] || {
    totalResponded: 0, totalResponseTime: 0, respondedCount: 0
  };
  const responseRate = computeResponseRate(totalInteractions, responseData.totalResponded);
  const avgFromMetrics = computeAvgResponseTime(
    responseData.totalResponseTime, responseData.respondedCount
  );

  const sentimentData = foldSentimentBreakdown(sentimentBreakdown, totalInteractions);
  const sentimentScore = computeSentimentScore(sentimentData, totalInteractions);

  // ── Previous period for change calcs ──────────────────────────────────
  const prevResponseData = prevResponseMetrics[0] || {
    totalResponded: 0, totalResponseTime: 0, respondedCount: 0
  };
  const prevResponseRate = computeResponseRate(
    prevTotalInteractions, prevResponseData.totalResponded
  );
  const prevAvgFromMetrics = computeAvgResponseTime(
    prevResponseData.totalResponseTime, prevResponseData.respondedCount
  );
  const prevSentimentData = foldSentimentBreakdown(
    prevSentimentBreakdown, prevTotalInteractions
  );
  const prevSentimentScore = computeSentimentScore(prevSentimentData, prevTotalInteractions);

  // ── Response-time stats + distribution ────────────────────────────────
  const responseTimeDoc = responseTimeMetrics[0];
  const stats = responseTimeDoc?.stats[0] || { avg: 0, min: 0, max: 0, times: [] };
  const distribution = responseTimeDoc?.distribution || [];
  const median = computeMedian(stats.times);
  const within1Hour = distribution.find((d) => d._id === 0)?.count || 0;
  const within24Hours = distribution.find((d) => d._id === 60)?.count || 0;
  const over24Hours = distribution.find((d) => d._id === 1440)?.count || 0;

  // Prefer distribution avg when interaction metrics are empty; keep fractional minutes
  const avgFromDistribution = stats.avg || 0;
  const avgResponseTime = avgFromMetrics > 0 ? avgFromMetrics : avgFromDistribution;
  const prevAvgResponseTime = prevAvgFromMetrics > 0 ? prevAvgFromMetrics : 0;

  // ── Intent breakdown — keyed by bucket id for the UI ──────────────────
  const intentData = {};
  const intentMeta = {};
  const intentTotal = intentBreakdown.reduce((sum, i) => sum + i.count, 0);
  intentBreakdown.forEach((i) => {
    const key = i._id.toString();
    intentData[key] = i.count;
    intentMeta[key] = { name: i.name, color: i.color, icon: i.icon };
  });

  // ── AI vs human replies ───────────────────────────────────────────────
  const aiHumanData = aiVsHumanReplies[0] || { aiReplies: 0, humanReplies: 0, totalReplies: 0 };

  // ── Period-over-period changes ────────────────────────────────────────
  const interactionChange = calcChange(totalInteractions, prevTotalInteractions);
  const responseRateChange = calcChange(responseRate, prevResponseRate);
  const responseTimeChange = calcChange(avgResponseTime, prevAvgResponseTime);
  const sentimentChange = calcChange(sentimentScore, prevSentimentScore);

  return {
    dateRange: { startDate, endDate, preset },
    overview: {
      totalInteractions: {
        label: 'Total Interactions',
        value: totalInteractions,
        icon: 'fas fa-comments',
        color: '#3B82F6',
        change: Math.abs(interactionChange),
        changeType: interactionChange >= 0 ? 'increase' : 'decrease'
      },
      responseRate: {
        label: 'Response Rate',
        value: Math.round(responseRate),
        icon: 'fas fa-reply',
        color: '#10B981',
        change: Math.abs(responseRateChange),
        changeType: responseRateChange >= 0 ? 'increase' : 'decrease'
      },
      avgResponseTime: {
        label: 'Avg Response Time',
        value: avgResponseTime > 0 ? +avgResponseTime.toFixed(1) : 0,
        icon: 'fas fa-clock',
        color: '#F59E0B',
        change: Math.abs(responseTimeChange),
        // NOTE: inverted — shorter response time is "better" (increase in quality)
        changeType: responseTimeChange <= 0 ? 'increase' : 'decrease'
      },
      sentimentScore: {
        label: 'Sentiment Score',
        value: Math.round(sentimentScore),
        icon: 'fas fa-smile',
        color: '#D0FF00',
        change: Math.abs(sentimentChange),
        changeType: sentimentChange >= 0 ? 'increase' : 'decrease'
      }
    },
    platformMetrics: platformMetrics.map((p) => ({
      platform: p.platform,
      totalInteractions: p.totalInteractions,
      responded: p.responded,
      pending: p.pending,
      avgResponseTime: Math.round(p.avgResponseTime / 60000)
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
    },
    intentBreakdown: { data: intentData, meta: intentMeta, total: intentTotal },
    aiVsHuman: {
      aiReplies: aiHumanData.aiReplies,
      humanReplies: aiHumanData.humanReplies,
      totalReplies: aiHumanData.totalReplies,
      aiPercent: aiHumanData.totalReplies
        ? Math.round((aiHumanData.aiReplies / aiHumanData.totalReplies) * 100)
        : 0
    },
    topInteractions: (topInteractions || []).map((t) => {
      const dominant = t.positiveCount >= t.negativeCount ? 'positive' : 'negative';
      const rawContent = t.postContent || t.latestContent || '';
      return {
        postId: t._id,
        platform: t.platform,
        postUrl: t.postUrl || null,
        content: rawContent.length > 80 ? `${rawContent.substring(0, 80)}…` : (rawContent || null),
        mediaUrl: t.postMediaUrl || null,
        commentCount: t.commentCount || 0,
        totalLikes: t.totalLikes || 0,
        totalViews: t.totalViews || 0,
        positiveCount: t.positiveCount || 0,
        negativeCount: t.negativeCount || 0,
        sentiment: dominant,
        latestDate: t.latestDate
      };
    }),
    autoReplyMetrics: {
      totalAutoReplies: aiHumanData.aiReplies,
      successRate: aiHumanData.totalReplies > 0
        ? Math.round((aiHumanData.aiReplies / aiHumanData.totalReplies) * 100)
        : 0,
      avgConfidence: 0
    }
  };
}

/** Platform-specific analytics orchestrator. */
async function getPlatformAnalyticsData(organizationId, platform, startDate, endDate) {
  const rows = await aggregatePlatformFacet(organizationId, platform, startDate, endDate);
  return rows[0] || null;
}

/** Engagement orchestrator — DTO identical to current controller output. */
async function getEngagementAnalyticsData(organizationId, filters) {
  const matchFilter = buildMatchFilter(organizationId, filters);

  const [overview, byPlatform, topInteractions, timeSeries] = await Promise.all([
    aggregateEngagementOverview(matchFilter),
    aggregateEngagementByPlatform(matchFilter),
    findEngagementTopInteractions(matchFilter),
    aggregateEngagementTimeSeries(matchFilter)
  ]);

  const ov = overview[0] || {
    totalLikes: 0, totalShares: 0, totalViews: 0, totalInteractions: 0
  };
  const avgEngagementRate = ov.totalInteractions
    ? +((((ov.totalLikes + ov.totalShares) / ov.totalInteractions) * 100).toFixed(2))
    : 0;

  return {
    overview: { ...ov, avgEngagementRate },
    byPlatform,
    topInteractions,
    timeSeries
  };
}

/** Agent analytics orchestrator — returns { agents, teamAverages }. */
async function getAgentData(organizationId, startDate, endDate) {
  const agentStats = await aggregateAgentData(organizationId, startDate, endDate);

  const totals = agentStats.reduce(
    (acc, a) => {
      acc.totalResponseTime += a.avgResponseTime;
      acc.totalResolved += a.totalResolved;
      acc.totalAssigned += a.totalAssigned;
      return acc;
    },
    { totalResponseTime: 0, totalResolved: 0, totalAssigned: 0 }
  );

  const count = agentStats.length || 1;
  return {
    agents: agentStats,
    teamAverages: {
      avgResponseTime: Math.round(totals.totalResponseTime / count),
      resolutionRate: totals.totalAssigned
        ? +((totals.totalResolved / totals.totalAssigned) * 100).toFixed(1)
        : 0
    }
  };
}

/**
 * Export orchestrator — returns the raw analytics blob that exportService
 * knows how to format (platform / sentiment / response reports all share the
 * same source data).
 */
async function getExportAnalyticsData(organizationId, { startDate, endDate, platforms }) {
  const matchFilter = { organization: toObjectId(organizationId), platformCreatedAt: { $gte: startDate, $lte: endDate } };
  if (platforms?.length) matchFilter.platform = { $in: platforms };

  const [platformMetrics, sentimentData, rtData] = await Promise.all([
    aggregateExportPlatformMetrics(matchFilter),
    aggregateSentimentBreakdown(matchFilter),
    aggregateExportResponseTimeMetrics(matchFilter)
  ]);

  const sentimentBreakdown = foldSentimentBreakdown(sentimentData);
  return {
    platformMetrics,
    sentimentBreakdown,
    responseTimeMetrics: rtData[0] || {}
  };
}

/** Fixed trailing-30-day AI vs human post counts. */
async function getContentPerformanceData(organizationId, startDate = null) {
  const orgId = toObjectId(organizationId);
  const windowStart = startDate || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const [aiCount, humanCount] = await Promise.all([
    ScheduledPost.countDocuments({
      organization: orgId,
      status: 'published',
      publishedAt: { $gte: windowStart },
      generatedBy: 'ai'
    }),
    ScheduledPost.countDocuments({
      organization: orgId,
      status: 'published',
      publishedAt: { $gte: windowStart },
      $or: [{ generatedBy: 'human' }, { generatedBy: { $exists: false } }]
    })
  ]);
  const total = aiCount + humanCount;
  return {
    aiCount,
    humanCount,
    total,
    aiPercent: total ? Math.round((aiCount / total) * 100) : 0
  };
}

// ═══════════════════════════════════════════════════════════════════════════
module.exports = {
  // Filter builders
  buildMatchFilter,
  buildPrevMatchFilter,

  // Pure helpers (exported for testing + controller reuse)
  calcChange,
  computeResponseRate,
  computeAvgResponseTime,
  computeSentimentScore,
  computeMedian,
  foldSentimentBreakdown,

  // Orchestrators (the public API for controllers)
  getDashboardData,
  getPlatformAnalyticsData,
  getEngagementAnalyticsData,
  getAgentData,
  getExportAnalyticsData,
  getContentPerformanceData,

  // Pure DTO assembler exported so tests can feed it synthetic aggregates.
  assembleDashboardDto,

  // Low-level aggregation functions — exported so other services (e.g. the
  // planned postPublishService / platform sync) can reuse them if needed.
  _aggregations: {
    countInteractions,
    aggregateResponseMetrics,
    aggregatePlatformMetrics,
    aggregateSentimentBreakdown,
    aggregateTimeSeries,
    aggregateResponseTimeDistribution,
    aggregateIntentBreakdown,
    aggregateAiVsHumanReplies,
    aggregateTopInteractions,
    aggregatePlatformFacet,
    aggregateEngagementOverview,
    aggregateEngagementByPlatform,
    findEngagementTopInteractions,
    aggregateEngagementTimeSeries,
    aggregateAgentData,
    aggregateExportPlatformMetrics,
    aggregateExportResponseTimeMetrics
  }
};
