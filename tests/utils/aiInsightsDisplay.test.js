'use strict';

const { sanitizeAiIntent, isObjectIdString } = require('../../src/utils/aiInsightsDisplay');

describe('aiInsightsDisplay', () => {
  test('rejects Mongo ObjectId as intent', () => {
    expect(sanitizeAiIntent('69a1176846e470b1db379f80')).toBeNull();
    expect(isObjectIdString('69a1176846e470b1db379f80')).toBe(true);
  });

  test('accepts valid intent enums', () => {
    expect(sanitizeAiIntent('inquiry')).toBe('inquiry');
    expect(sanitizeAiIntent('COMPLAINT')).toBe('complaint');
  });
});
