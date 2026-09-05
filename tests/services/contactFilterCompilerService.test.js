'use strict';

const { compileFilterQuery } = require('../../src/services/contactFilterCompilerService');

describe('contactFilterCompilerService', () => {
  test('compiles a whitelisted numeric filter', () => {
    expect(compileFilterQuery({
      logic: 'AND',
      conditions: [{ field: 'leadScore', operator: 'gte', value: 70 }]
    }).mongo).toEqual({ 'intelligence.leadScore': { $gte: 70 } });
  });

  test('rejects arbitrary Mongo paths', () => {
    expect(() => compileFilterQuery({
      logic: 'AND',
      conditions: [{ field: 'organization', operator: 'neq', value: 'x' }]
    })).toThrow('Unsupported contact filter field');
  });

  test('rejects operator objects as scalar values', () => {
    expect(() => compileFilterQuery({
      logic: 'AND',
      conditions: [{ field: 'tags', operator: 'eq', value: { $ne: null } }]
    })).toThrow('must be a scalar value');
  });

  test('parses false for exists instead of treating the string as truthy', () => {
    expect(compileFilterQuery({
      logic: 'AND',
      conditions: [{ field: 'owner', operator: 'exists', value: 'false' }]
    }).mongo).toEqual({
      $or: [{ owner: { $exists: false } }, { owner: null }]
    });
  });

  test('rejects campaign filters inside OR groups', () => {
    expect(() => compileFilterQuery({
      logic: 'OR',
      conditions: [
        {
          field: 'campaign',
          operator: 'eq',
          value: { campaignId: '507f1f77bcf86cd799439011', condition: 'replied' }
        },
        { field: 'lifecycle', operator: 'eq', value: 'vip' }
      ]
    })).toThrow('cannot be used inside an OR group');
  });

  test('rejects invalid last activity values instead of casting to Date', () => {
    expect(() => compileFilterQuery({
      logic: 'AND',
      conditions: [{ field: 'lastActivity', operator: 'eq', value: 'whatsapp' }]
    })).toThrow('Last activity value must be today, last_7_days, or last_30_days');
  });
});
