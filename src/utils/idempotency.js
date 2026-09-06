const logger = require('../config/logger');

/**
 * Run `fn` at most once for a given (organizationId, scope, key) triple.
 *
 * If `key` is falsy, idempotency is skipped entirely and `fn()` just runs
 * (keeps this a strict opt-in — callers without a client-supplied key are
 * unaffected). This is what prevents double-click/retry from double-charging
 * AI credits or creating duplicate uploads (see plan: "Reliability, lifecycle,
 * and observability").
 *
 * @param {string} organizationId
 * @param {string} scope - short static string identifying the endpoint, e.g. 'posts.generate-variant-image'
 * @param {string|null|undefined} key - client-supplied idempotency key
 * @param {() => Promise<any>} fn - the side-effecting work to run exactly once; return value must be JSON-safe (stored in Mongo)
 * @returns {Promise<any>}
 */
async function runIdempotent(organizationId, scope, key, fn) {
  if (!key) return fn();

  const IdempotencyRecord = require('../models/IdempotencyRecord');

  let claim;
  try {
    claim = await IdempotencyRecord.create({ organization: organizationId, scope, key, status: 'pending' });
  } catch (err) {
    if (err?.code !== 11000) throw err; // not a duplicate-key race — real error
    // Another request with the same key is already in flight or finished.
    // Poll briefly for its result rather than re-running the side effect.
    for (let attempt = 0; attempt < 20; attempt++) {
      const existing = await IdempotencyRecord.findOne({ organization: organizationId, scope, key }).lean();
      if (!existing) break; // the earlier attempt failed and cleaned up — safe to fall through and retry fresh below
      if (existing.status === 'done') {
        logger.info('[idempotency] returning cached result', { scope, key });
        return existing.result;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    // Gave up waiting or the earlier claim was removed after a failure —
    // run fresh rather than blocking the user indefinitely. Rare edge case.
    try {
      claim = await IdempotencyRecord.create({ organization: organizationId, scope, key, status: 'pending' });
    } catch (raceErr) {
      if (raceErr?.code === 11000) return fn(); // extremely rare double race — fail open rather than hang
      throw raceErr;
    }
  }

  try {
    const result = await fn();
    claim.status = 'done';
    claim.result = result;
    await claim.save();
    return result;
  } catch (err) {
    // Allow a genuine retry after a failure — do not leave a permanently
    // "pending" claim that blocks the user from ever succeeding.
    await IdempotencyRecord.deleteOne({ _id: claim._id }).catch(() => {});
    throw err;
  }
}

module.exports = { runIdempotent };
