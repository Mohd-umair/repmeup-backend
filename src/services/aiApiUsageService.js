const mongoose = require('mongoose');
const AiApiUsage = require('../models/AiApiUsage');
const { estimateChatUsd, estimateImageUsd, estimateVideoUsd } = require('./openaiPricing');
const logger = require('../config/logger');
const { noteLastAiApiUsageId } = require('./aiRequestContext');

const MAX_SNAPSHOT_CHARS = Math.min(
  Math.max(parseInt(process.env.AI_USAGE_MAX_SNAPSHOT_CHARS, 10) || 500_000, 10_000),
  1_500_000
);

/**
 * Persist OpenAI `messages` safely (cap serialized size so documents stay well under BSON limits).
 */
function capPromptMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return undefined;
  try {
    const copy = JSON.parse(JSON.stringify(messages));
    const raw = JSON.stringify(copy);
    if (raw.length <= MAX_SNAPSHOT_CHARS) return copy;
    return {
      _truncated: true,
      originalApproxChars: raw.length,
      preview: raw.slice(0, MAX_SNAPSHOT_CHARS - 80) + '\n…[truncated]'
    };
  } catch {
    return undefined;
  }
}

function capCompletionText(text) {
  if (text == null || text === '') return '';
  const s = typeof text === 'string' ? text : String(text);
  if (s.length <= MAX_SNAPSHOT_CHARS) return s;
  return `${s.slice(0, MAX_SNAPSHOT_CHARS - 40)}\n…[truncated]`;
}

function toObjectIdOrNull(id) {
  if (!id) return null;
  if (id instanceof mongoose.Types.ObjectId) return id;
  const s = String(id);
  if (!mongoose.Types.ObjectId.isValid(s)) return null;
  return new mongoose.Types.ObjectId(s);
}

/**
 * @param {object} params
 */
async function persistChatUsage(params) {
  const {
    organizationId,
    userId,
    feature,
    model,
    promptTokens = 0,
    completionTokens = 0,
    totalTokens = 0,
    promptMessages,
    completionText = '',
    metadata = {}
  } = params;

  const pt = Number(promptTokens) || 0;
  const ct = Number(completionTokens) || 0;
  const tt = Number(totalTokens) || pt + ct;
  const est = estimateChatUsd(model, pt, ct);

  const doc = await AiApiUsage.create({
    organization: toObjectIdOrNull(organizationId),
    user: toObjectIdOrNull(userId),
    feature,
    apiKind: 'chat',
    model: model || '',
    promptTokens: pt,
    completionTokens: ct,
    totalTokens: tt,
    estimatedUsd: est,
    promptMessages: capPromptMessages(promptMessages),
    completionText: capCompletionText(completionText),
    metadata
  });
  noteLastAiApiUsageId(doc._id);
}

async function persistImageUsage(params) {
  const {
    organizationId,
    userId,
    feature,
    model,
    size,
    quality,
    metadata = {}
  } = params;
  const est = estimateImageUsd(size, quality);
  const doc = await AiApiUsage.create({
    organization: toObjectIdOrNull(organizationId),
    user: toObjectIdOrNull(userId),
    feature,
    apiKind: 'image',
    model: model || '',
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    estimatedUsd: est,
    metadata: { ...metadata, size, quality }
  });
  noteLastAiApiUsageId(doc._id);
}

async function persistVideoUsage(params) {
  const {
    organizationId,
    userId,
    feature,
    model,
    durationSeconds,
    metadata = {}
  } = params;
  const est = estimateVideoUsd(durationSeconds);
  const doc = await AiApiUsage.create({
    organization: toObjectIdOrNull(organizationId),
    user: toObjectIdOrNull(userId),
    feature,
    apiKind: 'video',
    model: model || '',
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    estimatedUsd: est,
    metadata: { ...metadata, durationSeconds }
  });
  noteLastAiApiUsageId(doc._id);
}

function safeRecord(promise, label) {
  return promise.catch((err) => {
    logger.warn(`AiApiUsage ${label} logging failed`, { error: err.message });
  });
}

module.exports = {
  recordChatUsage: (p) => safeRecord(persistChatUsage(p), 'chat'),
  recordImageUsage: (p) => safeRecord(persistImageUsage(p), 'image'),
  recordVideoUsage: (p) => safeRecord(persistVideoUsage(p), 'video'),
  toObjectIdOrNull
};
