'use strict';

const { buildCorrelationCtx, hashId } = require('../../../src/utils/correlationContext');

describe('correlationContext', () => {
  describe('hashId', () => {
    it('returns a 12-char hex string for a phone number', () => {
      const h = hashId('+919876543210');
      expect(typeof h).toBe('string');
      expect(h).toHaveLength(12);
      expect(/^[0-9a-f]+$/.test(h)).toBe(true);
    });

    it('returns the same hash for the same input', () => {
      expect(hashId('abc')).toBe(hashId('abc'));
    });

    it('returns different hashes for different inputs', () => {
      expect(hashId('111')).not.toBe(hashId('222'));
    });

    it('returns "unknown" for null/undefined', () => {
      expect(hashId(null)).toBe('unknown');
      expect(hashId(undefined)).toBe('unknown');
      expect(hashId('')).toBe('unknown');
    });

    it('does NOT expose the raw phone number in the hash', () => {
      const phone = '+919876543210';
      const h = hashId(phone);
      expect(h).not.toContain(phone);
      expect(h).not.toContain('9876543210');
    });
  });

  describe('buildCorrelationCtx', () => {
    it('returns a structured object with senderHash instead of raw senderId', () => {
      const ctx = buildCorrelationCtx({
        organizationId: 'org-123',
        senderId: '+919876543210',
        mid: 'wamid.abc',
        platform: 'whatsapp'
      });

      expect(ctx.senderHash).toBeDefined();
      expect(ctx.senderHash).not.toContain('9876543210');
      expect(ctx.mid).toBe('wamid.abc');
      expect(ctx.platform).toBe('whatsapp');
      expect(ctx.orgId).toBe('org-123');
      expect(ctx._ts).toBeDefined();
    });

    it('sets sessionReset only when explicitly truthy', () => {
      const ctxReset = buildCorrelationCtx({ sessionReset: true });
      const ctxNormal = buildCorrelationCtx({ sessionReset: false });
      expect(ctxReset.sessionReset).toBe(true);
      expect(ctxNormal.sessionReset).toBeUndefined();
    });

    it('omits undefined optional fields', () => {
      const ctx = buildCorrelationCtx({ organizationId: 'org-1' });
      expect(ctx.mid).toBeUndefined();
      expect(ctx.engine).toBeUndefined();
      expect(ctx.orderId).toBeUndefined();
    });
  });
});
