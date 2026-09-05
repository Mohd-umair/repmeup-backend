const { AsyncLocalStorage } = require('async_hooks');
const mongoose = require('mongoose');

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
    feature: context.feature !== undefined ? context.feature : parent.feature,
    /** Latest AiApiUsage document id created in this async context (vendor log). */
    lastAiApiUsageId: parent.lastAiApiUsageId
  };
  return storage.run(merged, fn);
}

function getAiRequestContext() {
  return storage.getStore() || {};
}

/** Remember the most recent vendor usage row so `deductCredits` can attach application credits to it. */
function noteLastAiApiUsageId(id) {
  if (id == null) return;
  const store = storage.getStore();
  if (store) {
    store.lastAiApiUsageId = String(id);
  }
}

/** Clear after linking credits so another `deductCredits` in the same async chain does not reuse the id. */
function clearLastAiApiUsageId() {
  const store = storage.getStore();
  if (store) {
    delete store.lastAiApiUsageId;
  }
}

/**
 * Like `runWithAiContext`, but returns the latest AiApiUsage id created during `fn`
 * (for `deductCredits` after the ALS scope ends — the store is not available there).
 * @template T
 * @param {{ organizationId?: string|null, userId?: string|null, feature?: string|null }} context
 * @param {() => Promise<T> | T} fn
 * @returns {Promise<{ result: T, aiApiUsageId: string | null }>}
 */
async function runWithAiContextAndUsageId(context, fn) {
  const parent = storage.getStore() || {};
  const merged = {
    organizationId: context.organizationId !== undefined ? context.organizationId : parent.organizationId,
    userId: context.userId !== undefined ? context.userId : parent.userId,
    feature: context.feature !== undefined ? context.feature : parent.feature,
    lastAiApiUsageId: parent.lastAiApiUsageId
  };
  return storage.run(merged, async () => {
    const result = await fn();
    const store = storage.getStore();
    const raw = store && store.lastAiApiUsageId != null ? String(store.lastAiApiUsageId) : '';
    const aiApiUsageId = raw && mongoose.Types.ObjectId.isValid(raw) ? raw : null;
    return { result, aiApiUsageId };
  });
}

module.exports = {
  runWithAiContext,
  runWithAiContextAndUsageId,
  getAiRequestContext,
  noteLastAiApiUsageId,
  clearLastAiApiUsageId
};
