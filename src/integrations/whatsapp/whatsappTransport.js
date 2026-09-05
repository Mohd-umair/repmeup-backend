'use strict';

/**
 * WhatsApp transport resolver.
 *
 * Single responsibility: given a PlatformConnection, decide WHERE a WhatsApp API
 * call goes and HOW it authenticates. Nothing else in the codebase should build a
 * WhatsApp API base URL or auth header.
 *
 * Why this is only a base-URL + header swap
 * -----------------------------------------
 * Interakt's tech-partner API is a transparent proxy in front of Meta's Cloud API.
 * The paths, request payloads, response envelopes and error codes are byte-for-byte
 * Meta's:
 *
 *   Meta      POST https://graph.facebook.com/v23.0/{PHONE_NUMBER_ID}/messages
 *   Interakt  POST https://amped-express.interakt.ai/api/v23.0/{PHONE_NUMBER_ID}/messages
 *
 * Only the host and the auth headers differ:
 *
 *   Meta      Authorization: Bearer <per-connection user token>
 *   Interakt  x-access-token: <platform-wide ISV token>
 *             x-waba-id:      <per-connection WABA id>
 *
 * So callers keep building Meta-shaped payloads and keep reading Meta-shaped
 * responses. Error classification (campaignGovernanceService), delivery-status
 * handling and the webhook parser all continue to work unchanged.
 *
 * @see https://documenter.getpostman.com/view/14760594/2sA2r9X4Kb
 */

const GRAPH_HOST = 'https://graph.facebook.com';
const DEFAULT_API_VERSION = 'v23.0';

/** Interakt proxies the Graph API under /api/{version}. */
function interaktHost() {
  return (process.env.INTERAKT_API_BASE || 'https://amped-express.interakt.ai/api').replace(/\/+$/, '');
}

/**
 * Which transport carries this connection.
 * Absent/unknown resolves to 'meta', which is correct for every connection created
 * before the Interakt integration — including `.lean()` reads, where the Mongoose
 * schema default does not apply.
 */
function providerFor(connection) {
  return connection?.platformData?.provider === 'interakt' ? 'interakt' : 'meta';
}

/** WABA id, tolerating the two keys that exist in the wild. */
function wabaIdFor(connection) {
  const pd = connection?.platformData || {};
  return pd.wabaId || pd.businessAccountId || null;
}

/**
 * Resolve the transport for a connection.
 *
 * @param {object|null} connection PlatformConnection document or lean object
 * @param {object} [opts]
 * @param {string} [opts.apiVersion] override the Graph version for this call
 *        (template and catalog endpoints are pinned to v17.0 upstream)
 * @returns {{
 *   provider: 'meta'|'interakt',
 *   baseUrl: string,
 *   wabaId: string|null,
 *   authHeaders: () => object,
 *   jsonHeaders: () => object,
 *   formHeaders: (form: object) => object
 * }}
 */
function resolveTransport(connection, opts = {}) {
  const apiVersion = opts.apiVersion || DEFAULT_API_VERSION;
  const provider = providerFor(connection);

  if (provider === 'interakt') {
    const token = process.env.INTERAKT_ISV_TOKEN;
    const wabaId = wabaIdFor(connection);

    // Fail loudly. The whole point of this integration is that each tenant sends
    // from its OWN waba. Falling back to env here would recreate the exact
    // multi-tenancy bug that the platformData schema fix removed.
    if (!token) {
      throw new Error(
        'INTERAKT_ISV_TOKEN is not configured but this connection is marked provider=interakt.'
      );
    }
    if (!wabaId) {
      throw new Error(
        `WhatsApp connection ${connection?._id || '(unknown)'} is marked provider=interakt but has no ` +
        'platformData.wabaId. Re-run the Interakt signup, or backfill with scripts/backfillWhatsappWabaIds.js.'
      );
    }

    const base = { 'x-access-token': token, 'x-waba-id': wabaId };
    return {
      provider,
      baseUrl: `${interaktHost()}/${apiVersion}`,
      wabaId,
      authHeaders: () => ({ ...base }),
      jsonHeaders: () => ({ ...base, 'Content-Type': 'application/json' }),
      formHeaders: (form) => ({ ...base, ...(form?.getHeaders ? form.getHeaders() : {}) })
    };
  }

  const accessToken = connection?.accessToken || process.env.WHATSAPP_ACCESS_TOKEN;
  return {
    provider,
    baseUrl: `${GRAPH_HOST}/${apiVersion}`,
    wabaId: wabaIdFor(connection) || process.env.WHATSAPP_BUSINESS_ACCOUNT_ID || null,
    authHeaders: () => ({ Authorization: `Bearer ${accessToken}` }),
    jsonHeaders: () => ({ Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' }),
    formHeaders: (form) => ({
      Authorization: `Bearer ${accessToken}`,
      ...(form?.getHeaders ? form.getHeaders() : {})
    })
  };
}

/**
 * Attach provider-agnostic classification metadata to a thrown API error.
 *
 * campaignGovernanceService.isTransientSendError / isRateLimitError branch on
 * `httpStatus` and `metaCode`. Previously only sendTemplateMessage set these, so
 * 429 backoff silently did not apply to any other send method. Routing every call
 * through here gives the whole surface the same retry behaviour.
 *
 * Interakt returns Meta's error envelope verbatim, so one parser covers both.
 *
 * @param {Error} err        the axios error
 * @param {string} fallbackMessage message to use when the API gave us nothing useful
 * @returns {Error} a new Error carrying httpStatus / metaCode / metaSubcode
 */
function enrichApiError(err, fallbackMessage) {
  const apiError = err?.response?.data?.error;
  const message = apiError?.message || err?.message || fallbackMessage;
  const enriched = new Error(message || fallbackMessage);
  enriched.httpStatus = err?.response?.status;
  enriched.metaCode = apiError?.code;
  enriched.metaSubcode = apiError?.error_subcode;
  enriched.metaDetails = apiError?.error_data?.details;
  enriched.cause = err;
  return enriched;
}

module.exports = {
  resolveTransport,
  enrichApiError,
  providerFor,
  wabaIdFor,
  DEFAULT_API_VERSION
};
