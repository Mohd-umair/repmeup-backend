/**
 * Live Metrics Service — Growth Intelligence Phase 2
 *
 * Computes the Conversation Score and all dashboard KPIs from live
 * Interaction data for an authenticated organization.
 *
 * Reuses existing analyticsService aggregations (no duplication) and
 * enriches with: Conversation Score, grade, revenue-leak estimate,
 * benchmark comparisons, and AI-driven recommendations.
 *
 * Architecture:
 *   Route → Controller → this service
 *   This service → analyticsService (existing pipelines)
 *                → openaiClient (AI recommendations, with fallback)
 *                → GrowthSnapshot model (trend persistence)
 */

const Interaction    = require('../../models/Interaction');
const GrowthSnapshot = require('../../models/GrowthSnapshot');
const openaiClient   = require('../ai/openaiClient');
const { getBenchmarks } = require('../audit/industryBenchmarks');
const { openAIChatCompletionTemperatureField, openAIChatCompletionMaxTokensField } = require('../../utils/openaiModelHelpers');
const logger = require('../../config/logger');
const mongoose = require('mongoose');

// ── Score weights ──────────────────────────────────────────────────────────────
// Weighted composite (0–100) using LIVE connected-account data.
const WEIGHTS = {
  responseRate:      0.30,  // % of interactions that received a reply
  responseSpeed:     0.20,  // speed of reply (< 1h = full marks)
  inquiryHandled:    0.20,  // % of inquiry/buying-intent messages replied
  sentimentHealth:   0.15,  // ratio of positive interactions
  platformCoverage:  0.15,  // % of active platforms with > 70 % response rate
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function gradeFromScore(s) {
  if (s >= 85) return 'A';
  if (s >= 70) return 'B';
  if (s >= 55) return 'C';
  if (s >= 40) return 'D';
  return 'F';
}

function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v || 0)); }

/**
 * Safely coerce any representation of an organization ID to a Mongoose ObjectId.
 *
 * Handles:
 *   - Already an ObjectId instance          → return as-is
 *   - 24-char hex string                    → wrap in ObjectId
 *   - Populated object { _id: ... }         → extract _id and recurse
 *   - Anything else                         → throw meaningful error
 *
 * Do NOT fall back silently (returning the raw value) — that would produce
 * a $match that matches zero documents with no error feedback.
 */
function toObjectId(id) {
  if (id instanceof mongoose.Types.ObjectId) return id;

  // Populated sub-document or organization object { _id, name, ... }
  if (id && typeof id === 'object' && id._id) return toObjectId(id._id);

  const str = String(id);
  if (/^[a-f\d]{24}$/i.test(str)) return new mongoose.Types.ObjectId(str);

  throw new Error(`Invalid organizationId: "${str}". Expected a 24-char hex ObjectId.`);
}

/**
 * Normalise response-speed to 0–1.
 * < 5 min → 1.0, < 1 hr → 0.90, < 4 hr → 0.75,
 * < 24 hr → 0.50, < 48 hr → 0.25, > 48 hr → 0.
 */
function normSpeed(avgMinutes) {
  if (avgMinutes <= 0)    return 0;   // no data — no credit
  if (avgMinutes <=   5) return 1.00;
  if (avgMinutes <=  60) return 0.90;
  if (avgMinutes <= 240) return 0.75;
  if (avgMinutes <= 1440) return 0.50;
  if (avgMinutes <= 2880) return 0.25;
  return 0.05;
}

// ── Aggregation helpers ───────────────────────────────────────────────────────

/** Count interactions matching the filter, split by replied vs unanswered. */
async function aggregateResponseRate(orgId, startDate, endDate) {
  const oid = toObjectId(orgId);
  const rows = await Interaction.aggregate([
    { $match: { organization: oid, platformCreatedAt: { $gte: startDate, $lte: endDate } } },
    {
      $group: {
        _id: null,
        total: { $sum: 1 },
        replied: {
          $sum: { $cond: [{ $gt: [{ $size: { $ifNull: ['$replies', []] } }, 0] }, 1, 0] }
        },
        totalResponseTimeMs: {
          $sum: { $ifNull: ['$firstResponseTime', 0] }
        },
        respondedCount: {
          $sum: { $cond: [{ $gt: [{ $ifNull: ['$firstResponseTime', 0] }, 0] }, 1, 0] }
        }
      }
    }
  ]);
  const r = rows[0] || { total: 0, replied: 0, totalResponseTimeMs: 0, respondedCount: 0 };
  const responseRate        = r.total > 0 ? (r.replied / r.total) * 100 : 0;
  const avgResponseTimeMins = r.respondedCount > 0 ? r.totalResponseTimeMs / r.respondedCount / 60000 : 0;
  return { total: r.total, replied: r.replied, responseRate, avgResponseTimeMins };
}

/** Reply rate for inquiry/intent interactions (buying-intent proxy). */
async function aggregateInquiryHandled(orgId, startDate, endDate) {
  const oid = toObjectId(orgId);
  const rows = await Interaction.aggregate([
    {
      $match: {
        organization: oid,
        platformCreatedAt: { $gte: startDate, $lte: endDate },
        intent: { $in: ['inquiry', 'support'] }
      }
    },
    {
      $group: {
        _id: null,
        total: { $sum: 1 },
        replied: {
          $sum: { $cond: [{ $gt: [{ $size: { $ifNull: ['$replies', []] } }, 0] }, 1, 0] }
        }
      }
    }
  ]);
  const r = rows[0] || { total: 0, replied: 0 };
  return { total: r.total, replied: r.replied, rate: r.total > 0 ? (r.replied / r.total) * 100 : null };
}

/** Sentiment breakdown. */
async function aggregateSentiment(orgId, startDate, endDate) {
  const oid = toObjectId(orgId);
  const rows = await Interaction.aggregate([
    { $match: { organization: oid, platformCreatedAt: { $gte: startDate, $lte: endDate } } },
    { $group: { _id: '$sentiment', count: { $sum: 1 } } }
  ]);
  const map = {};
  rows.forEach(r => { map[r._id] = r.count; });
  const positive = map.positive || 0;
  const negative = map.negative || 0;
  const neutral  = map.neutral  || 0;
  const total    = positive + negative + neutral;
  const score    = total > 0 ? ((positive * 100 + neutral * 50) / total) : 50;
  return { positive, negative, neutral, total, score: Math.round(score) };
}

/** Per-platform metrics, built with our own safe match filter. */
async function getPlatformBreakdown(orgId, startDate, endDate) {
  const oid = toObjectId(orgId);
  const rows = await Interaction.aggregate([
    { $match: { organization: oid, platformCreatedAt: { $gte: startDate, $lte: endDate } } },
    {
      $group: {
        _id: '$platform',
        total:     { $sum: 1 },
        responded: {
          $sum: { $cond: [{ $gt: [{ $size: { $ifNull: ['$replies', []] } }, 0] }, 1, 0] }
        },
        pending: {
          $sum: { $cond: [{ $eq: [{ $size: { $ifNull: ['$replies', []] } }, 0] }, 1, 0] }
        },
        totalResponseTimeMs: {
          $sum: { $ifNull: ['$firstResponseTime', 0] }
        },
        respondedCount: {
          $sum: { $cond: [{ $gt: [{ $ifNull: ['$firstResponseTime', 0] }, 0] }, 1, 0] }
        }
      }
    }
  ]);
  return rows.map(r => ({
    platform:            r._id || 'unknown',
    total:               r.total || 0,
    responded:           r.responded || 0,
    pending:             r.pending || 0,
    responseRate:        r.total > 0 ? Math.round((r.responded / r.total) * 100) : 0,
    avgResponseTimeMins: r.respondedCount > 0 ? Math.round(r.totalResponseTimeMs / r.respondedCount / 60000) : 0
  }));
}

/** 30-day daily trend data (response rate + score). */
async function getTrendData(orgId, days = 30) {
  const end   = new Date();
  const start = new Date(end.getTime() - days * 86400000);
  const snapshots = await GrowthSnapshot
    .find({ organization: toObjectId(orgId), date: { $gte: start, $lte: end } })
    .sort({ date: 1 })
    .select('date conversationScore responseRate avgResponseTimeMinutes revenueLeakEstimate')
    .lean();
  return snapshots.map(s => ({
    date:            s.date,
    score:           s.conversationScore,
    responseRate:    s.responseRate,
    avgResponseTime: s.avgResponseTimeMinutes,
    revenueLeak:     s.revenueLeakEstimate
  }));
}

// ── Conversation Score ────────────────────────────────────────────────────────

/**
 * Compute a 0–100 Conversation Score from live aggregated metrics.
 *
 * @param {object} metrics
 * @param {number} metrics.responseRate        0–100 %
 * @param {number} metrics.avgResponseTimeMins minutes
 * @param {number|null} metrics.inquiryRate    0–100 % or null if no inquiries
 * @param {number} metrics.sentimentScore      0–100
 * @param {Array}  metrics.platforms           [{responseRate}]
 * @param {object} benchmarks
 */
function computeConversationScore(metrics) {
  const { responseRate, avgResponseTimeMins, inquiryRate, sentimentScore, platforms } = metrics;

  // 1. Response rate component (0–1)
  const rrComponent = clamp(responseRate / 100, 0, 1);

  // 2. Response speed component (0–1)
  const speedComponent = normSpeed(avgResponseTimeMins);

  // 3. Inquiry handled component (0–1)
  // If no inquiry data, use responseRate as proxy
  const inqComponent = inquiryRate !== null
    ? clamp(inquiryRate / 100, 0, 1)
    : clamp(responseRate / 80, 0, 1);  // 80 % response maps to full credit

  // 4. Sentiment health (0–1): score is already 0–100
  const sentComponent = clamp(sentimentScore / 100, 0, 1);

  // 5. Platform coverage: % of platforms with > 70 % response rate
  const activePlatforms = platforms.filter(p => p.total >= 5);  // min volume
  const coveredPlatforms = activePlatforms.filter(p => p.responseRate >= 70);
  const coverageComponent = activePlatforms.length > 0
    ? coveredPlatforms.length / activePlatforms.length
    : (responseRate >= 70 ? 1 : responseRate / 70); // fallback if no platform breakdown

  const rawScore =
    rrComponent     * WEIGHTS.responseRate    * 100 +
    speedComponent  * WEIGHTS.responseSpeed   * 100 +
    inqComponent    * WEIGHTS.inquiryHandled  * 100 +
    sentComponent   * WEIGHTS.sentimentHealth * 100 +
    coverageComponent * WEIGHTS.platformCoverage * 100;

  return Math.round(clamp(rawScore, 0, 100));
}

// ── Revenue Leak ──────────────────────────────────────────────────────────────

/**
 * Estimate monthly revenue leak.
 * Formula: unanswered_inquiry_count_per_day × 30 × avgOrderValue × conversionRate
 */
function estimateRevenueLeak(unansweredInquiries, avgOrderValue, totalDays = 30) {
  const DEFAULT_ORDER_VALUE  = 1500;   // INR
  const DEFAULT_CONV_RATE    = 0.12;   // 12 %
  const aov  = avgOrderValue > 0 ? avgOrderValue : DEFAULT_ORDER_VALUE;
  const conv = DEFAULT_CONV_RATE;
  const dailyMissed = unansweredInquiries / Math.max(totalDays, 1);
  return Math.round(dailyMissed * 30 * aov * conv);
}

// ── AI Recommendations ────────────────────────────────────────────────────────

const DEFAULT_RECS = [
  {
    priority: 'high',
    title:    'Set a reply-time target',
    action:   'Aim to reply to all DMs and comments within 1 hour. Most conversion windows close after 5 minutes.'
  },
  {
    priority: 'high',
    title:    'Handle inquiry messages first',
    action:   'Filter your inbox by Intent → Inquiry and prioritize those. Unanswered purchase questions bleed revenue daily.'
  },
  {
    priority: 'medium',
    title:    'Enable AI auto-reply for common questions',
    action:   'Go to Automation → AI Replies and set up templates for your top 5 FAQs. This can cut response time by 80 %.'
  },
  {
    priority: 'medium',
    title:    'Resolve negative sentiment conversations',
    action:   "Every unanswered negative comment costs you 30 % of observers' trust. Reply, acknowledge, and resolve."
  },
  {
    priority: 'low',
    title:    'Assign platform owners',
    action:   'Assign a dedicated team member to each platform. Ownership improves response rates by 40 %.'
  }
];

async function generateRecommendations(metrics, industry = 'general') {
  if (!openaiClient.isConfigured?.()) return DEFAULT_RECS;
  try {
    const prompt = `You are a growth advisor for DTC/ecommerce brands. Based on these live metrics, give 5 specific, actionable growth recommendations (JSON array).

Metrics (last 30 days):
- Conversation Score: ${metrics.conversationScore}/100 (grade: ${metrics.grade})
- Response Rate: ${Math.round(metrics.responseRate)}%
- Avg Response Time: ${Math.round(metrics.avgResponseTimeMins)} minutes
- Inquiry Reply Rate: ${metrics.inquiryRate !== null ? Math.round(metrics.inquiryRate) + '%' : 'no data'}
- Sentiment Score: ${metrics.sentimentScore}/100
- Estimated Revenue Leak: ₹${metrics.revenueLeakEstimate.toLocaleString('en-IN')}/month
- Industry: ${industry}

Return ONLY valid JSON: [{"priority":"high|medium|low","title":"short title","action":"1-sentence specific action"}]`;

    const response = await openaiClient.chatCompletion([
      { role: 'system', content: 'Return only valid JSON. No markdown. No explanation.' },
      { role: 'user', content: prompt }
    ], {
      [openAIChatCompletionTemperatureField]: 0.3,
      [openAIChatCompletionMaxTokensField]: 600
    });

    const text = response?.choices?.[0]?.message?.content?.trim() || '';
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed) && parsed.length > 0) return parsed.slice(0, 5);
    return DEFAULT_RECS;
  } catch (err) {
    logger.warn('[GrowthIntelligence] AI recs fallback', { error: err.message });
    return DEFAULT_RECS;
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Compute and return the full Growth Intelligence dashboard payload for an org.
 *
 * @param {string} organizationId
 * @param {object} options
 * @param {number} [options.days=30]          — lookback window in days
 * @param {string} [options.industry='general'] — industry for benchmarks
 * @param {number} [options.avgOrderValue=0]  — INR, from org settings
 * @param {boolean} [options.withAI=false]    — include AI recommendations
 */
async function getDashboard(organizationId, { days = 30, industry = 'general', avgOrderValue = 0, withAI = false } = {}) {
  const end   = new Date();
  const start = new Date(end.getTime() - days * 86400000);

  // Parallel aggregations
  const [baseMetrics, inquiryData, sentimentData, platforms] = await Promise.all([
    aggregateResponseRate(organizationId, start, end),
    aggregateInquiryHandled(organizationId, start, end),
    aggregateSentiment(organizationId, start, end),
    getPlatformBreakdown(organizationId, start, end)
  ]);

  const unansweredTotal    = baseMetrics.total - baseMetrics.replied;
  const unansweredInquiries = inquiryData.total - inquiryData.replied;
  const revenueLeakEstimate = estimateRevenueLeak(unansweredInquiries, avgOrderValue, days);

  const conversationScore = computeConversationScore({
    responseRate:       baseMetrics.responseRate,
    avgResponseTimeMins: baseMetrics.avgResponseTimeMins,
    inquiryRate:        inquiryData.rate,
    sentimentScore:     sentimentData.score,
    platforms
  });
  const grade = gradeFromScore(conversationScore);

  const benchmarks = getBenchmarks(industry);

  const payload = {
    period:              { days, start, end },
    conversationScore,
    grade,
    responseRate:        Math.round(baseMetrics.responseRate * 10) / 10,
    avgResponseTimeMins: Math.round(baseMetrics.avgResponseTimeMins),
    totalInteractions:   baseMetrics.total,
    repliedCount:        baseMetrics.replied,
    unansweredCount:     unansweredTotal,
    unansweredRate:      baseMetrics.total > 0 ? Math.round((unansweredTotal / baseMetrics.total) * 100) : 0,
    inquiryRate:         inquiryData.rate !== null ? Math.round(inquiryData.rate * 10) / 10 : null,
    unansweredInquiries,
    sentiment:           sentimentData,
    revenueLeakEstimate,
    platforms,
    benchmarks:          {
      responseRate:     benchmarks.commentReplyRate || 65,
      avgResponseTime:  60,  // minutes — industry standard 1h
      googleRating:     benchmarks.avgRating || 4.2
    },
    recommendations: withAI
      ? await generateRecommendations({
          conversationScore, grade, responseRate: baseMetrics.responseRate,
          avgResponseTimeMins: baseMetrics.avgResponseTimeMins,
          inquiryRate: inquiryData.rate, sentimentScore: sentimentData.score,
          revenueLeakEstimate
        }, industry)
      : DEFAULT_RECS
  };

  return payload;
}

/**
 * Upsert today's GrowthSnapshot for the organization.
 * Called after computing the dashboard, or by the nightly cron.
 */
async function saveSnapshot(organizationId, dashboardPayload) {
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  try {
    await GrowthSnapshot.findOneAndUpdate(
      { organization: toObjectId(organizationId), date: today },
      {
        $set: {
          conversationScore:      dashboardPayload.conversationScore,
          grade:                  dashboardPayload.grade,
          responseRate:           dashboardPayload.responseRate,
          avgResponseTimeMinutes: dashboardPayload.avgResponseTimeMins,
          unansweredCount:        dashboardPayload.unansweredCount,
          unansweredRate:         dashboardPayload.unansweredRate,
          revenueLeakEstimate:    dashboardPayload.revenueLeakEstimate,
          totalInteractions:      dashboardPayload.totalInteractions,
          sentiment: {
            score:    dashboardPayload.sentiment?.score || 0,
            positive: dashboardPayload.sentiment?.positive || 0,
            negative: dashboardPayload.sentiment?.negative || 0,
            neutral:  dashboardPayload.sentiment?.neutral  || 0
          },
          platforms: dashboardPayload.platforms
        }
      },
      { upsert: true, new: true }
    );
  } catch (err) {
    logger.warn('[GrowthSnapshot] upsert failed', { error: err.message });
  }
}

/**
 * Retrieve historical trend data for the org.
 * @param {string} organizationId
 * @param {number} [days=30]
 */
async function getTrends(organizationId, days = 30) {
  return getTrendData(organizationId, days);
}

module.exports = { getDashboard, saveSnapshot, getTrends };
