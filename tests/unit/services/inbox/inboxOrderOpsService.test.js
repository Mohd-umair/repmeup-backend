'use strict';

const orderOps = require('../../../../src/services/inbox/inboxOrderOpsService');

const ORG = 'org_test_1';

describe('inboxOrderOpsService — pure helpers', () => {
  describe('buildListFilter', () => {
    test('defaults to org scope only', () => {
      expect(orderOps.buildListFilter(ORG, {})).toEqual({ organization: ORG });
    });

    test('tab paid maps to status paid', () => {
      expect(orderOps.buildListFilter(ORG, { tab: 'paid' })).toEqual({
        organization: ORG,
        status: 'paid'
      });
    });

    test('tab payment_pending maps correctly', () => {
      expect(orderOps.buildListFilter(ORG, { tab: 'payment_pending' }).status).toBe('payment_pending');
    });

    test('channel and date range', () => {
      const filter = orderOps.buildListFilter(ORG, {
        channel: 'whatsapp',
        from: '2026-01-01',
        to: '2026-01-31'
      });
      expect(filter.channel).toBe('whatsapp');
      expect(filter.createdAt.$gte).toEqual(new Date('2026-01-01'));
      expect(filter.createdAt.$lte).toEqual(new Date('2026-01-31'));
    });

    test('search adds $or on displayRef and buyer fields', () => {
      const filter = orderOps.buildListFilter(ORG, { search: 'ORD-2847' });
      expect(filter.$or).toHaveLength(4);
      expect(filter.$or[0]).toEqual({ displayRef: { $regex: 'ORD-2847', $options: 'i' } });
    });
  });

  describe('mapOrderRow', () => {
    test('maps processed DTO with displayRef and chat deep link', () => {
      const row = orderOps.mapOrderRow({
        _id: { toString: () => 'order1' },
        displayRef: 'ORD-2847',
        channel: 'whatsapp',
        status: 'paid',
        totalAmount: 500,
        currency: 'AED',
        buyerName: 'Jane Doe',
        buyerPhone: '+971501234567',
        lineItems: [{ name: 'Product A', qty: +2 }],
        createdAt: new Date('2026-05-20T10:00:00Z'),
        sourceInteraction: 'int_abc'
      });

      expect(row.id).toBe('order1');
      expect(row.displayRef).toBe('ORD-2847');
      expect(row.customerName).toBe('Jane Doe');
      expect(row.channelLabel).toBe('WhatsApp');
      expect(row.statusLabel).toBe('Paid');
      expect(row.paymentLabel).toBe('PAID');
      expect(row.itemsSummary).toContain('Product A');
      expect(row.chatDeepLink).toBe('/app/inbox?selected=int_abc');
    });
  });

  describe('VALID_STATUS_TRANSITIONS', () => {
    test('paid can transition to shipped', () => {
      expect(orderOps.VALID_STATUS_TRANSITIONS.paid).toContain('shipped');
    });
    test('delivered has no transitions', () => {
      expect(orderOps.VALID_STATUS_TRANSITIONS.delivered).toEqual([]);
    });
  });
});
