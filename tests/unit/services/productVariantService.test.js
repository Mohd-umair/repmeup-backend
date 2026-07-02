'use strict';

const svc = require('../../../src/services/productVariantService');

const P = (over = {}) => ({
  _id: 'p1',
  name: 'Cotton Tee',
  price: 999,
  currency: 'INR',
  sizes: ['S', 'M', 'L'],
  colors: ['Red', 'Blue'],
  stock: null,
  ...over
});

describe('productVariantService', () => {
  describe('variantDimensions', () => {
    it('detects both dimensions', () => {
      expect(svc.variantDimensions(P())).toEqual({ needsSize: true, needsColor: true, hasVariants: true });
    });
    it('detects size-only', () => {
      expect(svc.variantDimensions(P({ colors: [] }))).toEqual({ needsSize: true, needsColor: false, hasVariants: true });
    });
    it('detects color-only', () => {
      expect(svc.variantDimensions(P({ sizes: [] }))).toEqual({ needsSize: false, needsColor: true, hasVariants: true });
    });
    it('detects no variants', () => {
      expect(svc.variantDimensions(P({ sizes: [], colors: [] }))).toEqual({ needsSize: false, needsColor: false, hasVariants: false });
    });
    it('ignores blank/duplicate entries', () => {
      expect(svc.variantDimensions(P({ sizes: ['', '  '], colors: ['Red', 'red'] })))
        .toEqual({ needsSize: false, needsColor: true, hasVariants: true });
    });
  });

  describe('matchSize', () => {
    it('matches full words and abbreviations to catalog casing', () => {
      expect(svc.matchSize('I want large', ['S', 'M', 'L']).matched).toBe('L');
      expect(svc.matchSize('size M please', ['S', 'M', 'L']).matched).toBe('M');
      expect(svc.matchSize('small one', ['S', 'M']).matched).toBe('S');
    });
    it('resolves "extra large" to XL, not L', () => {
      expect(svc.matchSize('extra large', ['L', 'XL']).matched).toBe('XL');
    });
    it('matches numeric sizes exactly', () => {
      expect(svc.matchSize('size 32', ['30', '32', '34']).matched).toBe('32');
    });
    it('does NOT match a size letter hidden inside a word', () => {
      const r = svc.matchSize('hello there cool', ['S', 'M', 'L']);
      expect(r.matched).toBeNull();
      expect(r.requestedUnavailable).toBeNull();
    });
    it('flags a size we do not carry', () => {
      const r = svc.matchSize('do you have XXL', ['S', 'M']);
      expect(r.matched).toBeNull();
      expect(r.requestedUnavailable).toBe('xxl');
    });
    it('returns empty when the product has no sizes', () => {
      expect(svc.matchSize('large', [])).toEqual({ matched: null, requestedUnavailable: null });
    });
  });

  describe('matchColor', () => {
    it('matches a colour to catalog casing', () => {
      expect(svc.matchColor('the red one', ['Red', 'Blue']).matched).toBe('Red');
    });
    it('handles spelling variants (grey/gray)', () => {
      expect(svc.matchColor('grey please', ['Gray', 'Black']).matched).toBe('Gray');
    });
    it('matches multi-word colours by phrase', () => {
      expect(svc.matchColor('navy blue jacket', ['Navy', 'Red']).matched).toBe('Navy');
    });
    it('flags a colour we do not carry', () => {
      const r = svc.matchColor('do you have purple', ['Red', 'Blue']);
      expect(r.matched).toBeNull();
      expect(r.requestedUnavailable).toBe('purple');
    });
    it('does not false-match a colour inside another word', () => {
      expect(svc.matchColor('blacktop road', ['Black']).matched).toBeNull();
    });
  });

  describe('isAvailabilityQuery', () => {
    it.each([
      'what sizes do you have',
      'which colours are available',
      'any other colors?',
      'show me size options'
    ])('is true for "%s"', (t) => expect(svc.isAvailabilityQuery(t)).toBe(true));

    it.each([
      'I want red',
      'send payment link',
      'medium please',
      ''
    ])('is false for "%s"', (t) => expect(svc.isAvailabilityQuery(t)).toBe(false));
  });

  describe('resolveVariantForPayment', () => {
    it('is complete when both dimensions are given in one message', () => {
      const r = svc.resolveVariantForPayment(P(), {}, 'M red please');
      expect(r.status).toBe('complete');
      expect(r.variant).toEqual({ size: 'M', color: 'Red' });
    });

    it('merges the prior selection with the new message', () => {
      const r = svc.resolveVariantForPayment(P(), { size: 'M' }, 'blue');
      expect(r.status).toBe('complete');
      expect(r.variant).toEqual({ size: 'M', color: 'Blue' });
    });

    it('asks for the missing colour when only a size is given', () => {
      const r = svc.resolveVariantForPayment(P(), {}, 'size L');
      expect(r.status).toBe('incomplete');
      expect(r.missing).toEqual(['color']);
      expect(r.variant).toEqual({ size: 'L', color: null });
      expect(r.message).toMatch(/colour/i);
    });

    it('asks for both when nothing is given', () => {
      const r = svc.resolveVariantForPayment(P(), {}, 'I want to buy this');
      expect(r.status).toBe('incomplete');
      expect(r.missing).toEqual(['size', 'color']);
    });

    it('reports an unavailable requested variant', () => {
      const r = svc.resolveVariantForPayment(P(), {}, 'XXL in red');
      expect(r.status).toBe('unavailable');
      expect(r.message).toMatch(/isn't available|not available/i);
      expect(r.message).toMatch(/S, M, L/);
    });

    it('is complete immediately for a product with no variants', () => {
      const r = svc.resolveVariantForPayment(P({ sizes: [], colors: [] }), {}, 'buy now');
      expect(r.status).toBe('complete');
      expect(r.variant).toEqual({ size: null, color: null });
    });

    it('only requires the dimensions that exist (colour-only product)', () => {
      const r = svc.resolveVariantForPayment(P({ sizes: [] }), {}, 'blue');
      expect(r.status).toBe('complete');
      expect(r.variant).toEqual({ size: null, color: 'Blue' });
    });

    it('reports out of stock', () => {
      const r = svc.resolveVariantForPayment(P({ stock: 0 }), {}, 'M red');
      expect(r.status).toBe('out_of_stock');
      expect(r.message).toMatch(/out of stock/i);
    });
  });

  describe('appendVariantToUrl', () => {
    it('appends encoded params, respecting an existing query string', () => {
      expect(svc.appendVariantToUrl('https://x.com/pay?ref=abc', { size: 'M', color: 'Navy Blue' }))
        .toBe('https://x.com/pay?ref=abc&size=M&color=Navy%20Blue');
    });
    it('adds a "?" when the url has no query', () => {
      expect(svc.appendVariantToUrl('https://x.com/pay', { size: 'L', color: null }))
        .toBe('https://x.com/pay?size=L');
    });
    it('returns the url unchanged when there is no variant', () => {
      expect(svc.appendVariantToUrl('https://x.com/pay', { size: null, color: null }))
        .toBe('https://x.com/pay');
    });
  });

  describe('summarizeVariant', () => {
    it('summarises present fields only', () => {
      expect(svc.summarizeVariant({ size: 'M', color: 'Red' })).toBe('size M / Red');
      expect(svc.summarizeVariant({ size: null, color: 'Red' })).toBe('Red');
      expect(svc.summarizeVariant({})).toBe('');
    });
  });
});
