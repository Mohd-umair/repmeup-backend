const mongoose = require('mongoose');
const AiApiUsage = require('../models/AiApiUsage');
const { estimateChatUsd, estimateImageUsd, estimateVideoUsd } = require('./openaiPricing');
const logger = require('../config/logger');

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
    metadata = {}
  } = params;

  const pt = Number(promptTokens) || 0;
  const ct = Number(completionTokens) || 0;
  const tt = Number(totalTokens) || pt + ct;
  const est = estimateChatUsd(model, pt, ct);

  await AiApiUsage.create({
    organization: toObjectIdOrNull(organizationId),
    user: toObjectIdOrNull(userId),
    feature,
    apiKind: 'chat',
    model: model || '',
    promptTokens: pt,
    completionTokens: ct,
    totalTokens: tt,
    estimatedUsd: est,
    metadata
  });
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
  await AiApiUsage.create({
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
  await AiApiUsage.create({
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
