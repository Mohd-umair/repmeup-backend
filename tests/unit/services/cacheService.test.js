/**
 * Contract tests for cacheService — focused on the pure key-derivation logic
 * (`analyticsHashKey`, `analyticsKey`, and the canonicalize behaviour) that
 * landed with the analytics caching work.
 *
 * Redis I/O methods (get/set/del/delPattern) are NOT exercised here; those
 * need a real Redis and live in tests/integration.
 */

// `cacheService` constructs at module-load and tries to read a Redis client
// lazily. As long as we don't call get/set/del, no connection is required.
jest.mock('../../../src/config/redis', () => ({
  getRedisClient: () => {
    throw new Error('Redis must be mocked per-test if you need it');
  }
}));

const cacheService = require('../../../src/services/cacheService');

describe('cacheService.analyticsKey', () => {
  it('produces a deterministic flat key', () => {
    expect(cacheService.analyticsKey('org_1', 'dashboard', '2026-04-01'))
      .toBe('analytics:org_1:dashboard:2026-04-01');
  });
});

describe('cacheService.analyticsHashKey', () => {
  const ORG = 'org_42';

  it('produces the documented prefix', () => {
    const key = cacheService.analyticsHashKey(ORG, 'dashboard', { foo: 1 });
    expect(key.startsWith('analytics:org_42:dashboard:')).toBe(true);
    // 12-char hex hash suffix
    expect(key).toMatch(/^analytics:org_42:dashboard:[0-9a-f]{12}$/);
  });

  it('returns the same key when filter object keys are reordered', () => {
    const a = cacheService.analyticsHashKey(ORG, 'dashboard', {
      platforms: ['instagram'], types: ['comment'], status: ['new']
    });
    const b = cacheService.analyticsHashKey(ORG, 'dashboard', {
      status: ['new'], platforms: ['instagram'], types: ['comment']
    });
    expect(a).toBe(b);
  });

  it('returns the same key when array filter values are reordered', () => {
    const a = cacheService.analyticsHashKey(ORG, 'dashboard', {
      platforms: ['instagram', 'facebook', 'whatsapp']
    });
    const b = cacheService.analyticsHashKey(ORG, 'dashboard', {
      platforms: ['whatsapp', 'instagram', 'facebook']
    });
    expect(a).toBe(b);
  });

  it('treats Date instances and their ISO string equivalents as identical', () => {
    const iso = '2026-04-01T00:00:00.000Z';
    const a = cacheService.analyticsHashKey(ORG, 'dashboard', { startDate: new Date(iso) });
    const b = cacheService.analyticsHashKey(ORG, 'dashboard', { startDate: iso });
    expect(a).toBe(b);
  });

  it('produces a different key when filter values change', () => {
    const a = cacheService.analyticsHashKey(ORG, 'dashboard', { platforms: ['instagram'] });
    const b = cacheService.analyticsHashKey(ORG, 'dashboard', { platforms: ['facebook'] });
    expect(a).not.toBe(b);
  });

  it('produces a different key per endpoint type even with identical filters', () => {
    const filters = { platforms: ['instagram'] };
    const dashboard = cacheService.analyticsHashKey(ORG, 'dashboard', filters);
    const platform = cacheService.analyticsHashKey(ORG, 'platform', filters);
    expect(dashboard).not.toBe(platform);
  });

  it('namespaces by org so two orgs cannot share a cache entry', () => {
    const filters = { platforms: ['instagram'] };
    const a = cacheService.analyticsHashKey('org_1', 'dashboard', filters);
    const b = cacheService.analyticsHashKey('org_2', 'dashboard', filters);
    expect(a).not.toBe(b);
  });

  it('drops undefined values so { x: undefined } collapses to {}', () => {
    const a = cacheService.analyticsHashKey(ORG, 'dashboard', { platforms: undefined });
    const b = cacheService.analyticsHashKey(ORG, 'dashboard', {});
    expect(a).toBe(b);
  });

  it('treats null and missing as different (null is meaningful)', () => {
    const a = cacheService.analyticsHashKey(ORG, 'dashboard', { platforms: null });
    const b = cacheService.analyticsHashKey(ORG, 'dashboard', {});
    expect(a).not.toBe(b);
  });

  it('coerces an ObjectId-shaped orgId to string consistently', () => {
    const objectIdLike = {
      toString() { return 'org_xyz'; }
    };
    const a = cacheService.analyticsHashKey(objectIdLike, 'dashboard', { foo: 1 });
    const b = cacheService.analyticsHashKey('org_xyz', 'dashboard', { foo: 1 });
    expect(a).toBe(b);
  });
});
