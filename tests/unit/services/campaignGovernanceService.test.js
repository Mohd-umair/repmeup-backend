const campaignGovernance = require('../../../src/services/campaignGovernanceService');
const campaignConfig = require('../../../src/config/campaignConfig');

describe('campaignGovernanceService', () => {
  it('classifies 429 as transient and rate limit', () => {
    const err = Object.assign(new Error('Rate limit'), { httpStatus: 429, metaCode: 130429 });
    expect(campaignGovernance.isTransientSendError(err)).toBe(true);
    expect(campaignGovernance.isRateLimitError(err)).toBe(true);
  });

  it('classifies 500 as transient only', () => {
    const err = Object.assign(new Error('Server error'), { httpStatus: 503 });
    expect(campaignGovernance.isTransientSendError(err)).toBe(true);
    expect(campaignGovernance.isRateLimitError(err)).toBe(false);
  });

  it('does not classify validation errors as transient', () => {
    const err = new Error('Invalid phone number');
    expect(campaignGovernance.isTransientSendError(err)).toBe(false);
  });
});

describe('campaignConfig', () => {
  it('exposes sensible defaults', () => {
    expect(campaignConfig.batchSize).toBeGreaterThan(0);
    expect(campaignConfig.sendsPerSecond).toBeGreaterThan(0);
    expect(campaignConfig.maxSendAttempts).toBeGreaterThanOrEqual(1);
  });
});
