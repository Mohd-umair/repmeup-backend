const FlowEnrollment = require('../models/FlowEnrollment');
const flowTriggerRouter = require('../services/flow/flowTriggerRouter');
const logger = require('../config/logger');

/**
 * Process due flow enrollments (delays, quiet hours, reply timeouts).
 *
 * This tick can overlap with itself (a slow previous run still finishing when the next
 * scheduled tick fires) or run across multiple worker processes. Previously, `find()`
 * returned the due enrollments and they were processed directly — but the enrollment's
 * `status` in the DB stayed 'waiting' until `.save()` at the very end of processing, so
 * two overlapping ticks could both fetch and process the SAME enrollment, double-running
 * whatever it does next (e.g. sending its message twice).
 *
 * Fix: claim each candidate with an atomic `findOneAndUpdate` (status flip
 * 'waiting' -> 'active', conditioned on it STILL being 'waiting' and due) before doing
 * any work. Only the tick that wins the claim processes it; a losing concurrent claim
 * simply gets `null` back and skips it — no double-processing is possible regardless of
 * timing.
 */
module.exports = async function processFlowTick(job) {
  const batchSize = 50;
  const now = new Date();

  // Cheap id-only scan for candidates — select()+lean() since we don't need full documents
  // here; the atomic claim below is what actually fetches (and locks) the live document.
  const dueIds = await FlowEnrollment.find({
    status: 'waiting',
    nextRunAt: { $lte: now }
  })
    .select('_id')
    .sort({ nextRunAt: 1 })
    .limit(batchSize)
    .lean();

  let processed = 0;
  let skippedAlreadyClaimed = 0;

  for (const { _id } of dueIds) {
    // Atomic claim: succeeds only if this enrollment is STILL 'waiting' and due right now.
    // Loses the race to a concurrent tick (or the enrollment already resumed via an inbound
    // reply in the meantime) -> matches 0 documents -> `claimed` is null -> skip, don't run it.
    const claimed = await FlowEnrollment.findOneAndUpdate(
      { _id, status: 'waiting', nextRunAt: { $lte: now } },
      { $set: { status: 'active' } },
      { new: true }
    );

    if (!claimed) {
      skippedAlreadyClaimed += 1;
      continue;
    }

    try {
      await flowTriggerRouter.tickEnrollment(claimed);
      processed += 1;
    } catch (err) {
      logger.warn('[processFlowTick] enrollment failed', {
        enrollmentId: claimed._id,
        error: err.message
      });
      claimed.status = 'failed';
      claimed.lastError = err.message;
      await claimed.save();
    }
  }

  return { processed, total: dueIds.length, skippedAlreadyClaimed };
};
