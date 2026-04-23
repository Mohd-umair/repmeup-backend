/**
 * Unit tests for analyticsService.
 *
 * We focus on three things:
 *   1. Pure helpers (math + filter builders) — trivially testable.
 *   2. assembleDashboardDto — the chunky shaping step that used to live
 *      inside the controller. Feed it synthetic aggregation outputs and
 *      verify the DTO shape + math.
 *   3. Orchestrators — verify they fan out to the right Mongoose calls with
 *      the right filter and collapse the results correctly. Mongoose models
 *      are stubbed; no DB connection is required.
 */

// ── Jest-hoisted mocks for the Mongoose models ───────────────────────────────
const mockInteractionAggregate = jest.fn(async () => []);
const mockInteractionCountDocuments = jest.fn(async () => 0);
const mockInteractionFindChain = jest.fn(async () => []);
const mockScheduledPostCountDocuments = jest.fn(async () => 0);

jest.mock('../../../src/models/Interaction', () => {
  // Fully chainable Mongoose-style find() that terminates by awaiting the
  // mock so tests can control the returned rows.
  const handler = {
    get(_target, prop) {
      if (prop === 'then') return (onFulfilled, onRejected) =>
        mockInteractionFindChain().then(onFulfilled, onRejected);
      if (prop === 'lean' || prop === 'exec') return () => mockInteractionFindChain();
      return () => new Proxy({}, handler);
    }
  };
  return {
    aggregate: (...a) => mockInteractionAggregate(...a),
    countDocuments: (...a) => mockInteractionCountDocuments(...a),
    find: () => new Proxy({}, handler)
  };
});

jest.mock('../../../src/models/ScheduledPost', () => ({
  countDocuments: (...a) => mockScheduledPostCountDocuments(...a)
}));

const analyticsService = require('../../../src/services/analyticsService');
const {
  buildMatchFilter,
  buildPrevMatchFilter,
  calcChange,
  computeResponseRate,
  computeAvgResponseTime,
  computeSentimentScore,
  computeMedian,
  foldSentimentBreakdown,
  assembleDashboardDto,
  getDashboardData,
  getPlatformAnalyticsData,
  getEngagementAnalyticsData,
  getAgentData,
  getExportAnalyticsData,
  getContentPerformanceData
} = analyticsService;

beforeEach(() => {
  mockInteractionAggregate.mockReset().mockResolvedValue([]);
  mockInteractionCountDocuments.mockReset().mockResolvedValue(0);
  mockInteractionFindChain.mockReset().mockResolvedValue([]);
  mockScheduledPostCountDocuments.mockReset().mockResolvedValue(0);
});

// ════════════════════════════════════════════════════════════════════════════
// 1. Filter builders
// ════════════════════════════════════════════════════════════════════════════
describe('buildMatchFilter', () => {
  const start = new Date('2025-01-01');
  const end = new Date('2025-01-31');

  it('always includes organization and platformCreatedAt window', () => {
    const f = buildMatchFilter('org_1', { startDate: start, endDate: end });
    expect(f.organization).toBe('org_1');
    expect(f.platformCreatedAt).toEqual({ $gte: start, $lte: end });
  });

  it('adds $in filters only when the array is non-empty', () => {
    const f = buildMatchFilter('org_1', {
      startDate: start, endDate: end,
      platforms: ['instagram'], types: [], sentiment: ['positive', 'neutral'], status: undefined
    });
    expect(f.platform).toEqual({ $in: ['instagram'] });
    expect(f.sentiment).toEqual({ $in: ['positive', 'neutral'] });
    expect(f.type).toBeUndefined();
    expect(f.status).toBeUndefined();
  });

  it('handles totally empty filters object without throwing', () => {
    const f = buildMatchFilter('org_1', { startDate: start, endDate: end });
    expect(Object.keys(f).sort()).toEqual(['organization', 'platformCreatedAt']);
  });
});

describe('buildPrevMatchFilter', () => {
  it('shifts the window backward by exactly the window length', () => {
    const match = {
      organization: 'org_1',
      platform: { $in: ['instagram'] },
      platformCreatedAt: {
        $gte: new Date('2025-01-11T00:00:00Z'),
        $lte: new Date('2025-01-21T00:00:00Z')
      }
    };
    const prev = buildPrevMatchFilter(match);
    expect(prev.platformCreatedAt.$gte).toEqual(new Date('2025-01-01T00:00:00Z'));
    expect(prev.platformCreatedAt.$lte).toEqual(new Date('2025-01-11T00:00:00Z'));
    expect(prev.organization).toBe('org_1');
    expect(prev.platform).toEqual({ $in: ['instagram'] });
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 2. Pure math helpers
// ════════════════════════════════════════════════════════════════════════════
describe('calcChange', () => {
  it.each([
    [100, 50, 100],      // double → +100%
    [50, 100, -50],      // halved → -50%
    [10, 10, 0],         // equal → 0
    [5, 0, 100],         // previous=0, current>0 → 100 (special case)
    [0, 0, 0],           // both zero → 0
    [0, 10, -100]        // dropped to zero → -100
  ])('calcChange(%i, %i) === %i', (cur, prev, expected) => {
    expect(calcChange(cur, prev)).toBe(expected);
  });

  it('rounds to 1 decimal place', () => {
    expect(calcChange(123, 100)).toBe(23);
    expect(calcChange(1234, 1000)).toBe(23.4);
  });
});

describe('computeResponseRate', () => {
  it('returns 0 when totalInteractions is zero (no divide-by-zero)', () => {
    expect(computeResponseRate(0, 0)).toBe(0);
    expect(computeResponseRate(0, 5)).toBe(0);
  });
  it('returns a percentage 0-100', () => {
    expect(computeResponseRate(10, 7)).toBe(70);
    expect(computeResponseRate(4, 1)).toBe(25);
  });
});

describe('computeAvgResponseTime', () => {
  it('returns 0 when respondedCount is zero', () => {
    expect(computeAvgResponseTime(99999, 0)).toBe(0);
  });
  it('converts total ms to per-reply minutes', () => {
    // 5 replies, 5 minutes total in ms (5 * 60000) → 1 minute avg
    expect(computeAvgResponseTime(5 * 60000, 5)).toBe(1);
    expect(computeAvgResponseTime(120000, 2)).toBe(1); // 2 replies, 2 min total → 1 min avg
  });
});

describe('computeSentimentScore', () => {
  it('returns 50 (neutral) when total is zero (no data = no opinion)', () => {
    expect(computeSentimentScore({}, 0)).toBe(50);
  });
  it('all-positive → 100', () => {
    expect(computeSentimentScore({ positive: 10, neutral: 0, negative: 0 }, 10)).toBe(100);
  });
  it('all-negative → 0', () => {
    expect(computeSentimentScore({ positive: 0, neutral: 0, negative: 10 }, 10)).toBe(0);
  });
  it('mix weights neutral at 50', () => {
    // 5 pos, 5 neut → (500 + 250) / 10 = 75
    expect(computeSentimentScore({ positive: 5, neutral: 5, negative: 0 }, 10)).toBe(75);
  });
});

describe('computeMedian', () => {
  it('returns 0 for empty or nullish arrays', () => {
    expect(computeMedian([])).toBe(0);
    expect(computeMedian(null)).toBe(0);
    expect(computeMedian(undefined)).toBe(0);
  });
  it('odd length → middle value', () => {
    expect(computeMedian([3, 1, 2])).toBe(2);
  });
  it('even length → average of two middle values', () => {
    expect(computeMedian([1, 2, 3, 4])).toBe(2.5);
  });
  it('does NOT mutate the input array', () => {
    const input = [3, 1, 2];
    computeMedian(input);
    expect(input).toEqual([3, 1, 2]);
  });
});

describe('foldSentimentBreakdown', () => {
  it('folds rows into the canonical shape', () => {
    const rows = [
      { _id: 'positive', count: 5 },
      { _id: 'neutral', count: 3 },
      { _id: 'negative', count: 2 }
    ];
    expect(foldSentimentBreakdown(rows)).toEqual({
      positive: 5, neutral: 3, negative: 2, total: 10
    });
  });
  it('ignores unknown _id values and defaults missing to 0', () => {
    const rows = [
      { _id: 'positive', count: 4 },
      { _id: 'garbage', count: 99 },
      { _id: null, count: 1 }
    ];
    const out = foldSentimentBreakdown(rows);
    expect(out.positive).toBe(4);
    expect(out.neutral).toBe(0);
    expect(out.negative).toBe(0);
    expect(out.total).toBe(4);
  });
  it('honors explicit totalOverride (used when we already counted documents)', () => {
    const rows = [{ _id: 'positive', count: 5 }];
    expect(foldSentimentBreakdown(rows, 20).total).toBe(20);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 3. assembleDashboardDto — the DTO shaping contract
// ════════════════════════════════════════════════════════════════════════════
describe('assembleDashboardDto', () => {
  // A minimal but realistic input with enough variety to exercise the shaping logic.
  const baseInput = () => ({
    totalInteractions: 100,
    responseMetrics: [{
      totalResponded: 80,
      totalResponseTime: 80 * 60000 * 2, // 80 replies, avg 2 min each (in ms)
      respondedCount: 80
    }],
    platformMetrics: [{
      platform: 'instagram',
      totalInteractions: 60,
      responded: 50,
      pending: 10,
      avgResponseTime: 180000 // 3 minutes in ms
    }],
    sentimentBreakdown: [
      { _id: 'positive', count: 60 },
      { _id: 'neutral', count: 30 },
      { _id: 'negative', count: 10 }
    ],
    timeSeriesData: [{ date: '2025-01-01', interactions: 10, responses: 8 }],
    responseTimeMetrics: [{
      stats: [{ avg: 3.5, min: 1, max: 10, times: [1, 2, 3, 4, 10] }],
      distribution: [
        { _id: 0, count: 50 },
        { _id: 60, count: 25 },
        { _id: 1440, count: 5 }
      ]
    }],
    intentBreakdown: [
      { _id: 'b1', count: 20, name: 'Complaint', color: '#F00', icon: 'i1' },
      { _id: 'b2', count: 10, name: 'Praise', color: '#0F0', icon: 'i2' }
    ],
    aiVsHumanReplies: [{ aiReplies: 40, humanReplies: 40, totalReplies: 80 }],
    topInteractions: [{
      _id: 'post_1',
      platform: 'instagram',
      postUrl: 'https://ig/p/1',
      commentCount: 20,
      totalLikes: 100,
      totalViews: 1000,
      positiveCount: 15,
      negativeCount: 3,
      neutralCount: 2,
      latestDate: new Date('2025-01-15'),
      latestContent: 'short interaction',
      postContent: null,
      postMediaUrl: 'https://cdn/x.jpg'
    }],
    prevTotalInteractions: 80,
    prevResponseMetrics: [{
      totalResponded: 40, totalResponseTime: 40 * 60000 * 3, respondedCount: 40
    }],
    prevSentimentBreakdown: [{ _id: 'positive', count: 40 }, { _id: 'neutral', count: 40 }],
    startDate: new Date('2025-01-01'),
    endDate: new Date('2025-01-31'),
    preset: 'last_30_days'
  });

  it('produces the top-level DTO contract (the shape the frontend relies on)', () => {
    const dto = assembleDashboardDto(baseInput());
    expect(Object.keys(dto).sort()).toEqual([
      'aiVsHuman', 'autoReplyMetrics', 'dateRange', 'intentBreakdown',
      'overview', 'platformMetrics', 'responseTimeMetrics', 'sentimentBreakdown',
      'timeSeries', 'topInteractions'
    ]);
    expect(Object.keys(dto.overview).sort()).toEqual([
      'avgResponseTime', 'responseRate', 'sentimentScore', 'totalInteractions'
    ]);
  });

  it('overview.totalInteractions echoes the raw count and tags change vs previous', () => {
    const dto = assembleDashboardDto(baseInput());
    expect(dto.overview.totalInteractions.value).toBe(100);
    // 100 vs 80 → +25%
    expect(dto.overview.totalInteractions.change).toBe(25);
    expect(dto.overview.totalInteractions.changeType).toBe('increase');
  });

  it('responseRate is a rounded percentage', () => {
    const dto = assembleDashboardDto(baseInput());
    // 80/100 = 80%
    expect(dto.overview.responseRate.value).toBe(80);
  });

  it('avgResponseTime is in minutes, rounded, and INVERTS the changeType', () => {
    // Current avg: 2 min. Previous avg: 3 min. Lower = better = "increase"
    const dto = assembleDashboardDto(baseInput());
    expect(dto.overview.avgResponseTime.value).toBe(2);
    expect(dto.overview.avgResponseTime.changeType).toBe('increase');
  });

  it('platformMetrics converts avgResponseTime from ms to minutes', () => {
    const dto = assembleDashboardDto(baseInput());
    // Input 180000 ms → 3 min
    expect(dto.platformMetrics[0].avgResponseTime).toBe(3);
  });

  it('responseTimeMetrics computes median, buckets within1Hour/24Hours/over24Hours', () => {
    const dto = assembleDashboardDto(baseInput());
    // Times [1,2,3,4,10] → median = 3
    expect(dto.responseTimeMetrics.median).toBe(3);
    expect(dto.responseTimeMetrics.within1Hour).toBe(50);
    expect(dto.responseTimeMetrics.within24Hours).toBe(25);
    expect(dto.responseTimeMetrics.over24Hours).toBe(5);
  });

  it('intentBreakdown keys by bucket id and records meta alongside', () => {
    const dto = assembleDashboardDto(baseInput());
    expect(dto.intentBreakdown.total).toBe(30);
    expect(dto.intentBreakdown.data).toEqual({ b1: 20, b2: 10 });
    expect(dto.intentBreakdown.meta.b1).toEqual({
      name: 'Complaint', color: '#F00', icon: 'i1'
    });
  });

  it('topInteractions truncates long content and carries mediaUrl', () => {
    const input = baseInput();
    input.topInteractions[0].latestContent = 'x'.repeat(200);
    input.topInteractions[0].postContent = null;
    const dto = assembleDashboardDto(input);
    expect(dto.topInteractions[0].content.endsWith('…')).toBe(true);
    expect(dto.topInteractions[0].content.length).toBe(81); // 80 chars + ellipsis
    expect(dto.topInteractions[0].mediaUrl).toBe('https://cdn/x.jpg');
  });

  it('falls back to safe defaults when all aggregation results are empty', () => {
    const dto = assembleDashboardDto({
      totalInteractions: 0,
      responseMetrics: [],
      platformMetrics: [],
      sentimentBreakdown: [],
      timeSeriesData: [],
      responseTimeMetrics: [],
      intentBreakdown: [],
      aiVsHumanReplies: [],
      topInteractions: [],
      prevTotalInteractions: 0,
      prevResponseMetrics: [],
      prevSentimentBreakdown: [],
      startDate: new Date('2025-01-01'),
      endDate: new Date('2025-01-31'),
      preset: 'custom'
    });
    expect(dto.overview.totalInteractions.value).toBe(0);
    expect(dto.overview.responseRate.value).toBe(0);
    expect(dto.overview.sentimentScore.value).toBe(50);      // neutral default
    expect(dto.responseTimeMetrics).toEqual({
      avg: 0, median: 0, fastest: 0, slowest: 0,
      within1Hour: 0, within24Hours: 0, over24Hours: 0
    });
    expect(dto.aiVsHuman.aiPercent).toBe(0);
  });

  it('aiVsHuman.aiPercent rounds to nearest integer', () => {
    const input = baseInput();
    input.aiVsHumanReplies = [{ aiReplies: 33, humanReplies: 67, totalReplies: 100 }];
    const dto = assembleDashboardDto(input);
    expect(dto.aiVsHuman.aiPercent).toBe(33);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 4. Orchestrators — verify wiring to the DB layer
// ════════════════════════════════════════════════════════════════════════════
describe('getDashboardData', () => {
  const filters = {
    startDate: new Date('2025-01-01'),
    endDate: new Date('2025-01-31'),
    platforms: ['instagram']
  };

  it('runs exactly 12 parallel Mongo operations (9 current + 3 previous)', async () => {
    await getDashboardData('org_1', filters);
    // 10 aggregations (9 current + 2 prev aggregates)
    expect(mockInteractionAggregate).toHaveBeenCalledTimes(10);
    // 2 countDocuments (1 current + 1 prev)
    expect(mockInteractionCountDocuments).toHaveBeenCalledTimes(2);
  });

  it('all current-period calls match on the exact filter built from inputs', async () => {
    await getDashboardData('org_1', filters);
    const firstCall = mockInteractionAggregate.mock.calls[0][0];
    expect(firstCall[0]).toEqual({
      $match: {
        organization: 'org_1',
        platformCreatedAt: { $gte: filters.startDate, $lte: filters.endDate },
        platform: { $in: ['instagram'] }
      }
    });
  });

  it('passes meta.preset through to the assembled DTO', async () => {
    mockInteractionCountDocuments.mockResolvedValue(5);
    const dto = await getDashboardData('org_1', filters, { preset: 'last_7_days' });
    expect(dto.dateRange.preset).toBe('last_7_days');
    expect(dto.overview.totalInteractions.value).toBe(5);
  });

  it('defaults preset to "custom" when meta is omitted', async () => {
    const dto = await getDashboardData('org_1', filters);
    expect(dto.dateRange.preset).toBe('custom');
  });
});

describe('getPlatformAnalyticsData', () => {
  it('runs a single aggregation and returns the first doc (or null)', async () => {
    mockInteractionAggregate.mockResolvedValue([{ overview: [{ _id: null, total: 5 }] }]);
    const out = await getPlatformAnalyticsData(
      'org_1', 'instagram', new Date('2025-01-01'), new Date('2025-01-31')
    );
    expect(mockInteractionAggregate).toHaveBeenCalledTimes(1);
    expect(out).toEqual({ overview: [{ _id: null, total: 5 }] });
  });

  it('returns null when the aggregation returns no rows', async () => {
    mockInteractionAggregate.mockResolvedValue([]);
    const out = await getPlatformAnalyticsData(
      'org_1', 'facebook', new Date('2025-01-01'), new Date('2025-01-31')
    );
    expect(out).toBeNull();
  });
});

describe('getEngagementAnalyticsData', () => {
  const filters = {
    startDate: new Date('2025-01-01'),
    endDate: new Date('2025-01-31')
  };

  it('fans out to 3 aggregations + 1 find and returns the 4-section DTO', async () => {
    mockInteractionAggregate.mockResolvedValue([]);
    mockInteractionFindChain.mockResolvedValue([{ content: 'hi' }]);

    const out = await getEngagementAnalyticsData('org_1', filters);
    expect(mockInteractionAggregate).toHaveBeenCalledTimes(3);
    expect(mockInteractionFindChain).toHaveBeenCalled();
    expect(Object.keys(out).sort()).toEqual([
      'byPlatform', 'overview', 'timeSeries', 'topInteractions'
    ]);
    expect(out.topInteractions).toEqual([{ content: 'hi' }]);
  });

  it('computes avgEngagementRate from totals, 2 decimal places', async () => {
    mockInteractionAggregate
      .mockResolvedValueOnce([{
        totalLikes: 40, totalShares: 10, totalViews: 1000, totalInteractions: 20
      }])
      .mockResolvedValue([]); // others
    const out = await getEngagementAnalyticsData('org_1', filters);
    // (40+10)/20 * 100 = 250.00
    expect(out.overview.avgEngagementRate).toBe(250);
  });

  it('avgEngagementRate is 0 when totalInteractions is 0 (no divide-by-zero)', async () => {
    mockInteractionAggregate.mockResolvedValue([]);
    const out = await getEngagementAnalyticsData('org_1', filters);
    expect(out.overview.avgEngagementRate).toBe(0);
    expect(out.overview.totalInteractions).toBe(0);
  });
});

describe('getAgentData', () => {
  it('computes teamAverages from the aggregated agent list', async () => {
    mockInteractionAggregate.mockResolvedValue([
      { userId: 'u1', avgResponseTime: 10, totalResolved: 8, totalAssigned: 10 },
      { userId: 'u2', avgResponseTime: 20, totalResolved: 3, totalAssigned: 10 }
    ]);
    const out = await getAgentData('org_1', new Date('2025-01-01'), new Date('2025-01-31'));
    expect(out.agents).toHaveLength(2);
    expect(out.teamAverages).toEqual({
      avgResponseTime: 15,       // (10+20)/2
      resolutionRate: 55         // (11/20)*100 = 55.0
    });
  });

  it('teamAverages is {0,0} when there are no agents (avoids divide-by-zero)', async () => {
    mockInteractionAggregate.mockResolvedValue([]);
    const out = await getAgentData('org_1', new Date('2025-01-01'), new Date('2025-01-31'));
    expect(out.agents).toEqual([]);
    expect(out.teamAverages).toEqual({ avgResponseTime: 0, resolutionRate: 0 });
  });
});

describe('getExportAnalyticsData', () => {
  it('returns the 3-section blob used by exportService', async () => {
    mockInteractionAggregate
      .mockResolvedValueOnce([{ platform: 'instagram', totalInteractions: 10 }]) // platform
      .mockResolvedValueOnce([{ _id: 'positive', count: 5 }])                     // sentiment rows
      .mockResolvedValueOnce([{ avg: 100, within1Hour: 2 }]);                     // rt

    const out = await getExportAnalyticsData('org_1', {
      startDate: new Date('2025-01-01'),
      endDate: new Date('2025-01-31'),
      platforms: ['instagram']
    });

    expect(out.platformMetrics).toEqual([{ platform: 'instagram', totalInteractions: 10 }]);
    expect(out.sentimentBreakdown).toEqual({
      positive: 5, neutral: 0, negative: 0, total: 5
    });
    expect(out.responseTimeMetrics).toEqual({ avg: 100, within1Hour: 2 });
  });

  it('handles an empty response-time aggregation gracefully', async () => {
    mockInteractionAggregate
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    const out = await getExportAnalyticsData('org_1', {
      startDate: new Date('2025-01-01'),
      endDate: new Date('2025-01-31')
    });
    expect(out.responseTimeMetrics).toEqual({});
  });
});

describe('getContentPerformanceData', () => {
  it('returns 0/0/0 when both counts are zero (no divide-by-zero)', async () => {
    mockScheduledPostCountDocuments.mockResolvedValue(0);
    const out = await getContentPerformanceData('org_1');
    expect(out).toEqual({ aiCount: 0, humanCount: 0, total: 0, aiPercent: 0 });
  });

  it('computes aiPercent rounded to nearest integer', async () => {
    // first call = ai, second = human
    mockScheduledPostCountDocuments
      .mockResolvedValueOnce(7)
      .mockResolvedValueOnce(3);
    const out = await getContentPerformanceData('org_1');
    expect(out).toEqual({ aiCount: 7, humanCount: 3, total: 10, aiPercent: 70 });
  });

  it('uses a trailing 30-day window when no startDate is supplied', async () => {
    const before = Date.now();
    await getContentPerformanceData('org_1');
    const after = Date.now();
    const aiFilter = mockScheduledPostCountDocuments.mock.calls[0][0];
    const windowStartMs = aiFilter.publishedAt.$gte.getTime();
    // Should be ~30 days ago (within the duration of the test execution)
    const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
    expect(windowStartMs).toBeGreaterThanOrEqual(before - thirtyDaysMs - 100);
    expect(windowStartMs).toBeLessThanOrEqual(after - thirtyDaysMs + 100);
  });

  it('respects an explicit startDate override', async () => {
    const custom = new Date('2024-06-01');
    await getContentPerformanceData('org_1', custom);
    expect(mockScheduledPostCountDocuments.mock.calls[0][0].publishedAt.$gte).toBe(custom);
  });
});
