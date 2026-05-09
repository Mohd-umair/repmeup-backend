/**
 * Guards for synced (historical / backlog) interactions: skip paid AI and auto-reply
 * when the message is not "live" relative to connection time and age window.
 */

const SYNC_AUTO_REPLY_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours — keep in sync with auto-reply semantics

/** Upper bound for Unix timestamp in seconds (~2100-01-01) — values in [0, this] are treated as seconds. */
const MAX_PLAUSIBLE_UNIX_SEC = 4102444800;

/**
 * Normalize inbox/source field (whitespace, casing).
 * @param {unknown} source
 * @returns {string}
 */
function normalizeSyncSource(source) {
  return String(source == null ? '' : source).toLowerCase().trim();
}

/**
 * True when this interaction was ingested via platform history sync.
 * @param {object|null|undefined} interaction
 */
function isSyncInteraction(interaction) {
  if (!interaction) return false;
  return normalizeSyncSource(interaction.source) === 'sync';
}

/**
 * Parse platform / DB date fields to epoch ms. Handles Date, ISO strings, and numeric Unix (sec or ms).
 * @param {unknown} raw
 * @returns {number|null}
 */
function parseToEpochMs(raw) {
  if (raw == null || raw === '') return null;
  if (raw instanceof Date) {
    const t = raw.getTime();
    return Number.isNaN(t) ? null : t;
  }
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    const n = raw;
    const ms = n >= 0 && n <= MAX_PLAUSIBLE_UNIX_SEC ? n * 1000 : n;
    const t = new Date(ms).getTime();
    return Number.isNaN(t) ? null : t;
  }
  const t = new Date(raw).getTime();
  return Number.isNaN(t) ? null : t;
}

/**
 * Only assign keyword/default bucket when we are not stomping a human choice.
 * @param {import('mongoose').Document|object|null|undefined} interaction
 */
function shouldApplyHeuristicIntentBucket(interaction) {
  if (!interaction) return false;
  const hasBucket =
    interaction.intentBucket != null &&
    String(interaction.intentBucket).length > 0 &&
    String(interaction.intentBucket) !== 'null';
  if (hasBucket) return false;
  const by = normalizeSyncSource(interaction.bucketAssignedBy);
  if (by === 'manual') return false;
  return true;
}

/**
 * @param {import('mongoose').Document|object|null|undefined} interaction
 * @param {import('mongoose').Document|object|null|undefined} connectionDoc - PlatformConnection lean or doc
 * @returns {boolean} true → skip paid AI / treat as backfill
 */
function shouldSkipAiProcessingForSyncedInteraction(interaction, connectionDoc) {
  if (!isSyncInteraction(interaction)) {
    return false;
  }

  const msgMs = parseToEpochMs(
    interaction.platformCreatedAt != null ? interaction.platformCreatedAt : interaction.createdAt
  );
  if (msgMs == null) {
    return true;
  }

  const cutoffRaw =
    connectionDoc?.connectedAt != null ? connectionDoc.connectedAt : connectionDoc?.createdAt;
  const cutoffMs = parseToEpochMs(cutoffRaw);

  const isHistorical = cutoffMs != null && msgMs < cutoffMs;

  const ageMs = Math.max(0, Date.now() - msgMs);
  const isTooOld = ageMs > SYNC_AUTO_REPLY_AGE_MS;

  return Boolean(isHistorical || isTooOld);
}

module.exports = {
  SYNC_AUTO_REPLY_AGE_MS,
  shouldSkipAiProcessingForSyncedInteraction,
  shouldApplyHeuristicIntentBucket,
  parseToEpochMs,
  isSyncInteraction,
  normalizeSyncSource
};
