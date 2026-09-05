'use strict';

/**
 * Unit tests for creditPeriodService.js
 *
 * Covers:
 *  - monthKeyUTC / utcMonthStart helper functions
 *  - ensureAiCreditPeriodCurrent:
 *      - Same UTC month  → no-op, returns current state
 *      - New month, 2000 remaining → carriedCredits = 2000, used = 0
 *      - Multiple consecutive months → credits accumulate correctly
 *      - Unlimited plan (limit = -1) → rollover skipped, returns isUnlimited
 *      - Demo workspace (isDemo = true) → rollover skipped, no banking
 *      - No subscription → returns zero state
 *      - Concurrent rollover → only one writer wins, others re-read settled state
 */

const Subscription = require('../../../src/models/Subscription');
const AICreditUsage = require('../../../src/models/AICreditUsage');
const entitlementsService = require('../../../src/services/entitlementsService');

jest.mock('../../../src/models/Subscription');
jest.mock('../../../src/models/AICreditUsage');
jest.mock('../../../src/services/entitlementsService');

const {
  monthKeyUTC,
  utcMonthStart,
  ensureAiCreditPeriodCurrent
} = require('../../../src/services/creditPeriodService');

const ORG_ID = 'org_test_001';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeSubscription(overrides = {}) {
  return {
    usage: {
      aiCreditsThisMonth: 0,
      carriedCredits: 0,
      creditPeriodStart: utcMonthStart(new Date()),
      ...overrides.usage
    },
    isDemo: false,
    demoCreditsCap: null,
    ...overrides
  };
}

function mockEntitlements(maxAICreditsPerMonth = 5000) {
  entitlementsService.getEntitlements.mockResolvedValue({
    limits: { maxAICreditsPerMonth }
  });
}

// ─── monthKeyUTC ─────────────────────────────────────────────────────────────

describe('monthKeyUTC', () => {
  test('returns YYYY-MM string in UTC', () => {
    expect(monthKeyUTC(new Date('2026-01-15T12:00:00Z'))).toBe('2026-01');
    expect(monthKeyUTC(new Date('2025-12-31T23:59:59Z'))).toBe('2025-12');
  });

  test('handles midnight boundary correctly', () => {
    expect(monthKeyUTC(new Date('2026-02-01T00:00:00Z'))).toBe('2026-02');
  });
});

// ─── utcMonthStart ────────────────────────────────────────────────────────────

describe('utcMonthStart', () => {
  test('returns midnight UTC on the 1st', () => {
    const result = utcMonthStart(new Date('2026-03-15T18:45:00Z'));
    expect(result.toISOString()).toBe('2026-03-01T00:00:00.000Z');
  });

  test('defaults to the current month when no arg passed', () => {
    const result = utcMonthStart();
    const now = new Date();
    expect(result.getUTCFullYear()).toBe(now.getUTCFullYear());
    expect(result.getUTCMonth()).toBe(now.getUTCMonth());
    expect(result.getUTCDate()).toBe(1);
    expect(result.getUTCHours()).toBe(0);
  });
});

// ─── ensureAiCreditPeriodCurrent ─────────────────────────────────────────────

describe('ensureAiCreditPeriodCurrent', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    AICreditUsage.create.mockResolvedValue({});
  });

  // ── same month ──────────────────────────────────────────────────────────────

  describe('same UTC month', () => {
    test('returns current state without updating DB', async () => {
      const now = new Date();
      const sub = makeSubscription({
        usage: {
          aiCreditsThisMonth: 1500,
          carriedCredits: 500,
          creditPeriodStart: utcMonthStart(now)
        }
      });

      mockEntitlements(5000);
      Subscription.findOne.mockReturnValue({ select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(sub) }) });

      const result = await ensureAiCreditPeriodCurrent(ORG_ID);

      expect(Subscription.findOneAndUpdate).not.toHaveBeenCalled();
      expect(result).toEqual(expect.objectContaining({
        planLimit: 5000,
        carriedCredits: 500,
        used: 1500,
        effectiveLimit: 5500,
        remaining: 4000,
        isUnlimited: false
      }));
    });
  });

  // ── new month rollover ───────────────────────────────────────────────────────

  describe('new UTC month', () => {
    test('banks unused credits and resets usage', async () => {
      const lastMonthStart = new Date('2026-01-01T00:00:00Z');
      const sub = makeSubscription({
        usage: {
          aiCreditsThisMonth: 3000,
          carriedCredits: 0,
          creditPeriodStart: lastMonthStart
        }
      });

      mockEntitlements(5000);
      Subscription.findOne
        .mockReturnValueOnce({ select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(sub) }) });
      Subscription.findOneAndUpdate.mockResolvedValue({
        usage: { aiCreditsThisMonth: 0, carriedCredits: 2000, creditPeriodStart: new Date('2026-02-01T00:00:00Z') }
      });

      const result = await ensureAiCreditPeriodCurrent(ORG_ID);

      expect(Subscription.findOneAndUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ organization: ORG_ID }),
        expect.objectContaining({
          $set: expect.objectContaining({
            'usage.carriedCredits': 2000,
            'usage.aiCreditsThisMonth': 0
          })
        }),
        expect.any(Object)
      );

      expect(result).toEqual(expect.objectContaining({
        planLimit: 5000,
        carriedCredits: 2000,
        used: 0,
        effectiveLimit: 7000,
        remaining: 7000
      }));
    });

    test('logs a credit_rollover audit event', async () => {
      const lastMonthStart = new Date('2025-12-01T00:00:00Z');
      const sub = makeSubscription({
        usage: { aiCreditsThisMonth: 1000, carriedCredits: 0, creditPeriodStart: lastMonthStart }
      });

      mockEntitlements(5000);
      Subscription.findOne.mockReturnValueOnce({ select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(sub) }) });
      Subscription.findOneAndUpdate.mockResolvedValue({ usage: {} });

      await ensureAiCreditPeriodCurrent(ORG_ID);

      expect(AICreditUsage.create).toHaveBeenCalledWith(
        expect.objectContaining({
          operation: 'credit_rollover',
          creditsUsed: 0,
          metadata: expect.objectContaining({ bankedCredits: 4000 })
        })
      );
    });
  });

  // ── multi-month accumulation ─────────────────────────────────────────────────

  describe('multi-month accumulation', () => {
    test('Jan→Feb: 2000 carried; mid-Feb uses 6500; Mar rollover → 500 carried', async () => {
      // Scenario from the plan's example table
      // At end of Feb: planLimit=5000, carried=2000, used=6500 → remaining=500
      const febStart = new Date('2026-02-01T00:00:00Z');
      const sub = makeSubscription({
        usage: { aiCreditsThisMonth: 6500, carriedCredits: 2000, creditPeriodStart: febStart }
      });

      mockEntitlements(5000);
      Subscription.findOne.mockReturnValueOnce({ select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(sub) }) });
      Subscription.findOneAndUpdate.mockResolvedValue({ usage: {} });

      const result = await ensureAiCreditPeriodCurrent(ORG_ID);

      expect(Subscription.findOneAndUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ organization: ORG_ID }),
        expect.objectContaining({
          $set: expect.objectContaining({
            'usage.carriedCredits': 500,
            'usage.aiCreditsThisMonth': 0
          })
        }),
        expect.any(Object)
      );
      expect(result.carriedCredits).toBe(500);
      expect(result.effectiveLimit).toBe(5500);
    });
  });

  // ── unlimited plan ───────────────────────────────────────────────────────────

  describe('unlimited plan', () => {
    test('skips rollover and returns isUnlimited = true', async () => {
      const lastMonthStart = new Date('2025-11-01T00:00:00Z');
      const sub = makeSubscription({
        usage: { aiCreditsThisMonth: 3000, carriedCredits: 0, creditPeriodStart: lastMonthStart }
      });

      mockEntitlements(-1); // unlimited
      Subscription.findOne.mockReturnValueOnce({ select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(sub) }) });

      const result = await ensureAiCreditPeriodCurrent(ORG_ID);

      expect(Subscription.findOneAndUpdate).not.toHaveBeenCalled();
      expect(result.isUnlimited).toBe(true);
      expect(result.remaining).toBe(Infinity);
    });
  });

  // ── demo workspace ───────────────────────────────────────────────────────────

  describe('demo workspace', () => {
    test('does not bank credits', async () => {
      const lastMonthStart = new Date('2025-10-01T00:00:00Z');
      const sub = makeSubscription({
        isDemo: true,
        demoCreditsCap: 200,
        usage: { aiCreditsThisMonth: 50, carriedCredits: 0, creditPeriodStart: lastMonthStart }
      });

      mockEntitlements(-1); // plan is unlimited but demo cap applies
      Subscription.findOne.mockReturnValueOnce({ select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(sub) }) });

      const result = await ensureAiCreditPeriodCurrent(ORG_ID);

      // Demo cap: isDemo flag short-circuits carry-forward banking
      expect(Subscription.findOneAndUpdate).not.toHaveBeenCalled();
      expect(result.carriedCredits).toBe(0);
    });
  });

  // ── no subscription ──────────────────────────────────────────────────────────

  describe('no subscription', () => {
    test('returns zero state without error', async () => {
      mockEntitlements(5000);
      Subscription.findOne.mockReturnValueOnce({ select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(null) }) });

      const result = await ensureAiCreditPeriodCurrent(ORG_ID);

      expect(result).toEqual({ planLimit: 0, carriedCredits: 0, used: 0, effectiveLimit: 0, remaining: 0, isUnlimited: false });
    });
  });

  // ── concurrent rollover ──────────────────────────────────────────────────────

  describe('concurrent rollover', () => {
    test('when findOneAndUpdate returns null (another caller won), re-reads settled state', async () => {
      const lastMonthStart = new Date('2025-09-01T00:00:00Z');
      const sub = makeSubscription({
        usage: { aiCreditsThisMonth: 2000, carriedCredits: 0, creditPeriodStart: lastMonthStart }
      });
      const settledSub = { usage: { aiCreditsThisMonth: 100, carriedCredits: 3000 } };

      mockEntitlements(5000);
      Subscription.findOne
        .mockReturnValueOnce({ select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(sub) }) })
        .mockReturnValueOnce({ select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(settledSub) }) });

      // Simulate concurrent winner: findOneAndUpdate returns null
      Subscription.findOneAndUpdate.mockResolvedValue(null);

      const result = await ensureAiCreditPeriodCurrent(ORG_ID);

      expect(result.carriedCredits).toBe(3000);
      expect(result.used).toBe(100);
      expect(result.effectiveLimit).toBe(8000); // 5000 + 3000
      expect(result.remaining).toBe(7900);
    });
  });
});
