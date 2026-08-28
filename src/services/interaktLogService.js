'use strict';

/**
 * Recording of Interakt API calls and inbound events.
 *
 * Every write here is best-effort and MUST NOT throw into the caller: logging a
 * failed onboarding must never itself break the onboarding path. All public methods
 * swallow their own errors and warn instead.
 */

const InteraktLog = require('../models/InteraktLog');
const logger = require('../config/logger');

/** Keys whose values must never reach the database. */
const SECRET_KEYS = new Set([
  'isv_name_token',
  'x-access-token',
  'authorization',
  'access_token',
  'client_secret',
  'verify_token',
  'token'
]);

const MAX_DEPTH = 6;
const MAX_STRING = 2000;

/**
 * Deep-clone a payload with secrets redacted and oversized strings clipped.
 * Interakt echoes our ISV token back on every inbound event, so redaction here is
 * the difference between an ops log and a credential leak.
 */
function sanitize(value, depth = 0) {
  if (value === null || value === undefined) return value ?? null;
  if (depth > MAX_DEPTH) return '[truncated: too deep]';

  if (typeof value === 'string') {
    return value.length > MAX_STRING ? value.slice(0, MAX_STRING) + '…[clipped]' : value;
  }
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => sanitize(v, depth + 1));

  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = SECRET_KEYS.has(k.toLowerCase()) ? '[redacted]' : sanitize(v, depth + 1);
  }
  return out;
}

/** Pull a readable message out of an axios error or a plain Error. */
function describe(error) {
  const data = error?.response?.data;
  return (
    data?.error?.error?.message ||   // Interakt's doubly-nested onboarding failures
    data?.error?.message ||
    data?.message ||
    error?.message ||
    'Unknown error'
  );
}

async function write(doc) {
  try {
    await InteraktLog.create(doc);
  } catch (err) {
    // Never let an audit write break the flow it is auditing.
    logger.warn('[interaktLog] could not persist entry', { error: err.message, action: doc?.action });
  }
}

/**
 * Record an outbound call to Interakt.
 * @param {object} p
 * @param {string} p.action        e.g. 'tp_signup' | 'configure_webhook' | 'unsubscribe'
 * @param {boolean} p.success
 * @param {number} [p.startedAt]   Date.now() before the call, for durationMs
 */
async function logOutbound({
  action, success, organization = null, platformConnection = null,
  wabaId = null, phoneNumberId = null, solutionId = null,
  endpoint = null, request = null, response = null, error = null, startedAt = null
} = {}) {
  await write({
    direction: 'outbound',
    action,
    status: success ? 'success' : 'failed',
    reason: success ? null : describe(error),
    organization,
    platformConnection,
    wabaId,
    phoneNumberId,
    solutionId,
    endpoint,
    httpStatus: error?.response?.status ?? error?.httpStatus ?? (success ? 200 : null),
    errorCode: error?.response?.data?.error?.code != null
      ? String(error.response.data.error.code)
      : (error?.metaCode != null ? String(error.metaCode) : null),
    durationMs: startedAt ? Date.now() - startedAt : null,
    request: sanitize(request),
    response: sanitize(success ? response : (error?.response?.data ?? null))
  });
}

/**
 * Record an inbound event from Interakt.
 * @param {object} p
 * @param {string} p.event    raw event name, e.g. 'WABA_ONBOARDED'
 * @param {boolean} p.success whether the event represents a good outcome
 */
async function logInbound({
  event, success, reason = null, organization = null, platformConnection = null,
  wabaId = null, phoneNumberId = null, payload = null, errorCode = null
} = {}) {
  await write({
    direction: 'inbound',
    action: event || 'UNKNOWN',
    status: success ? 'success' : 'failed',
    reason,
    organization,
    platformConnection,
    wabaId,
    phoneNumberId,
    errorCode: errorCode != null ? String(errorCode) : null,
    request: sanitize(payload),
    response: null
  });
}

module.exports = { logOutbound, logInbound, sanitize, describe };
