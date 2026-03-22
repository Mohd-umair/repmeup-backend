const Subscription = require('../models/Subscription');

/**
 * Plan admin helpers: subscriber counts and syncing denormalized Subscription
 * documents when the canonical Plan template changes.
 */

/**
 * @returns {Promise<Record<string, number>>} planId -> active subscription doc count
 */
async function getSubscriptionCountMap() {
  const counts = await Subscription.aggregate([
    { $group: { _id: '$planId', count: { $sum: 1 } } }
  ]);
  return Object.fromEntries(counts.map((c) => [c._id, c.count]));
}

/**
 * @param {Array<Record<string, unknown>>} plans - lean docs or plain objects with planId
 * @param {Record<string, number>} countMap
 */
function attachSubscriptionCounts(plans, countMap) {
  return plans.map((p) => ({
    ...p,
    subscriptionCount: countMap[p.planId] || 0
  }));
}

/**
 * Push plan template fields to all org subscriptions on this planId.
 * Runtime enforcement uses Subscription.limits (see subscriptionController), not live Plan.
 *
 * @param {import('mongoose').Document} plan - saved Plan document
 * @returns {Promise<number>} modifiedCount
 */
async function syncSubscriptionsFromPlan(plan) {
  const result = await Subscription.updateMany(
    { planId: plan.planId },
    {
      $set: {
        planName: plan.name,
        tier: plan.tier,
        limits: plan.limits,
        features: Array.isArray(plan.features) ? plan.features : []
      }
    }
  );
  return result.modifiedCount;
}

module.exports = {
  getSubscriptionCountMap,
  attachSubscriptionCounts,
  syncSubscriptionsFromPlan
};
