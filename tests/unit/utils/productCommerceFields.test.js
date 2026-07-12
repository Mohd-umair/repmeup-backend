'use strict';

const {
  normalizeGtin,
  normalizeAvailability,
  parseShippingWeight,
  coerceCommerceFields,
  resolveAvailability,
  deriveSalePrice
} = require('../../../src/utils/productCommerceFields');

describe('normalizeGtin', () => {
  it('strips dashes/spaces and accepts 8-14 digits', () => {
    expect(normalizeGtin('890-1234 567890')).toBe('8901234567890');
    expect(normalizeGtin('12345678')).toBe('12345678');
    expect(normalizeGtin('12345678901234')).toBe('12345678901234');
  });
  it('rejects invalid values', () => {
    expect(normalizeGtin('abc')).toBeNull();
    expect(normalizeGtin('1234567')).toBeNull();       // 7 digits
    expect(normalizeGtin('123456789012345')).toBeNull(); // 15 digits
    expect(normalizeGtin('')).toBeNull();
  });
});

describe('normalizeAvailability', () => {
  it.each([
    ['In Stock', 'in stock'], ['in_stock', 'in stock'], ['available', 'in stock'],
    ['OUT OF STOCK', 'out of stock'], ['sold out', 'out of stock']
  ])('normalizes %s → %s', (input, expected) => {
    expect(normalizeAvailability(input)).toBe(expected);
  });
  it('returns null for unknown values', () => {
    expect(normalizeAvailability('maybe')).toBeNull();
  });
});

describe('parseShippingWeight', () => {
  it('parses string and object forms', () => {
    expect(parseShippingWeight('0.5 kg')).toEqual({ value: 0.5, unit: 'kg' });
    expect(parseShippingWeight('500g')).toEqual({ value: 500, unit: 'g' });
    expect(parseShippingWeight({ value: 2, unit: 'lb' })).toEqual({ value: 2, unit: 'lb' });
  });
  it('rejects bad units/values', () => {
    expect(parseShippingWeight('5 stones')).toBeNull();
    expect(parseShippingWeight({ value: -1, unit: 'kg' })).toBeNull();
    expect(parseShippingWeight('')).toBeNull();
  });
});

describe('coerceCommerceFields', () => {
  it('accepts camelCase and snake_case keys', () => {
    const { commerce } = coerceCommerceFields({
      brand: 'Acme',
      origin_country: 'in',
      age_group: 'Adult',
      item_group_id: 'GRP-1',
      barcode: '8901234567890'
    }, { lenient: true });
    expect(commerce).toMatchObject({
      brand: 'Acme',
      originCountry: 'IN',
      ageGroup: 'adult',
      itemGroupId: 'GRP-1',
      gtin: '8901234567890'
    });
  });

  it('lenient mode drops invalid values with warnings, keeps the rest', () => {
    const { commerce, warnings, errors } = coerceCommerceFields({
      brand: 'Acme',
      condition: 'broken',
      gender: 'robot',
      gtin: 'not-a-gtin'
    }, { lenient: true });
    expect(commerce).toEqual({ brand: 'Acme' });
    expect(warnings).toHaveLength(3);
    expect(errors).toHaveLength(0);
  });

  it('strict mode collects errors instead of warnings', () => {
    const { errors, warnings } = coerceCommerceFields({ condition: 'broken' });
    expect(errors).toHaveLength(1);
    expect(warnings).toHaveLength(0);
  });

  it('returns null commerce when nothing valid is provided', () => {
    expect(coerceCommerceFields({}, { lenient: true }).commerce).toBeNull();
    expect(coerceCommerceFields({ condition: 'broken' }, { lenient: true }).commerce).toBeNull();
  });

  it('coerces importer address with country validation', () => {
    const { commerce } = coerceCommerceFields({
      importer_address: { street1: '1 MG Road', city: 'Bengaluru', postal_code: '560001', country: 'in' }
    }, { lenient: true });
    expect(commerce.importerAddress).toEqual({
      street1: '1 MG Road', city: 'Bengaluru', postalCode: '560001', country: 'IN'
    });
  });

  it('drops a sale window when end is not after start', () => {
    const { commerce, warnings } = coerceCommerceFields({
      salePriceStart: '2026-08-15', salePriceEnd: '2026-08-01'
    }, { lenient: true });
    expect(commerce).toBeNull();
    expect(warnings).toHaveLength(1);
  });

  it('truncates over-length strings to Meta limits', () => {
    const { commerce } = coerceCommerceFields({ brand: 'x'.repeat(200) }, { lenient: true });
    expect(commerce.brand).toHaveLength(100);
  });
});

describe('resolveAvailability', () => {
  it('override wins; otherwise derived from stock', () => {
    expect(resolveAvailability({ stock: 0, commerce: { availability: 'in stock' } })).toBe('in stock');
    expect(resolveAvailability({ stock: 0 })).toBe('out of stock');
    expect(resolveAvailability({ stock: null })).toBe('in stock');
    expect(resolveAvailability({})).toBe('in stock');
  });
});

describe('deriveSalePrice', () => {
  it('derives sale price from discountPercent', () => {
    const sale = deriveSalePrice({ price: 100, discountPercent: 25 });
    expect(sale.salePrice).toBe(75);
    expect(sale.start).toBeNull();
    expect(sale.end).toBeNull();
  });
  it('includes the window only when both bounds are valid', () => {
    const sale = deriveSalePrice({
      price: 100,
      discountPercent: 10,
      commerce: { salePriceStart: new Date('2026-08-01'), salePriceEnd: new Date('2026-08-15') }
    });
    expect(sale.start).toBeInstanceOf(Date);
    expect(sale.end).toBeInstanceOf(Date);
  });
  it('returns null without a discount', () => {
    expect(deriveSalePrice({ price: 100, discountPercent: 0 })).toBeNull();
    expect(deriveSalePrice({ price: 100 })).toBeNull();
  });
});
