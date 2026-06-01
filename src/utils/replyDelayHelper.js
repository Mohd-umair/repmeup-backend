/** Minimum queue delay so processAI (sentiment, intent) can finish before send. */
const MIN_DELAY_MS = 45 * 1000;
/** Extra random pause on human mode so replies feel natural, not instant-bot. */
const HUMAN_JITTER_MAX_MS = 30 * 1000;
const MAX_DELAY_MINUTES = 120;

function clampMinutes(value, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(MAX_DELAY_MINUTES, Math.max(0, Math.round(n)));
}

/**
 * Normalize delay fields on autoReplySettings (mutates in place).
 */
function normalizeAutoReplyDelaySettings(settings = {}) {
  if (!settings.replyDelayMode || !['fixed', 'human'].includes(settings.replyDelayMode)) {
    settings.replyDelayMode = 'fixed';
  }

  settings.webhookDelay = clampMinutes(settings.webhookDelay, 1);

  return settings;
}

/**
 * Compute Bull job delay (ms) before sending an auto-reply.
 * @param {object} settings - organization.autoReplySettings
 * @param {{ fallbackMinutes?: number, random?: () => number }} [opts]
 */
function computeReplyDelayMs(settings = {}, opts = {}) {
  const normalized = normalizeAutoReplyDelaySettings({ ...settings });
  const fallbackMinutes = opts.fallbackMinutes ?? 1;
  const random = typeof opts.random === 'function' ? opts.random : Math.random;

  if (normalized.replyDelayMode === 'human') {
    const jitter = Math.round(random() * HUMAN_JITTER_MAX_MS);
    return MIN_DELAY_MS + jitter;
  }

  const delayMin = clampMinutes(normalized.webhookDelay, fallbackMinutes);
  return Math.max(delayMin * 60 * 1000, MIN_DELAY_MS);
}

module.exports = {
  MIN_DELAY_MS,
  HUMAN_JITTER_MAX_MS,
  MAX_DELAY_MINUTES,
  clampMinutes,
  normalizeAutoReplyDelaySettings,
  computeReplyDelayMs
};
