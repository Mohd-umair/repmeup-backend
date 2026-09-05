'use strict';

const VALID_AI_INTENTS = new Set(['inquiry', 'complaint', 'praise', 'feedback', 'support', 'other']);

/** Mongo ObjectId strings must never be shown or stored as aiInsights.intent. */
function isObjectIdString(value) {
  return typeof value === 'string' && /^[a-f0-9]{24}$/i.test(value.trim());
}

/**
 * Normalize intent for contact AI insights — rejects bucket IDs and unknown garbage.
 * @returns {string|null}
 */
function sanitizeAiIntent(value) {
  if (value == null || value === '') return null;
  const s = String(value).trim();
  if (!s || isObjectIdString(s)) return null;
  const lower = s.toLowerCase();
  if (VALID_AI_INTENTS.has(lower)) return lower;
  // Allow short human labels (legacy/custom) but not long hex-like strings
  if (s.length <= 32 && !/^[a-f0-9]+$/i.test(s)) return s;
  return null;
}

module.exports = {
  VALID_AI_INTENTS,
  isObjectIdString,
  sanitizeAiIntent
};
