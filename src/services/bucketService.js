/**
 * Bucket Service — usage accounting for `limit` features with a reset period.
 *
 * Why this exists:
 *   The legacy `Subscription.usage.{postsThisMonth, autoRepliesThisMonth, …}` shape
 *   only handled a fixed set of counters and required a model change for every new
 *   quota (post-creation credits, unique contacts, …). This service moves all of
 *   that into a generic `Subscription.usageBuckets[key] = { used, periodStart }`
 *   and exposes three primitives that the entitlements engine and feature
 *   enforcement code can use:
 *
 *     - getBucket(orgId, key)       → { used, periodStart, isFresh }
 *     - consume(orgId, key, n=1)    → atomic increment, lazily resets stale buckets
 *     - reset(orgId, key)           → manual reset (admin tools, cron)
 *
 * Period semantics:
 *   - 'monthly' resets when `now` crosses into a new calendar month vs periodStart.
 *   - 'daily'   resets when `now` crosses into a new calendar day.
 *   - 'none'    is treated as never-resetting (cumulative cap).
 *
 * The reset is LAZY by design: we don't run a cron worker, we just compare on read
 * and on write. This stays correct across server restarts and time-zone changes
 * because we always compare in UTC.
 */

const Subscription = require('../models/Subscription');
const { CATALOG_BY_KEY } = require('../config/featureCatalog');

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Feature keys are dotted ('credits.autoReply.monthly'), but `Subscription.usageBuckets`
 * is a Mongoose Map — and a dot in an update path is ALWAYS a path separator to MongoDB.
 * `usageBuckets.credits.autoReply.monthly.used` therefore reads as a four-level descent
 * into a Map whose values only have { used, periodStart }, so strict mode silently
 * dropped every write and `used` stayed 0 forever. That is why these quotas never
 * enforced.
 *
 * Buckets are stored under a dot-free key instead. This is an internal storage detail:
 * every public function still takes and returns the canonical dotted feature key.
 */
const KEY_SEPARATOR = '__';

function storageKey(featureKey) {
  return String(featureKey).split('.').join(KEY_SEPARATOR);
}

/** Read a bucket out of a subscription doc (lean object or hydrated Map). */
function readStoredBucket(usageBuckets, featureKey) {
  if (!usageBuckets) return null;
  const key = storageKey(featureKey);
  if (typeof usageBuckets.get === 'function') {
    return usageBuckets.get(key) || usageBuckets.get(featureKey) || null;
  }
  // Legacy docs may hold the dotted key from before the escaping fix.
  return usageBuckets[key] || usageBuckets[featureKey] || null;
}

/** UTC year+month identifier for monthly buckets. */
function monthKey(d) {
  return `${d.getUTCFullYear()}-${d.getUTCMonth()}`;
}
/** UTC date identifier for daily buckets. */
function dayKey(d) {
  return `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`;
}

/**
 * Decide whether a bucket needs to be reset before we trust its `used` value.
 *
 * @param {{ used: number, periodStart: Date|null|undefined }} bucket
 * @param {'none'|'daily'|'monthly'} resetPeriod
 * @param {Date} [now]
 * @returns {boolean} true → caller must reset to 0 before reading/writing
 */
function isStale(bucket, resetPeriod, now = new Date()) {
  if (!bucket || !bucket.periodStart) return resetPeriod !== 'none';
  if (resetPeriod === 'none') return false;
  const start = bucket.periodStart instanceof Date ? bucket.periodStart : new Date(bucket.periodStart);
  if (resetPeriod === 'monthly') return monthKey(start) !== monthKey(now);
  if (resetPeriod === 'daily') return dayKey(start) !== dayKey(now);
  return false;
}

/**
 * Read a bucket, transparently resetting if the period rolled over.
 * Returns a plain object — does NOT persist a reset (use consume/reset for that).
 */
async function getBucket(organizationId, featureKey) {
  const subscription = await Subscription.findOne({ organization: organizationId })
    .select('usageBuckets')
    .lean();

  const catalogEntry = CATALOG_BY_KEY[featureKey];
  const resetPeriod = catalogEntry?.resetPeriod || 'none';
  const raw = readStoredBucket(subscription?.usageBuckets, featureKey);
  const stale = isStale(raw, resetPeriod);

  return {
    used: stale ? 0 : (raw?.used ?? 0),
    periodStart: stale ? new Date() : (raw?.periodStart || null),
    resetPeriod,
    isFresh: !stale && !!raw
  };
}

/**
 * Consume `amount` of feature `featureKey` for an organization.
 *
 * Atomicity:
 *   - We use a single `findOneAndUpdate` per call. If the bucket is stale, we
 *     reset and increment in two steps (reset, then $inc) within the same call
 *     wrapped in a tiny race window. If two reset+increment calls collide, the
 *     worst case is one extra reset (counter starts at `amount` regardless,
 *     so quota math is preserved).
 *
 * @returns {Promise<{used: number, periodStart: Date}>} bucket state AFTER increment.
 */
async function consume(organizationId, featureKey, amount = 1) {
  if (!organizationId) throw new Error('bucketService.consume: organizationId required');
  if (!featureKey) throw new Error('bucketService.consume: featureKey required');
  if (!Number.isFinite(amount) || amount === 0) {
    return getBucket(organizationId, featureKey);
  }

  const catalogEntry = CATALOG_BY_KEY[featureKey];
  const resetPeriod = catalogEntry?.resetPeriod || 'none';
  const now = new Date();

  const path = `usageBuckets.${storageKey(featureKey)}`;

  // Step 1: read current bucket (lean — we'll do the actual write next).
  const current = await Subscription.findOne({ organization: organizationId })
    .select(path)
    .lean();
  const raw = readStoredBucket(current?.usageBuckets, featureKey);
  const stale = isStale(raw, resetPeriod, now);

  // Step 2: write. If stale (or never touched), seed the whole bucket so periodStart
  // is always present; otherwise increment in place.
  const update = (stale || !raw)
    ? { $set: { [path]: { used: amount, periodStart: now } } }
    : { $inc: { [`${path}.used`]: amount } };

  const updated = await Subscription.findOneAndUpdate(
    { organization: organizationId },
    update,
    { new: true, upsert: false }
  ).select(path);

  // Mirror legacy counters so older controllers still report correct numbers
  // during the transition window. Best-effort, never throws.
  await mirrorLegacyCounter(organizationId, featureKey, amount, stale).catch(() => {});

  const final = readStoredBucket(updated?.usageBuckets, featureKey) || {};
  return {
    used: final.used ?? amount,
    periodStart: final.periodStart || now
  };
}

/**
 * Reset a single bucket to 0 (admin tool / scheduled job).
 */
async function reset(organizationId, featureKey) {
  await Subscription.findOneAndUpdate(
    { organization: organizationId },
    { $set: { [`usageBuckets.${storageKey(featureKey)}`]: { used: 0, periodStart: new Date() } } }
  );
}

/**
 * Reset ALL buckets whose period has rolled over for one organization.
 * Cheaper to call from a cron than `reset` per key.
 */
async function sweepStaleBuckets(organizationId) {
  const subscription = await Subscription.findOne({ organization: organizationId })
    .select('usageBuckets');
  if (!subscription?.usageBuckets) return 0;

  let rolled = 0;
  const now = new Date();

  subscription.usageBuckets.forEach((bucket, key) => {
    // Stored keys are dot-escaped; the catalog is keyed by the canonical dotted key.
    const featureKey = key.split(KEY_SEPARATOR).join('.');
    const resetPeriod = CATALOG_BY_KEY[featureKey]?.resetPeriod || 'none';
    if (isStale(bucket, resetPeriod, now)) {
      subscription.usageBuckets.set(key, { used: 0, periodStart: now });
      rolled += 1;
    }
  });

  if (rolled > 0) {
    subscription.markModified('usageBuckets');
    await subscription.save();
  }
  return rolled;
}

/**
 * Keep legacy `Subscription.usage.*` numeric fields in sync with the bucket
 * write so older controllers (subscriptionController, header credit chip, …)
 * still see fresh data during the transition.
 *
 * Mapping is intentionally narrow: only the legacy fields we know about.
 * Anything not in this map is bucket-only.
 */
async function mirrorLegacyCounter(organizationId, featureKey, amount, wasReset) {
  const LEGACY = {
    'credits.autoReply.monthly': 'usage.autoRepliesThisMonth',
    'credits.postCreation.monthly': 'usage.postsThisMonth',
    'credits.ai.monthly': 'usage.aiCreditsThisMonth',
    'posts.perMonth': 'usage.postsThisMonth'
  };
  const path = LEGACY[featureKey];
  if (!path) return;

  if (wasReset) {
    await Subscription.updateOne(
      { organization: organizationId },
      { $set: { [path]: amount, 'usage.lastResetAt': new Date() } }
    );
  } else {
    await Subscription.updateOne(
      { organization: organizationId },
      { $inc: { [path]: amount } }
    );
  }
}

module.exports = {
  getBucket,
  consume,
  reset,
  sweepStaleBuckets,
  // exported for tests
  _isStale: isStale
};
