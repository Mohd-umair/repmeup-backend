'use strict';

/**
 * processFlowTick — atomic claim prevents double-ticking.
 *
 * Bug this protects against: the tick can overlap with itself (slow previous run + a new
 * scheduled tick) or run on multiple workers. Before this fix, `find()` returned due
 * enrollments and they were processed directly while the DB doc stayed 'waiting' until the
 * very end — so two overlapping ticks could both grab and process the same enrollment,
 * double-sending whatever it does next. The fix claims each one with an atomic
 * findOneAndUpdate (status: 'waiting' -> 'active') before doing any work.
 */

jest.mock('../../../src/models/FlowEnrollment', () => ({
  find: jest.fn(),
  findOneAndUpdate: jest.fn()
}));
jest.mock('../../../src/services/flow/flowTriggerRouter', () => ({
  tickEnrollment: jest.fn()
}));
jest.mock('../../../src/config/logger', () => ({ warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const FlowEnrollment = require('../../../src/models/FlowEnrollment');
const flowTriggerRouter = require('../../../src/services/flow/flowTriggerRouter');
const processFlowTick = require('../../../src/jobs/processFlowTick');

function mockFindChain(docs) {
  FlowEnrollment.find.mockReturnValue({
    select: () => ({
      sort: () => ({
        limit: () => ({
          lean: async () => docs
        })
      })
    })
  });
}

beforeEach(() => jest.clearAllMocks());

describe('processFlowTick — atomic claim', () => {
  it('processes an enrollment it successfully claims', async () => {
    mockFindChain([{ _id: 'enr_1' }]);
    const claimedDoc = { _id: 'enr_1', status: 'active', save: jest.fn() };
    FlowEnrollment.findOneAndUpdate.mockResolvedValue(claimedDoc);
    flowTriggerRouter.tickEnrollment.mockResolvedValue(undefined);

    const result = await processFlowTick({});

    expect(flowTriggerRouter.tickEnrollment).toHaveBeenCalledWith(claimedDoc);
    expect(result).toEqual({ processed: 1, total: 1, skippedAlreadyClaimed: 0 });
  });

  it('skips (does not tick) an enrollment that a concurrent tick already claimed', async () => {
    mockFindChain([{ _id: 'enr_1' }, { _id: 'enr_2' }]);
    // enr_1: lost the claim race (another worker/tick got there first) -> null back.
    // enr_2: won the claim.
    FlowEnrollment.findOneAndUpdate
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ _id: 'enr_2', status: 'active', save: jest.fn() });
    flowTriggerRouter.tickEnrollment.mockResolvedValue(undefined);

    const result = await processFlowTick({});

    // The critical assertion: tickEnrollment must NEVER be called for the enrollment whose
    // claim lost the race — that is exactly what would double-process it.
    expect(flowTriggerRouter.tickEnrollment).toHaveBeenCalledTimes(1);
    expect(flowTriggerRouter.tickEnrollment).toHaveBeenCalledWith(expect.objectContaining({ _id: 'enr_2' }));
    expect(result).toEqual({ processed: 1, total: 2, skippedAlreadyClaimed: 1 });
  });

  it('marks the enrollment failed (and does not rethrow) if tickEnrollment throws', async () => {
    mockFindChain([{ _id: 'enr_1' }]);
    const claimedDoc = { _id: 'enr_1', status: 'active', save: jest.fn().mockResolvedValue(undefined) };
    FlowEnrollment.findOneAndUpdate.mockResolvedValue(claimedDoc);
    flowTriggerRouter.tickEnrollment.mockRejectedValue(new Error('boom'));

    const result = await processFlowTick({});

    expect(claimedDoc.status).toBe('failed');
    expect(claimedDoc.lastError).toBe('boom');
    expect(claimedDoc.save).toHaveBeenCalled();
    expect(result.processed).toBe(0);
  });

  it('claim query requires status still "waiting" and due (nextRunAt <= now) — the actual race guard', async () => {
    mockFindChain([{ _id: 'enr_1' }]);
    FlowEnrollment.findOneAndUpdate.mockResolvedValue({ _id: 'enr_1', save: jest.fn() });
    flowTriggerRouter.tickEnrollment.mockResolvedValue(undefined);

    await processFlowTick({});

    const [filter, update, opts] = FlowEnrollment.findOneAndUpdate.mock.calls[0];
    expect(filter).toMatchObject({ _id: 'enr_1', status: 'waiting' });
    expect(filter.nextRunAt).toHaveProperty('$lte');
    expect(update).toEqual({ $set: { status: 'active' } });
    expect(opts).toMatchObject({ new: true });
  });
});
