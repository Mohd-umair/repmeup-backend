const analyticsService = require('../services/analyticsService');
const exportService = require('../services/exportService');
const cacheService = require('../services/cacheService');
const logger = require('../config/logger');

/**
 * Analytics Controller — thin HTTP + cache layer.
 *
 * All aggregation logic lives in `services/analyticsService.js`. This file
 * is intentionally dumb: parse the request, hit the cache, call the
 * service, cache the result, send the DTO.
 *
 * Caching strategy
 * ────────────────
 *   - Each cacheable endpoint wraps its payload with a per-org cache entry
 *     keyed by (orgId, endpoint, normalized filters). Default TTL is 60s
 *     (override via ANALYTICS_CACHE_TTL_SECONDS).
 *   - Default date ranges round endDate down to the start of the current
 *     minute so burst requests within the same minute share a cache key.
 *   - exportData (binary download) and getSuggestedImprovements (static)
 *     are intentionally NOT cached.
 *   - To force-invalidate after a major write, call
 *     cacheService.invalidateAnalytics(orgId).
 */

const ANALYTICS_TTL_SECONDS =
  parseInt(process.env.ANALYTICS_CACHE_TTL_SECONDS, 10) || 60;
const CONTENT_PERFORMANCE_TTL_SECONDS = 300; // 5 min — fixed last-30-day window

/** Round a date down to the start of the current minute. */
function roundToMinute(d) {
  const t = new Date(d);
  t.setSeconds(0, 0);
  return t;
}

/**
 * Resolve a date range from the request body.
 * - Explicit ranges are passed through unchanged.
 * - Defaulted ranges (trailing 30 days) round to the current minute so that
 *   the cache key derived from them is stable for ~60s of burst traffic.
 */
function resolveDateRange(dateRange) {
  if (dateRange?.startDate && dateRange?.endDate) {
    // Round to the minute so cache keys are stable across burst requests in the same minute.
    return {
      startDate: roundToMinute(new Date(dateRange.startDate)),
      endDate:   roundToMinute(new Date(dateRange.endDate)),
      defaulted: false
    };
  }
  const endDate   = roundToMinute(new Date());
  const startDate = new Date(endDate.getTime() - 30 * 24 * 60 * 60 * 1000);
  return { startDate, endDate, defaulted: true };
}

// ═══════════════════════════════════════════════════════════════════════════
// Endpoints
// ═══════════════════════════════════════════════════════════════════════════

exports.getDashboard = async (req, res, next) => {
  try {
    const organizationId = req.user.organization._id;
    const { dateRange, platforms, types, sentiment, status } = req.body;
    const { startDate, endDate } = resolveDateRange(dateRange);

    const cacheKey = cacheService.analyticsHashKey(organizationId, 'dashboard', {
      startDate, endDate, platforms, types, sentiment, status
    });
    const cached = await cacheService.get(cacheKey);
    if (cached) {
      return res.status(200).json({ success: true, data: cached, cached: true });
    }

    const dashboard = await analyticsService.getDashboardData(
      organizationId,
      { startDate, endDate, platforms, types, sentiment, status },
      { preset: dateRange?.preset }
    );

    await cacheService.set(cacheKey, dashboard, ANALYTICS_TTL_SECONDS);
    res.status(200).json({ success: true, data: dashboard });
  } catch (error) {
    logger.error('[Analytics] Dashboard error', { error: error.message, stack: error.stack });
    next(error);
  }
};

exports.getPlatformAnalytics = async (req, res, next) => {
  try {
    const organizationId = req.user.organization._id;
    const { platform } = req.params;
    const { dateRange } = req.body;
    const { startDate, endDate } = resolveDateRange(dateRange);

    const cacheKey = cacheService.analyticsHashKey(
      organizationId,
      `platform:${platform}`,
      { startDate, endDate }
    );
    const cached = await cacheService.get(cacheKey);
    if (cached) {
      return res.status(200).json({ success: true, data: cached, cached: true });
    }

    const payload = await analyticsService.getPlatformAnalyticsData(
      organizationId, platform, startDate, endDate
    );

    await cacheService.set(cacheKey, payload, ANALYTICS_TTL_SECONDS);
    res.status(200).json({ success: true, data: payload });
  } catch (error) {
    logger.error('[Analytics] Platform analytics error', {
      error: error.message, stack: error.stack
    });
    next(error);
  }
};

exports.exportData = async (req, res, next) => {
  try {
    const organizationId = req.user.organization._id;
    const { dateRange, format = 'csv', reportType = 'platform', platforms } = req.body;

    // Export endpoints bypass the minute-rounding used by cached endpoints —
    // exports are one-shot downloads and we want the exact window in the file.
    const startDate = dateRange?.startDate
      ? new Date(dateRange.startDate)
      : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const endDate = dateRange?.endDate ? new Date(dateRange.endDate) : new Date();

    const fmtDate = (d) => d.toLocaleDateString('en-GB');
    const dateRangeLabel = { start: fmtDate(startDate), end: fmtDate(endDate) };

    let reportData;

    if (reportType === 'agent') {
      const agentData = await analyticsService.getAgentData(organizationId, startDate, endDate);
      const { csv, excelSheets, pdfSections } = exportService.formatAgentReport(
        agentData, dateRangeLabel
      );
      reportData = { csv, excelSheets, pdfSections, title: 'Agent Performance Report' };
    } else {
      const analytics = await analyticsService.getExportAnalyticsData(organizationId, {
        startDate, endDate, platforms
      });

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
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${safeName}-${Date.now()}.csv"`);
      return res.send(reportData.csv);
    }

    if (format === 'xlsx') {
      const buffer = await exportService.generateExcel(reportData.title, reportData.excelSheets);
      res.setHeader(
        'Content-Type',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      );
      res.setHeader('Content-Disposition', `attachment; filename="${safeName}-${Date.now()}.xlsx"`);
      return res.send(buffer);
    }

    if (format === 'pdf') {
      const buffer = await exportService.generatePDF({
        title: reportData.title,
        dateRange: dateRangeLabel,
        sections: reportData.pdfSections
      });
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${safeName}-${Date.now()}.pdf"`);
      return res.send(buffer);
    }

    res.status(400).json({
      success: false,
      error: 'Invalid export format. Use csv, xlsx, or pdf.'
    });
  } catch (error) {
    logger.error('[Analytics] Export error', { error: error.message, stack: error.stack });
    next(error);
  }
};

exports.getAgentAnalytics = async (req, res, next) => {
  try {
    const organizationId = req.user.organization._id;
    const { dateRange, agentId } = req.body;
    const { startDate, endDate } = resolveDateRange(dateRange);

    // Cache key intentionally excludes agentId — we cache the FULL agent
    // dataset for the org and apply the per-agent filter in memory afterwards.
    // That way every user in the org shares the same cached aggregation
    // regardless of which agent they happen to be viewing.
    const cacheKey = cacheService.analyticsHashKey(organizationId, 'agents', {
      startDate, endDate
    });

    let data = await cacheService.get(cacheKey);
    const cacheHit = !!data;
    if (!data) {
      data = await analyticsService.getAgentData(organizationId, startDate, endDate);
      await cacheService.set(cacheKey, data, ANALYTICS_TTL_SECONDS);
    }

    if (agentId) {
      data = {
        ...data,
        agents: data.agents.filter((a) => String(a.userId) === String(agentId))
      };
    }

    res.status(200).json({ success: true, data, cached: cacheHit });
  } catch (error) {
    logger.error('[Analytics] Agent analytics error', {
      error: error.message, stack: error.stack
    });
    next(error);
  }
};

exports.getEngagementAnalytics = async (req, res, next) => {
  try {
    const organizationId = req.user.organization._id;
    const { dateRange, platforms } = req.body;
    const { startDate, endDate } = resolveDateRange(dateRange);

    const cacheKey = cacheService.analyticsHashKey(organizationId, 'engagement', {
      startDate, endDate, platforms
    });
    const cached = await cacheService.get(cacheKey);
    if (cached) {
      return res.status(200).json({ success: true, data: cached, cached: true });
    }

    const payload = await analyticsService.getEngagementAnalyticsData(
      organizationId, { startDate, endDate, platforms }
    );

    await cacheService.set(cacheKey, payload, ANALYTICS_TTL_SECONDS);
    res.status(200).json({ success: true, data: payload });
  } catch (error) {
    logger.error('[Analytics] Engagement analytics error', {
      error: error.message, stack: error.stack
    });
    next(error);
  }
};

/**
 * GET /api/analytics/content-performance
 * AI vs human post performance over last 30 days.
 * Cache bucketed per calendar day so the result is shared across org users
 * and naturally rolls over at midnight UTC.
 */
exports.getContentPerformance = async (req, res) => {
  try {
    const organizationId = req.user.organization?._id || req.user.organization;

    const today = new Date().toISOString().substring(0, 10);
    const cacheKey = cacheService.analyticsKey(organizationId, 'content-performance', today);
    const cached = await cacheService.get(cacheKey);
    if (cached) {
      return res.status(200).json({ success: true, data: cached, cached: true });
    }

    const payload = await analyticsService.getContentPerformanceData(organizationId);
    await cacheService.set(cacheKey, payload, CONTENT_PERFORMANCE_TTL_SECONDS);
    res.status(200).json({ success: true, data: payload });
  } catch (error) {
    logger.error('[Analytics] Content performance error', {
      error: error.message, stack: error.stack
    });
    res.status(500).json({ success: false, error: error.message });
  }
};

/**
 * GET /api/analytics/suggested-improvements
 * Placeholder for AI-generated insights (wire to aiService when ready).
 */
exports.getSuggestedImprovements = async (req, res) => {
  try {
    const suggestions = [
      {
        id: '1',
        type: 'cadence',
        title: 'Post more consistently',
        description: 'Posts published on weekdays between 9–11 AM tend to get higher engagement.'
      },
      {
        id: '2',
        type: 'content',
        title: 'Use more visuals',
        description: 'Posts with images or video have 2x higher engagement than text-only.'
      },
      {
        id: '3',
        type: 'hashtags',
        title: 'Optimize hashtags',
        description: 'Use 3–5 relevant hashtags per post for better discoverability.'
      }
    ];
    res.status(200).json({ success: true, data: suggestions });
  } catch (error) {
    logger.error('[Analytics] Suggested improvements error', {
      error: error.message, stack: error.stack
    });
    res.status(500).json({ success: false, error: error.message });
  }
};

// Exported for tests — same helpers the controller uses so cache keys stay
// identical whether the request came from the HTTP layer or a test harness.
exports._internal = { roundToMinute, resolveDateRange };
