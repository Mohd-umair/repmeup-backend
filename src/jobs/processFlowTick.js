const FlowEnrollment = require('../models/FlowEnrollment');
const flowTriggerRouter = require('../services/flow/flowTriggerRouter');
const logger = require('../config/logger');

/**
 * Process due flow enrollments (delays, quiet hours, reply timeouts).
 */
module.exports = async function processFlowTick(job) {
  const batchSize = 50;
  const now = new Date();

  const due = await FlowEnrollment.find({
    status: 'waiting',
    nextRunAt: { $lte: now }
  })
    .sort({ nextRunAt: 1 })
    .limit(batchSize);

  let processed = 0;
  for (const enrollment of due) {
    try {
      await flowTriggerRouter.tickEnrollment(enrollment);
      processed += 1;
    } catch (err) {
      logger.warn('[processFlowTick] enrollment failed', {
        enrollmentId: enrollment._id,
        error: err.message
      });
      enrollment.status = 'failed';
      enrollment.lastError = err.message;
      await enrollment.save();
    }
  }

  return { processed, total: due.length };
};
