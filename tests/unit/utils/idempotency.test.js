/**
 * Tests for utils/idempotency.js — guards double-click/retry from
 * re-running side effects (most importantly: double AI-credit deduction,
 * duplicate uploads). See plan "Reliability, lifecycle, and observability".
 */

jest.mock('../../../src/config/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn()
}));

jest.mock('../../../src/models/IdempotencyRecord', () => ({
  create: jest.fn(),
  findOne: jest.fn(),
  deleteOne: jest.fn()
}));

const IdempotencyRecord = require('../../../src/models/IdempotencyRecord');
const { runIdempotent } = require('../../../src/utils/idempotency');

function dupKeyError() {
  const err = new Error('E11000 duplicate key');
  err.code = 11000;
  return err;
}

beforeEach(() => {
  IdempotencyRecord.create.mockReset();
  IdempotencyRecord.findOne.mockReset();
  IdempotencyRecord.deleteOne.mockReset().mockResolvedValue({});
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

describe('runIdempotent', () => {
  test('runs fn immediately and skips all DB work when no key is given', async () => {
    const fn = jest.fn().mockResolvedValue('result');
    const out = await runIdempotent('org1', 'scope', null, fn);
    expect(out).toBe('result');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(IdempotencyRecord.create).not.toHaveBeenCalled();
  });

  test('first call with a key creates a claim, runs fn once, marks it done, and returns the result', async () => {
    const claim = { _id: 'claim1', status: 'pending', save: jest.fn().mockResolvedValue(undefined) };
    IdempotencyRecord.create.mockResolvedValueOnce(claim);
    const fn = jest.fn().mockResolvedValue({ ok: true });

    const out = await runIdempotent('org1', 'posts.generate-variant-image', 'key-1', fn);

    expect(IdempotencyRecord.create).toHaveBeenCalledWith({
      organization: 'org1', scope: 'posts.generate-variant-image', key: 'key-1', status: 'pending'
    });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(claim.status).toBe('done');
    expect(claim.result).toEqual({ ok: true });
    expect(claim.save).toHaveBeenCalled();
    expect(out).toEqual({ ok: true });
  });

  test('a duplicate key error while the first call is still pending polls until it is done, then returns the cached result WITHOUT re-running fn', async () => {
    IdempotencyRecord.create.mockRejectedValueOnce(dupKeyError());
    IdempotencyRecord.findOne
      .mockReturnValueOnce({ lean: async () => ({ status: 'pending' }) })
      .mockReturnValueOnce({ lean: async () => ({ status: 'done', result: 'cached-result' }) });
    const fn = jest.fn();

    const promise = runIdempotent('org1', 'scope', 'key-1', fn);
    await jest.advanceTimersByTimeAsync(300); // let the 250ms poll delay elapse
    const out = await promise;

    expect(out).toBe('cached-result');
    expect(fn).not.toHaveBeenCalled();
  });

  test('a duplicate key error where the earlier claim was removed (failed) falls through and runs fn fresh', async () => {
    IdempotencyRecord.create
      .mockRejectedValueOnce(dupKeyError())
      .mockResolvedValueOnce({ _id: 'claim2', status: 'pending', save: jest.fn().mockResolvedValue(undefined) });
    IdempotencyRecord.findOne.mockReturnValueOnce({ lean: async () => null }); // earlier claim was deleted after failure
    const fn = jest.fn().mockResolvedValue('fresh-result');

    const out = await runIdempotent('org1', 'scope', 'key-1', fn);

    expect(out).toBe('fresh-result');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test('propagates a real (non-duplicate) error from IdempotencyRecord.create', async () => {
    IdempotencyRecord.create.mockRejectedValueOnce(new Error('mongo down'));
    await expect(runIdempotent('org1', 'scope', 'key-1', jest.fn())).rejects.toThrow('mongo down');
  });

  test('on fn failure, deletes the claim so a genuine retry can succeed later', async () => {
    const claim = { _id: 'claim1', status: 'pending', save: jest.fn() };
    IdempotencyRecord.create.mockResolvedValueOnce(claim);
    const fn = jest.fn().mockRejectedValue(new Error('generation failed'));

    await expect(runIdempotent('org1', 'scope', 'key-1', fn)).rejects.toThrow('generation failed');
    expect(IdempotencyRecord.deleteOne).toHaveBeenCalledWith({ _id: 'claim1' });
    expect(claim.save).not.toHaveBeenCalled();
  });
});
