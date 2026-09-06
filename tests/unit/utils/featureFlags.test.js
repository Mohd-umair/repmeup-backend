const { isProductShootEnabled } = require('../../../src/utils/featureFlags');

describe('featureFlags.isProductShootEnabled', () => {
  const original = process.env.PRODUCT_SHOOT_KILL_SWITCH;

  afterEach(() => {
    if (original === undefined) delete process.env.PRODUCT_SHOOT_KILL_SWITCH;
    else process.env.PRODUCT_SHOOT_KILL_SWITCH = original;
  });

  it('fails open (enabled) when the env var is unset', () => {
    delete process.env.PRODUCT_SHOOT_KILL_SWITCH;
    expect(isProductShootEnabled()).toBe(true);
  });

  it('fails open for any value other than the exact string "true"', () => {
    process.env.PRODUCT_SHOOT_KILL_SWITCH = 'yes';
    expect(isProductShootEnabled()).toBe(true);
  });

  it('is disabled only when explicitly set to "true"', () => {
    process.env.PRODUCT_SHOOT_KILL_SWITCH = 'true';
    expect(isProductShootEnabled()).toBe(false);
  });
});
