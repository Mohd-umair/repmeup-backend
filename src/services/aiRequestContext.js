const { AsyncLocalStorage } = require('async_hooks');

const storage = new AsyncLocalStorage();

/**
 * Run async work with AI request context (org, user, feature) for usage attribution.
 * Child contexts inherit missing fields from the parent store.
 * @param {{ organizationId?: string|null, userId?: string|null, feature?: string|null }} context
 * @param {() => any} fn
 */
function runWithAiContext(context, fn) {
  const parent = storage.getStore() || {};
  const merged = {
    organizationId: context.organizationId !== undefined ? context.organizationId : parent.organizationId,
    userId: context.userId !== undefined ? context.userId : parent.userId,
    feature: context.feature !== undefined ? context.feature : parent.feature
  };
  return storage.run(merged, fn);
}

function getAiRequestContext() {
  return storage.getStore() || {};
}

module.exports = { runWithAiContext, getAiRequestContext };
