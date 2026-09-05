/**
 * Floor applied to "human" mode only, so AI sentiment/intent processing
 * finishes before the natural-pause reply is sent. Fixed mode honours the exact
 * configured seconds (including 0 = send immediately).
 */
const HUMAN_MIN_DELAY_MS = 45 * 1000;
/** Extra random pause on human mode so replies feel natural, not instant-bot. */
const HUMAN_JITTER_MAX_MS = 30 * 1000;
/** Fixed delay is configured in SECONDS. */
const MAX_DELAY_SECONDS = 7200; // 2 hours

function clampSeconds(value, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(MAX_DELAY_SECONDS, Math.max(0, Math.round(n)));
}

/**
 * Normalize delay fields on autoReplySettings (mutates in place).
 * `webhookDelay` is stored in SECONDS.
 */
function normalizeAutoReplyDelaySettings(settings = {}) {
  if (!settings.replyDelayMode || !['fixed', 'human'].includes(settings.replyDelayMode)) {
    settings.replyDelayMode = 'fixed';
  }

  settings.webhookDelay = clampSeconds(settings.webhookDelay, 60);

  return settings;
}

/**
 * Compute Bull job delay (ms) before sending an auto-reply.
 * @param {object} settings - organization.autoReplySettings
 * @param {{ fallbackSeconds?: number, random?: () => number }} [opts]
 */
function computeReplyDelayMs(settings = {}, opts = {}) {
  const normalized = normalizeAutoReplyDelaySettings({ ...settings });
  const fallbackSeconds = opts.fallbackSeconds ?? 60;
  const random = typeof opts.random === 'function' ? opts.random : Math.random;

  if (normalized.replyDelayMode === 'human') {
    const jitter = Math.round(random() * HUMAN_JITTER_MAX_MS);
    return HUMAN_MIN_DELAY_MS + jitter;
  }

  // Fixed mode: honour the exact configured seconds, including 0 (immediate).
  const delaySec = clampSeconds(normalized.webhookDelay, fallbackSeconds);
  return delaySec * 1000;
}

module.exports = {
  HUMAN_MIN_DELAY_MS,
  HUMAN_JITTER_MAX_MS,
  MAX_DELAY_SECONDS,
  clampSeconds,
  normalizeAutoReplyDelaySettings,
  computeReplyDelayMs
};
