'use strict';

const {
  suggestImportMapping,
  validateImportMapping
} = require('../../src/utils/contactImportMapping');

describe('contactImportMapping', () => {
  test('suggestImportMapping detects common header variants', () => {
    const headers = ['Full Name', 'Mobile Number', 'Email Address'];
    const suggested = suggestImportMapping(headers);
    expect(suggested.phone).toBe('Mobile Number');
    expect(suggested.email).toBe('Email Address');
    expect(suggested.name).toBe('Full Name');
  });

  test('validateImportMapping requires user-selected phone or email', () => {
    const headers = ['Col A', 'Col B'];
    expect(validateImportMapping(headers, {}).error).toMatch(/Phone or Email/i);
    expect(validateImportMapping(headers, { phone: 'Col A' }).mapping.phone).toBe('Col A');
  });

  test('validateImportMapping rejects unknown columns', () => {
    const headers = ['Name', 'Phone'];
    expect(validateImportMapping(headers, { phone: 'Missing' }).error).toMatch(/not in this CSV/i);
  });

  test('import uses only explicit mapping — no auto-detect fallback', () => {
    const headers = ['Full Name', 'Mobile', 'Mail'];
    const result = validateImportMapping(headers, {});
    expect(result.error).toBeTruthy();
    expect(validateImportMapping(headers, { name: 'Full Name', phone: 'Mobile' }).mapping.name).toBe('Full Name');
  });
});
