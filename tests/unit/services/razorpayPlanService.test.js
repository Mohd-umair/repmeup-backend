'use strict';

const mockPlansCreate = jest.fn();

jest.mock('../../../src/config/razorpay', () => ({
  plans: { create: (...args) => mockPlansCreate(...args) }
}));

jest.mock('../../../src/config/logger', () => ({
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn()
}));

const {
  isPaidBillablePlan,
  resolvePriceInPaise,
  mapBillingCycle,
  needsNewRazorpayPlan,
  syncPlanWithRazorpay,
  RazorpayPlanSyncError
} = require('../../../src/services/razorpayPlanService');

describe('razorpayPlanService', () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = {
      ...ORIGINAL_ENV,
      RAZORPAY_KEY_ID: 'rzp_live_test',
      RAZORPAY_KEY_SECRET: 'secret_test'
    };
    mockPlansCreate.mockResolvedValue({ id: 'plan_new123' });
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  describe('isPaidBillablePlan', () => {
    it('returns true for numeric paid monthly/yearly plans', () => {
      expect(isPaidBillablePlan({ price: 2499, billingCycle: 'monthly' })).toBe(true);
      expect(isPaidBillablePlan({ price: 9999, billingCycle: 'yearly' })).toBe(true);
    });

    it('returns false for free, custom, and lifetime plans', () => {
      expect(isPaidBillablePlan({ price: 0 })).toBe(false);
      expect(isPaidBillablePlan({ price: 'custom' })).toBe(false);
      expect(isPaidBillablePlan({ price: 100, billingCycle: 'lifetime' })).toBe(false);
      expect(isPaidBillablePlan({ price: 100, billingCycle: 'custom' })).toBe(false);
    });
  });

  describe('resolvePriceInPaise', () => {
    it('derives paise from whole-rupee price', () => {
      expect(resolvePriceInPaise({ price: 2499, billingCycle: 'monthly' })).toBe(249900);
    });

    it('derives paise from whole-rupee price even when stale priceInr exists', () => {
      expect(resolvePriceInPaise({ price: 2999, priceInr: 249900, billingCycle: 'monthly' })).toBe(299900);
    });

    it('falls back to priceInr when price is not numeric', () => {
      expect(resolvePriceInPaise({ price: 'custom', priceInr: 300000, billingCycle: 'monthly' })).toBeNull();
    });

    it('returns null for non-billable plans', () => {
      expect(resolvePriceInPaise({ price: 0 })).toBeNull();
      expect(resolvePriceInPaise({ price: 'custom' })).toBeNull();
    });
  });

  describe('mapBillingCycle', () => {
    it('maps monthly and yearly', () => {
      expect(mapBillingCycle('monthly')).toEqual({ period: 'monthly', interval: 1 });
      expect(mapBillingCycle('yearly')).toEqual({ period: 'yearly', interval: 1 });
    });

    it('returns null for custom/lifetime', () => {
      expect(mapBillingCycle('custom')).toBeNull();
      expect(mapBillingCycle('lifetime')).toBeNull();
    });
  });

  describe('needsNewRazorpayPlan', () => {
    const previous = {
      planId: 'pro',
      price: 2499,
      billingCycle: 'monthly',
      priceInr: 249900,
      razorpayPlanId: 'plan_old'
    };

    it('returns true on create (no previous)', () => {
      expect(needsNewRazorpayPlan(null, { price: 2499, billingCycle: 'monthly' })).toBe(true);
    });

    it('returns false when price and billing unchanged', () => {
      expect(
        needsNewRazorpayPlan(previous, {
          price: 2499,
          billingCycle: 'monthly',
          razorpayPlanId: 'plan_old'
        })
      ).toBe(false);
    });

    it('returns true when price changes', () => {
      expect(
        needsNewRazorpayPlan(previous, {
          price: 2999,
          billingCycle: 'monthly',
          razorpayPlanId: 'plan_old'
        })
      ).toBe(true);
    });

    it('returns true when billing cycle changes', () => {
      expect(
        needsNewRazorpayPlan(previous, {
          price: 2499,
          billingCycle: 'yearly',
          razorpayPlanId: 'plan_old'
        })
      ).toBe(true);
    });
  });

  describe('syncPlanWithRazorpay', () => {
    it('creates Razorpay plan for new paid plan', async () => {
      const result = await syncPlanWithRazorpay({
        planId: 'starter',
        name: 'Starter',
        tier: 1,
        price: 2499,
        billingCycle: 'monthly'
      });

      expect(mockPlansCreate).toHaveBeenCalledTimes(1);
      expect(result.created).toBe(true);
      expect(result.razorpayPlanId).toBe('plan_new123');
      expect(result.priceInr).toBe(249900);
    });

    it('skips API when limits-only update on existing plan', async () => {
      const previous = {
        planId: 'starter',
        name: 'Starter',
        price: 2499,
        billingCycle: 'monthly',
        priceInr: 249900,
        razorpayPlanId: 'plan_existing'
      };

      const result = await syncPlanWithRazorpay(
        { ...previous, name: 'Starter Plus' },
        previous
      );

      expect(mockPlansCreate).not.toHaveBeenCalled();
      expect(result.created).toBe(false);
      expect(result.razorpayPlanId).toBe('plan_existing');
    });

    it('creates new Razorpay plan when price changes', async () => {
      const previous = {
        planId: 'starter',
        name: 'Starter',
        price: 2499,
        billingCycle: 'monthly',
        priceInr: 249900,
        razorpayPlanId: 'plan_existing'
      };

      const result = await syncPlanWithRazorpay(
        { ...previous, price: 2999 },
        previous
      );

      expect(mockPlansCreate).toHaveBeenCalledTimes(1);
      expect(result.created).toBe(true);
      expect(result.razorpayPlanId).toBe('plan_new123');
      expect(result.priceInr).toBe(299900);
    });

    it('clears razorpay fields for free plan', async () => {
      const result = await syncPlanWithRazorpay({ price: 0, billingCycle: 'monthly' });

      expect(mockPlansCreate).not.toHaveBeenCalled();
      expect(result.razorpayPlanId).toBeNull();
      expect(result.priceInr).toBeNull();
      expect(result.created).toBe(false);
    });

    it('throws RazorpayPlanSyncError when credentials missing', async () => {
      delete process.env.RAZORPAY_KEY_ID;

      await expect(
        syncPlanWithRazorpay({ planId: 'pro', name: 'Pro', price: 100, billingCycle: 'monthly' })
      ).rejects.toBeInstanceOf(RazorpayPlanSyncError);
    });
  });
});
