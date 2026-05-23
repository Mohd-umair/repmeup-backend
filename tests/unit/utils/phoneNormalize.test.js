'use strict';

const {
  inferDefaultRegionFromDisplayNumber,
  normalizePhoneE164,
  resolveRegionFromCountryHint,
  sanitizeDefaultRegion,
  FALLBACK_REGION
} = require('../../../src/utils/phoneNormalize');

describe('phoneNormalize', () => {
  describe('inferDefaultRegionFromDisplayNumber', () => {
    test('infers AE from UAE display number', () => {
      expect(inferDefaultRegionFromDisplayNumber('+971 52 948 2432')).toBe('AE');
    });

    test('infers IN from Indian display number', () => {
      expect(inferDefaultRegionFromDisplayNumber('+91 98765 43210')).toBe('IN');
    });

    test('falls back when empty', () => {
      expect(inferDefaultRegionFromDisplayNumber('')).toBe(FALLBACK_REGION);
    });
  });

  describe('normalizePhoneE164', () => {
    test('keeps full international Indian number', () => {
      const r = normalizePhoneE164('919876543210', { defaultRegion: 'IN' });
      expect(r.status).toBe('valid');
      expect(r.phone).toBe('919876543210');
    });

    test('prefixes local Indian number with 91', () => {
      const r = normalizePhoneE164('9876543210', { defaultRegion: 'IN' });
      expect(r.status).toBe('prefixed');
      expect(r.phone).toBe('919876543210');
    });

    test('does not misread 10-digit IN numbers starting with foreign calling codes', () => {
      const cases = [
        ['9613014412', '919613014412'],
        ['6633713583', '916633713583'],
        ['6598801796', '916598801796'],
        ['6580680107', '916580680107'],
        ['6251113193', '916251113193']
      ];
      for (const [raw, expected] of cases) {
        const r = normalizePhoneE164(raw, { defaultRegion: 'IN' });
        expect(r.status).toBe('prefixed');
        expect(r.phone).toBe(expected);
      }
    });

    test('keeps US number when default is IN', () => {
      const r = normalizePhoneE164('14155551234', { defaultRegion: 'IN' });
      expect(r.status).toBe('valid');
      expect(r.phone).toBe('14155551234');
    });

    test('parses plus-prefixed UAE number', () => {
      const r = normalizePhoneE164('+971529482432', { defaultRegion: 'IN' });
      expect(r.status).toBe('valid');
      expect(r.phone).toBe('971529482432');
    });

    test('rejects too-short input', () => {
      const r = normalizePhoneE164('123', { defaultRegion: 'IN' });
      expect(r.status).toBe('invalid');
      expect(r.phone).toBeNull();
    });

    test('uses row country hint column', () => {
      const r = normalizePhoneE164('529482432', {
        defaultRegion: 'IN',
        rowRegion: '971'
      });
      expect(r.phone).toBe('971529482432');
    });
  });

  describe('resolveRegionFromCountryHint', () => {
    test('resolves ISO code', () => {
      expect(resolveRegionFromCountryHint('IN')).toBe('IN');
    });

    test('resolves calling code', () => {
      expect(resolveRegionFromCountryHint('971')).toBe('AE');
    });
  });

  describe('sanitizeDefaultRegion', () => {
    test('normalizes lowercase', () => {
      expect(sanitizeDefaultRegion('in')).toBe('IN');
    });

    test('falls back on garbage', () => {
      expect(sanitizeDefaultRegion('invalid')).toBe(FALLBACK_REGION);
    });
  });
});
