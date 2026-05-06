/**
 * Unit tests for inboxQueryService.
 *
 * These are pure-function tests — no Mongoose, no Redis, no network.
 * They pin the filter matrix for GET /api/inbox and GET /api/inbox/stats so
 * any regression in query shape fails here first (instead of in production).
 */

'use strict';

const svc = require('../../../../src/services/inbox/inboxQueryService');

// Stable ObjectId-like stubs (string coercion is what the service uses for keys)
const ORG_ID = 'org_abc123';
const USER_ID = 'user_xyz789';
const CONN_INSTA = { _id: 'conn_ig_1', platform: 'instagram' };
const CONN_FB   = { _id: 'conn_fb_1', platform: 'facebook' };
const CONN_WA   = { _id: 'conn_wa_1', platform: 'whatsapp' };

function makeUser(overrides = {}) {
  return {
    _id: { toString: () => USER_ID },
    role: 'admin',
    organization: { _id: ORG_ID },
    ...overrides
  };
}

describe('inboxQueryService — pure helpers', () => {
  describe('parseQueryCsv', () => {
    test.each([
      [null, []],
      [undefined, []],
      ['', []],
      ['  ', []],
      ['instagram', ['instagram']],
      ['instagram,facebook', ['instagram', 'facebook']],
      [' instagram , facebook ,   ', ['instagram', 'facebook']],
      [['a,b', 'c'], ['a', 'b', 'c']],
      [[' a ', ' b,c '], ['a', 'b', 'c']],
      [['', ','], []]
    ])('parseQueryCsv(%p) → %p', (input, expected) => {
      expect(svc.parseQueryCsv(input)).toEqual(expected);
    });
  });

  describe('setQueryFieldInOrEquals', () => {
    test('no value → no key added', () => {
      const q = {};
      svc.setQueryFieldInOrEquals(q, 'platform', null);
      svc.setQueryFieldInOrEquals(q, 'platform', '');
      svc.setQueryFieldInOrEquals(q, 'platform', []);
      expect(q).toEqual({});
    });
    test('single value → equality', () => {
      const q = {};
      svc.setQueryFieldInOrEquals(q, 'platform', 'instagram');
      expect(q).toEqual({ platform: 'instagram' });
    });
    test('csv → $in', () => {
      const q = {};
      svc.setQueryFieldInOrEquals(q, 'platform', 'instagram,facebook');
      expect(q).toEqual({ platform: { $in: ['instagram', 'facebook'] } });
    });
  });

  describe('escapeRegex', () => {
    test('escapes regex metacharacters', () => {
      expect(svc.escapeRegex('hello.world+?^$*{}()|[]\\')).toBe(
        'hello\\.world\\+\\?\\^\\$\\*\\{\\}\\(\\)\\|\\[\\]\\\\'
      );
    });
    test('preserves unicode + emojis untouched', () => {
      expect(svc.escapeRegex('café 🚀 — 日本語')).toBe('café 🚀 — 日本語');
    });
  });

  describe('resolvePagination', () => {
    test('defaults when inputs missing', () => {
      expect(svc.resolvePagination({})).toEqual({ safePage: 1, safeLimit: 20, skip: 0 });
    });
    test('parses numbers', () => {
      expect(svc.resolvePagination({ page: '3', limit: '50' })).toEqual({
        safePage: 3, safeLimit: 50, skip: 100
      });
    });
    test('clamps limit to MAX_PAGE_SIZE', () => {
      expect(svc.resolvePagination({ page: 1, limit: 9999 })).toEqual({
        safePage: 1, safeLimit: 100, skip: 0
      });
    });
    test('clamps page >= 1, limit >= 1', () => {
      expect(svc.resolvePagination({ page: -5, limit: 0 })).toEqual({
        safePage: 1, safeLimit: 20, skip: 0
      });
    });
    test('invalid strings fall back to defaults', () => {
      expect(svc.resolvePagination({ page: 'abc', limit: 'xyz' })).toEqual({
        safePage: 1, safeLimit: 20, skip: 0
      });
    });
  });

  describe('buildVisibilityFilter', () => {
    test('empty connections → empty-result filter (no leakage)', () => {
      expect(svc.buildVisibilityFilter([])).toEqual({ _id: { $in: [] } });
      expect(svc.buildVisibilityFilter(null)).toEqual({ _id: { $in: [] } });
      expect(svc.buildVisibilityFilter(undefined)).toEqual({ _id: { $in: [] } });
    });
    test('single platform → platform $in + 3-way $or on platformConnection (active or legacy only)', () => {
      const f = svc.buildVisibilityFilter([CONN_INSTA]);
      expect(f.$and[0]).toEqual({ platform: { $in: ['instagram'] } });
      const or = f.$and[1].$or;
      expect(or).toHaveLength(3);
      expect(or[0]).toEqual({ platformConnection: { $in: [CONN_INSTA._id] } });
      expect(or[1]).toEqual({ platformConnection: { $exists: false } });
      expect(or[2]).toEqual({ platformConnection: null });
    });
    test('multiple platforms dedupes', () => {
      const dupIg = { _id: 'conn_ig_2', platform: 'instagram' };
      const f = svc.buildVisibilityFilter([CONN_INSTA, dupIg, CONN_FB]);
      expect(f.$and[0].platform.$in.sort()).toEqual(['facebook', 'instagram']);
    });
  });

  describe('buildSearchCondition', () => {
    test('empty / whitespace → null', () => {
      expect(svc.buildSearchCondition(null)).toBeNull();
      expect(svc.buildSearchCondition('')).toBeNull();
      expect(svc.buildSearchCondition('   ')).toBeNull();
    });
    test('escapes special regex chars', () => {
      const cond = svc.buildSearchCondition('a.b*c');
      expect(cond.$or[0].content.$regex).toBe('a\\.b\\*c');
      expect(cond.$or[0].content.$options).toBe('i');
    });
    test('searches content + author.name + author.username', () => {
      const cond = svc.buildSearchCondition('hello');
      expect(cond.$or.map((x) => Object.keys(x)[0])).toEqual([
        'content', 'author.name', 'author.username'
      ]);
    });
    test('trims whitespace', () => {
      const cond = svc.buildSearchCondition('  hi  ');
      expect(cond.$or[0].content.$regex).toBe('hi');
    });
  });
});

describe('inboxQueryService.buildListFilter', () => {
  function baseArgs(overrides = {}) {
    return {
      user: makeUser(),
      query: {},
      activeConnections: [CONN_INSTA, CONN_FB],
      ...overrides
    };
  }

  test('throws InboxQueryError when user.organization is missing', () => {
    expect(() =>
      svc.buildListFilter({ user: { _id: USER_ID }, query: {}, activeConnections: [] })
    ).toThrow(svc.InboxQueryError);
  });

  test('zero active connections → visibility filter is empty-result', () => {
    const { mongoQuery } = svc.buildListFilter(baseArgs({ activeConnections: [] }));
    // The visibility filter is the 2nd entry in $and (after parentId rule).
    expect(mongoQuery.$and[1]).toEqual({ _id: { $in: [] } });
  });

  test('default query: org scope, no parent, default sort desc', () => {
    const { mongoQuery, effectiveSort, safePage, safeLimit } = svc.buildListFilter(baseArgs());
    expect(mongoQuery.organization).toBe(ORG_ID);
    expect(mongoQuery.status).toEqual({ $ne: 'archived' });
    expect(effectiveSort).toEqual({ platformCreatedAt: -1 });
    expect(safePage).toBe(1);
    expect(safeLimit).toBe(20);
    // First $and rule must exclude replies
    expect(mongoQuery.$and[0]).toEqual({
      $or: [
        { parentId: { $exists: false } },
        { parentId: null },
        { parentId: '' }
      ]
    });
  });

  test('multi-select filters use $in; single values stay equality', () => {
    const { mongoQuery } = svc.buildListFilter(baseArgs({
      query: { platform: 'instagram,facebook', type: 'comment', sentiment: 'positive' }
    }));
    expect(mongoQuery.platform).toEqual({ $in: ['instagram', 'facebook'] });
    expect(mongoQuery.type).toBe('comment');
    expect(mongoQuery.sentiment).toBe('positive');
  });

  test('date range sets $gte and $lte (end-of-day on dateTo)', () => {
    const { mongoQuery } = svc.buildListFilter(baseArgs({
      query: { dateFrom: '2025-01-01', dateTo: '2025-01-31' }
    }));
    expect(mongoQuery.platformCreatedAt.$gte).toEqual(new Date('2025-01-01'));
    const end = mongoQuery.platformCreatedAt.$lte;
    expect(end).toBeInstanceOf(Date);
    // Confirm end-of-day was applied (local TZ — assert via getHours)
    expect(end.getHours()).toBe(23);
    expect(end.getMinutes()).toBe(59);
    expect(end.getSeconds()).toBe(59);
  });

  test('intentBucket === "none" adds an $or to $and', () => {
    const { mongoQuery } = svc.buildListFilter(baseArgs({ query: { intentBucket: 'none' } }));
    const matches = mongoQuery.$and.filter(
      (c) => Array.isArray(c.$or) && c.$or[0]?.intentBucket?.$exists === false
    );
    expect(matches).toHaveLength(1);
    expect(mongoQuery.intentBucket).toBeUndefined();
  });

  test('intentBucket === "<id>" sets direct equality', () => {
    const { mongoQuery } = svc.buildListFilter(baseArgs({ query: { intentBucket: 'BUCKET_1' } }));
    expect(mongoQuery.intentBucket).toBe('BUCKET_1');
  });

  test('viewMode=assigned forces assignedTo = me', () => {
    const user = makeUser();
    const { mongoQuery, cacheFilters } = svc.buildListFilter({
      user,
      query: { viewMode: 'assigned' },
      activeConnections: [CONN_INSTA, CONN_FB]
    });
    expect(mongoQuery.assignedTo).toBe(user._id);
    expect(cacheFilters.assignedTo).toBe(USER_ID);
  });

  test('viewMode=needs_response forces unread + oldest-first', () => {
    const { mongoQuery, effectiveSort } = svc.buildListFilter(baseArgs({
      query: { viewMode: 'needs_response' }
    }));
    expect(mongoQuery.status).toBe('unread');
    expect(effectiveSort).toEqual({ platformCreatedAt: 1 });
  });

  test('viewMode=overdue sets $nin and SLA cutoff', () => {
    const { mongoQuery, effectiveSort } = svc.buildListFilter(baseArgs({
      query: { viewMode: 'overdue' }
    }));
    expect(mongoQuery.status.$nin).toEqual(['replied', 'resolved', 'archived']);
    expect(mongoQuery.platformCreatedAt.$lt).toBeInstanceOf(Date);
    expect(effectiveSort).toEqual({ platformCreatedAt: 1 });
  });

  test('viewMode=archived → status = archived (no auto-exclude)', () => {
    const { mongoQuery } = svc.buildListFilter(baseArgs({
      query: { viewMode: 'archived' }
    }));
    expect(mongoQuery.status).toBe('archived');
  });

  test('non-archived views with no status auto-exclude archived', () => {
    const { mongoQuery } = svc.buildListFilter(baseArgs({ query: {} }));
    expect(mongoQuery.status).toEqual({ $ne: 'archived' });
  });

  test('non-archived views with explicit status preserve it (no auto-exclude)', () => {
    const { mongoQuery } = svc.buildListFilter(baseArgs({ query: { status: 'unread' } }));
    expect(mongoQuery.status).toBe('unread');
  });

  test('agent role injects assignedTo / assignmentHistory visibility', () => {
    const { mongoQuery } = svc.buildListFilter(baseArgs({
      user: makeUser({ role: 'agent' })
    }));
    const agentRule = mongoQuery.$and.find(
      (c) => Array.isArray(c.$or) && c.$or.some((o) => 'assignedTo' in o)
    );
    expect(agentRule).toBeTruthy();
    expect(agentRule.$or).toHaveLength(2);
  });

  test('non-agent role does NOT inject assignedTo visibility', () => {
    const { mongoQuery } = svc.buildListFilter(baseArgs({
      user: makeUser({ role: 'admin' })
    }));
    const agentRule = mongoQuery.$and.find(
      (c) => Array.isArray(c.$or) && c.$or.some((o) => 'assignedTo' in o && Object.keys(o).length === 1)
    );
    expect(agentRule).toBeUndefined();
  });

  test.each([
    ['true', true],
    ['1', true],
    ['TRUE', true]
  ])('chatOpen=%p → open/missing branch', (val) => {
    const { mongoQuery } = svc.buildListFilter(baseArgs({ query: { chatOpen: val } }));
    const rule = mongoQuery.$and.find((c) =>
      Array.isArray(c.$or) && c.$or.some((o) => o.chatOpen === true)
    );
    expect(rule).toBeTruthy();
  });

  test.each([
    ['false', false],
    ['0', false]
  ])('chatOpen=%p → explicit false only', (val) => {
    const { mongoQuery } = svc.buildListFilter(baseArgs({ query: { chatOpen: val } }));
    const rule = mongoQuery.$and.find((c) => c.chatOpen === false);
    expect(rule).toBeTruthy();
  });

  test('search term → search condition added, cache key normalized to lowercase', () => {
    const { mongoQuery, cacheFilters, searchTerm } = svc.buildListFilter(baseArgs({
      query: { search: '  HeLLo.World  ' }
    }));
    expect(searchTerm).toBe('HeLLo.World');
    expect(cacheFilters.search).toBe('hello.world');
    const searchRule = mongoQuery.$and.find(
      (c) => Array.isArray(c.$or) && c.$or[0]?.content?.$regex === 'HeLLo\\.World'
    );
    expect(searchRule).toBeTruthy();
  });

  test('cacheFilters is deterministic: same input → same output', () => {
    const a = svc.buildListFilter(baseArgs({ query: { platform: 'instagram', page: 2 } })).cacheFilters;
    const b = svc.buildListFilter(baseArgs({ query: { platform: 'instagram', page: 2 } })).cacheFilters;
    expect(a).toEqual(b);
  });

  test('cacheFilters.activeConnections is a sorted CSV', () => {
    const { cacheFilters } = svc.buildListFilter(baseArgs({
      activeConnections: [CONN_WA, CONN_INSTA, CONN_FB]
    }));
    const parts = cacheFilters.activeConnections.split(',');
    expect([...parts]).toEqual([...parts].sort());
    expect(parts).toEqual([CONN_FB._id, CONN_INSTA._id, CONN_WA._id].sort());
  });

  test('cacheFilters coerces missing values to empty strings (never undefined)', () => {
    const { cacheFilters } = svc.buildListFilter(baseArgs());
    for (const [k, v] of Object.entries(cacheFilters)) {
      expect(v !== undefined).toBe(true);
      if (typeof v !== 'number') expect(typeof v).toBe('string');
    }
  });

  test('postId filter lives under metadata.postId', () => {
    const { mongoQuery } = svc.buildListFilter(baseArgs({ query: { postId: 'POST_42' } }));
    expect(mongoQuery['metadata.postId']).toBe('POST_42');
  });

  test('labels filter supports single and multi', () => {
    const single = svc.buildListFilter(baseArgs({ query: { label: 'lbl_1' } })).mongoQuery;
    expect(single.labels).toBe('lbl_1');

    const multi = svc.buildListFilter(baseArgs({ query: { label: 'lbl_1,lbl_2' } })).mongoQuery;
    expect(multi.labels).toEqual({ $in: ['lbl_1', 'lbl_2'] });
  });

  test('assignedTo passes through when provided explicitly (admin)', () => {
    const { mongoQuery, cacheFilters } = svc.buildListFilter(baseArgs({
      query: { assignedTo: 'agent_42' }
    }));
    expect(mongoQuery.assignedTo).toBe('agent_42');
    expect(cacheFilters.assignedTo).toBe('agent_42');
  });
});

describe('inboxQueryService.buildStatsMatchStage', () => {
  test('throws InboxQueryError when orgId missing', () => {
    expect(() => svc.buildStatsMatchStage({ orgId: null, platform: null, activeConnections: [] }))
      .toThrow(svc.InboxQueryError);
  });

  test('no connections → empty-result visibility filter', () => {
    const stage = svc.buildStatsMatchStage({
      orgId: ORG_ID, platform: null, activeConnections: []
    });
    expect(stage.organization).toBe(ORG_ID);
    expect(stage.$and[1]).toEqual({ _id: { $in: [] } });
  });

  test('excludes replies via parentId rule', () => {
    const stage = svc.buildStatsMatchStage({
      orgId: ORG_ID, platform: null, activeConnections: [CONN_INSTA]
    });
    expect(stage.$and[0]).toEqual({
      $or: [
        { parentId: { $exists: false } },
        { parentId: null },
        { parentId: '' }
      ]
    });
  });

  test('platform filter: single equality, multi $in', () => {
    const s1 = svc.buildStatsMatchStage({
      orgId: ORG_ID, platform: 'instagram', activeConnections: [CONN_INSTA]
    });
    expect(s1.platform).toBe('instagram');

    const s2 = svc.buildStatsMatchStage({
      orgId: ORG_ID, platform: 'instagram,facebook', activeConnections: [CONN_INSTA, CONN_FB]
    });
    expect(s2.platform).toEqual({ $in: ['instagram', 'facebook'] });
  });
});

describe('inboxQueryService.buildStatsAggregationPipeline', () => {
  const slaCutoff = new Date('2025-01-15T00:00:00Z');
  const matchStage = { organization: ORG_ID };

  test('throws InboxQueryError on invalid slaCutoff', () => {
    expect(() =>
      svc.buildStatsAggregationPipeline({ matchStage, slaCutoff: 'not-a-date' })
    ).toThrow(svc.InboxQueryError);
    expect(() =>
      svc.buildStatsAggregationPipeline({ matchStage, slaCutoff: new Date('invalid') })
    ).toThrow(svc.InboxQueryError);
  });

  test('pipeline starts with provided $match stage', () => {
    const pipe = svc.buildStatsAggregationPipeline({ matchStage, slaCutoff });
    expect(pipe[0]).toEqual({ $match: matchStage });
  });

  test('pipeline has $facet with counts/avgResponse/overdue', () => {
    const pipe = svc.buildStatsAggregationPipeline({ matchStage, slaCutoff });
    const facet = pipe[1].$facet;
    expect(Object.keys(facet).sort()).toEqual(['avgResponse', 'counts', 'overdue']);
  });

  test('overdue facet applies the slaCutoff correctly', () => {
    const pipe = svc.buildStatsAggregationPipeline({ matchStage, slaCutoff });
    const overdueMatch = pipe[1].$facet.overdue[0].$match;
    expect(overdueMatch.platformCreatedAt.$lt).toEqual(slaCutoff);
    expect(overdueMatch.status).toEqual({ $nin: ['replied', 'resolved'] });
  });

  test('terminal $addFields guarantees all count fields default to 0', () => {
    const pipe = svc.buildStatsAggregationPipeline({ matchStage, slaCutoff });
    const last = pipe[pipe.length - 1].$addFields;
    for (const key of [
      'total', 'unread', 'assigned', 'replied', 'resolved',
      'responseRate', 'positive', 'negative', 'neutral', 'overdueCount'
    ]) {
      expect(last[key]).toEqual({ $ifNull: [`$${key}`, 0] });
    }
  });

  test('response rate formula rounds to int percent', () => {
    const pipe = svc.buildStatsAggregationPipeline({ matchStage, slaCutoff });
    const addFields = pipe[1].$facet.counts[1].$addFields;
    const formula = addFields.responseRate.$cond[1];
    expect(formula.$round[1]).toBe(0);
    expect(formula.$round[0].$multiply[1]).toBe(100);
  });
});
