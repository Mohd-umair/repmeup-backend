'use strict';

const fmt = require('../../../../src/services/inbox/inboxOpsFormatters');

describe('inboxOpsFormatters', () => {
  describe('formatMoney', () => {
    test('formats INR amounts', () => {
      expect(fmt.formatMoney(1500, 'INR')).toMatch(/1,500|₹/);
    });
    test('returns em dash for null', () => {
      expect(fmt.formatMoney(null)).toBe('—');
    });
  });

  describe('paymentLabelForOrder', () => {
    test.each([
      ['paid', 'PAID', 'success'],
      ['payment_pending', 'PENDING', 'warning'],
      ['cancelled', 'CANCELLED', 'danger']
    ])('status %s → %s (%s)', (status, label, tone) => {
      const result = fmt.paymentLabelForOrder({ status });
      expect(result.label).toBe(label);
      expect(result.tone).toBe(tone);
    });
  });

  describe('getReviewRating', () => {
    test('maps Google star strings', () => {
      expect(fmt.getReviewRating({ metadata: { starRating: 'FOUR' } })).toBe(4);
    });
    test('returns numeric rating', () => {
      expect(fmt.getReviewRating({ metadata: { rating: 5 } })).toBe(5);
    });
  });

  describe('lineItemsSummary', () => {
    test('single item', () => {
      expect(fmt.lineItemsSummary([{ name: 'Widget', qty: 1 }])).toBe('Widget');
    });
    test('multiple items shows +N more', () => {
      expect(fmt.lineItemsSummary([{ name: 'A' }, { name: 'B' }])).toBe('A +1 more');
    });
  });

  describe('chatDeepLink', () => {
    test('builds inbox selected query', () => {
      expect(fmt.chatDeepLink('abc123')).toBe('/app/inbox?selected=abc123');
    });
    test('null when no id', () => {
      expect(fmt.chatDeepLink(null)).toBeNull();
    });
  });
});
