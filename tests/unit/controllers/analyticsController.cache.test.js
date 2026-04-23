/**
 * Contract tests for the Redis caching that was just added to
 * analyticsController.js. The aggregation logic itself isn't exercised — the
 * point is to lock down the *cache contract*:
 *
 *   - Cache HIT short-circuits and returns immediately with cached: true.
 *   - Cache MISS runs the aggregation and writes to the cache with the right TTL.
 *   - Different filter inputs produce different cache keys.
 *   - getAgentAnalytics caches the FULL agent dataset and applies the per-agent
 *     filter in memory afterwards (so two agents share one cached aggregation).
 *
 * All Mongo models and the exportService are stubbed so no DB connection is
 * required. Aggregation results are returned as empty arrays — the controller
 * composes its response payload from those gracefully.
 */

// ── Mock the cache service first; we drive cache hits/misses from the test. ──
const mockCacheGet = jest.fn();
const mockCacheSet = jest.fn(async () => true);

jest.mock('../../../src/services/cacheService', () => {
  // Stub the Redis client the real cacheService would import at construct time,
  // then use the real key-derivation helpers so tests exercise real cache keys.
  jest.doMock('../../../src/config/redis', () => ({
    getRedisClient: () => { throw new Error('Redis must not be called in unit tests'); }
  }));
  const real = jest.requireActual('../../../src/services/cacheService');
  return {
    get: (...args) => mockCacheGet(...args),
    set: (...args) => mockCacheSet(...args),
    analyticsHashKey: real.analyticsHashKey.bind(real),
    analyticsKey: real.analyticsKey.bind(real)
  };
});

// ── Stub out every model the controller transitively requires. ──────────────
// Jest hoists jest.mock() calls above require(), so any variable the factory
// references must start with `mock` to pass the hoist-time safety check.
const mockInteractionAggregate = jest.fn(async () => []);
const mockInteractionCountDocuments = jest.fn(async () => 0);

jest.mock('../../../src/models/Interaction', () => {
  // Fully chainable Mongoose-style find() that terminates in [] — supports
  // any chain of .sort/.limit/.select/.populate/.lean etc.
  const handler = {
    get(_target, prop) {
      if (prop === 'then') return undefined;               // not a thenable
      if (prop === 'lean' || prop === 'exec') return async () => [];
      return () => new Proxy({}, handler);                 // anything else chains
    }
  };
  return {
    aggregate: (...a) => mockInteractionAggregate(...a),
    countDocuments: (...a) => mockInteractionCountDocuments(...a),
    find: () => new Proxy({}, handler)
  };
});

jest.mock('../../../src/models/PlatformConnection', () => ({
  countDocuments: async () => 0,
  find: () => ({ select: () => ({ lean: async () => [] }) })
}));

jest.mock('../../../src/models/User', () => ({
  countDocuments: async () => 0,
  find: () => ({
    select: () => ({ lean: async () => [] })
  })
}));

jest.mock('../../../src/models/ScheduledPost', () => ({
  countDocuments: async () => 0,
  find: () => ({ select: () => ({ lean: async () => [] }) }),
  aggregate: async () => []
}));

jest.mock('../../../src/services/exportService', () => ({}));

const analyticsController = require('../../../src/controllers/analyticsController');

const ORG_ID = 'org_42';

function makeReqRes({ body = {} } = {}) {
  const req = {
    user: { organization: { _id: ORG_ID } },
    body
  };
  const res = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis()
  };
  const next = jest.fn();
  return { req, res, next };
}

beforeEach(() => {
  mockCacheGet.mockReset();
  mockCacheSet.mockReset().mockResolvedValue(true);
  mockInteractionAggregate.mockReset().mockResolvedValue([]);
  mockInteractionCountDocuments.mockReset().mockResolvedValue(0);
});

// ────────────────────────────────────────────────────────────────────────────
describe('getDashboard caching', () => {
  it('cache HIT returns cached payload immediately and does not query Mongo', async () => {
    const cachedPayload = { totalInteractions: 42, fromCache: true };
    mockCacheGet.mockResolvedValue(cachedPayload);

    const { req, res, next } = makeReqRes();
    await analyticsController.getDashboard(req, res, next);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      success: true,
      data: cachedPayload,
      cached: true
    });
    expect(mockInteractionAggregate).not.toHaveBeenCalled();
    expect(mockInteractionCountDocuments).not.toHaveBeenCalled();
    expect(mockCacheSet).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });

  it('cache MISS runs the aggregation and writes the result to cache', async () => {
    mockCacheGet.mockResolvedValue(null);

    const { req, res, next } = makeReqRes();
    await analyticsController.getDashboard(req, res, next);

    expect(res.status).toHaveBeenCalledWith(200);
    // Aggregation was actually executed at least once
    expect(mockInteractionAggregate.mock.calls.length).toBeGreaterThan(0);
    // Cache write happened with TTL = 60s default
    expect(mockCacheSet).toHaveBeenCalledTimes(1);
    const [, , ttl] = mockCacheSet.mock.calls[0];
    expect(ttl).toBe(60);

    // Response should NOT have cached: true on a MISS
    const jsonArg = res.json.mock.calls[0][0];
    expect(jsonArg.success).toBe(true);
    expect(jsonArg.cached).toBeUndefined();
    expect(next).not.toHaveBeenCalled();
  });

  it('produces different cache keys for different platform filters', async () => {
    mockCacheGet.mockResolvedValue(null);

    const a = makeReqRes({ body: { platforms: ['instagram'] } });
    await analyticsController.getDashboard(a.req, a.res, a.next);
    const keyA = mockCacheGet.mock.calls[0][0];

    mockCacheGet.mockClear();
    mockCacheSet.mockClear();

    const b = makeReqRes({ body: { platforms: ['facebook'] } });
    await analyticsController.getDashboard(b.req, b.res, b.next);
    const keyB = mockCacheGet.mock.calls[0][0];

    expect(keyA).not.toBe(keyB);
    expect(keyA).toMatch(/^analytics:org_42:dashboard:[0-9a-f]{12}$/);
    expect(keyB).toMatch(/^analytics:org_42:dashboard:[0-9a-f]{12}$/);
  });

  it('produces the SAME cache key for filters that differ only in array order (canonicalize)', async () => {
    mockCacheGet.mockResolvedValue(null);

    const a = makeReqRes({ body: { platforms: ['instagram', 'facebook'] } });
    await analyticsController.getDashboard(a.req, a.res, a.next);
    const keyA = mockCacheGet.mock.calls[0][0];

    mockCacheGet.mockClear();
    mockCacheSet.mockClear();

    const b = makeReqRes({ body: { platforms: ['facebook', 'instagram'] } });
    await analyticsController.getDashboard(b.req, b.res, b.next);
    const keyB = mockCacheGet.mock.calls[0][0];

    expect(keyA).toBe(keyB);
  });

  it('rounds default endDate to the start of the current minute (stable cache key in 60s burst)', async () => {
    mockCacheGet.mockResolvedValue(null);

    // First call — cache miss
    const a = makeReqRes();
    await analyticsController.getDashboard(a.req, a.res, a.next);
    const keyA = mockCacheGet.mock.calls[0][0];

    // Second call ~50ms later, no explicit dateRange — should use the SAME cache key.
    mockCacheGet.mockClear();
    mockCacheSet.mockClear();
    const b = makeReqRes();
    await analyticsController.getDashboard(b.req, b.res, b.next);
    const keyB = mockCacheGet.mock.calls[0][0];

    expect(keyA).toBe(keyB);
  });
});

// ────────────────────────────────────────────────────────────────────────────
describe('getEngagementAnalytics caching', () => {
  it('cache HIT short-circuits the aggregation', async () => {
    mockCacheGet.mockResolvedValue({ overview: { totalLikes: 100 } });

    const { req, res } = makeReqRes();
    await analyticsController.getEngagementAnalytics(req, res, jest.fn());

    expect(res.json).toHaveBeenCalledWith({
      success: true,
      data: { overview: { totalLikes: 100 } },
      cached: true
    });
    expect(mockInteractionAggregate).not.toHaveBeenCalled();
  });

  it('cache MISS runs the aggregations and persists with 60s TTL', async () => {
    mockCacheGet.mockResolvedValue(null);

    const { req, res } = makeReqRes();
    await analyticsController.getEngagementAnalytics(req, res, jest.fn());

    expect(mockInteractionAggregate.mock.calls.length).toBeGreaterThan(0);
    expect(mockCacheSet).toHaveBeenCalledTimes(1);
    expect(mockCacheSet.mock.calls[0][2]).toBe(60);
  });
});

// ────────────────────────────────────────────────────────────────────────────
describe('getAgentAnalytics caching + per-agent post-filter', () => {
  // Build the shape the controller's _getAgentData would produce.
  // We bypass _getAgentData entirely by populating the cache.
  const FULL_DATASET = {
    summary: { totalAgents: 3 },
    agents: [
      { userId: 'u_1', name: 'Alice' },
      { userId: 'u_2', name: 'Bob' },
      { userId: 'u_3', name: 'Carol' }
    ]
  };

  it('cache HIT with no agentId returns the full dataset (cached: true)', async () => {
    mockCacheGet.mockResolvedValue(FULL_DATASET);

    const { req, res } = makeReqRes({ body: {} });
    await analyticsController.getAgentAnalytics(req, res, jest.fn());

    const jsonArg = res.json.mock.calls[0][0];
    expect(jsonArg.success).toBe(true);
    expect(jsonArg.cached).toBe(true);
    expect(jsonArg.data.agents).toHaveLength(3);
    expect(mockCacheSet).not.toHaveBeenCalled();
  });

  it('cache HIT with agentId filters in memory and still reports cached: true', async () => {
    mockCacheGet.mockResolvedValue(FULL_DATASET);

    const { req, res } = makeReqRes({ body: { agentId: 'u_2' } });
    await analyticsController.getAgentAnalytics(req, res, jest.fn());

    const jsonArg = res.json.mock.calls[0][0];
    expect(jsonArg.cached).toBe(true);
    expect(jsonArg.data.agents).toEqual([{ userId: 'u_2', name: 'Bob' }]);
    // The full-dataset summary fields are preserved.
    expect(jsonArg.data.summary).toEqual({ totalAgents: 3 });
  });

  it('uses the SAME cache key regardless of which agentId is requested', async () => {
    mockCacheGet.mockResolvedValue(FULL_DATASET);

    const a = makeReqRes({ body: { agentId: 'u_1' } });
    await analyticsController.getAgentAnalytics(a.req, a.res, jest.fn());
    const keyA = mockCacheGet.mock.calls[0][0];

    mockCacheGet.mockClear();

    const b = makeReqRes({ body: { agentId: 'u_2' } });
    await analyticsController.getAgentAnalytics(b.req, b.res, jest.fn());
    const keyB = mockCacheGet.mock.calls[0][0];

    expect(keyA).toBe(keyB);
  });
});

// ────────────────────────────────────────────────────────────────────────────
describe('getContentPerformance caching (uses analyticsKey, longer TTL)', () => {
  it('cache HIT short-circuits and reports cached: true', async () => {
    mockCacheGet.mockResolvedValue([{ postId: 'p1' }]);

    const { req, res } = makeReqRes();
    await analyticsController.getContentPerformance(req, res);

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
      cached: true
    }));
  });

  it('cache MISS persists with 5-minute TTL (300s)', async () => {
    mockCacheGet.mockResolvedValue(null);

    const { req, res } = makeReqRes();
    await analyticsController.getContentPerformance(req, res);

    expect(mockCacheSet).toHaveBeenCalledTimes(1);
    expect(mockCacheSet.mock.calls[0][2]).toBe(300);
  });

  it('cache key uses analyticsKey (date-stamped, not hash-based)', async () => {
    mockCacheGet.mockResolvedValue(null);

    const { req, res } = makeReqRes();
    await analyticsController.getContentPerformance(req, res);

    const key = mockCacheGet.mock.calls[0][0];
    // Format: analytics:<orgId>:content-performance:YYYY-MM-DD
    expect(key).toMatch(/^analytics:org_42:content-performance:\d{4}-\d{2}-\d{2}$/);
  });
});
