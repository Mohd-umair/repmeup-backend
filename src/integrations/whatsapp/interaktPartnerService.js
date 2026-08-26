'use strict';

/**
 * Interakt tech-partner APIs.
 *
 * These are the calls that make a freshly onboarded WABA usable through Interakt.
 * They are NOT Graph-shaped and do NOT go through whatsappTransport — that module
 * covers the Graph proxy (amped-express). This one covers Interakt's own partner
 * control plane plus the one Graph-proxy call that configures our webhook.
 *
 * Two different auth schemes live here. Do not mix them:
 *
 *   api.interakt.ai/v1/organizations/*   ->  Authorization: <ISV_TOKEN>   (no "Bearer")
 *   amped-express.interakt.ai/api/*      ->  x-access-token + x-waba-id
 *
 * @see https://documenter.getpostman.com/view/14760594/2sA2r9X4Kb
 */

const axios = require('axios');
const logger = require('../../config/logger');

const DEFAULT_PARTNER_BASE = 'https://api.interakt.ai/v1';
const DEFAULT_PROXY_BASE = 'https://amped-express.interakt.ai/api';
/** Interakt documents webhook configuration on v17.0. */
const WEBHOOK_CONFIG_API_VERSION = 'v17.0';

function partnerBase() {
  return (process.env.INTERAKT_PARTNER_API_BASE || DEFAULT_PARTNER_BASE).replace(/\/+$/, '');
}

function proxyBase() {
  return (process.env.INTERAKT_API_BASE || DEFAULT_PROXY_BASE).replace(/\/+$/, '');
}

function isvToken() {
  const token = process.env.INTERAKT_ISV_TOKEN;
  if (!token) throw new Error('INTERAKT_ISV_TOKEN is not configured.');
  return token;
}

function solutionId() {
  const id = process.env.INTERAKT_SOLUTION_ID;
  if (!id) throw new Error('INTERAKT_SOLUTION_ID is not configured.');
  return id;
}

/**
 * The callback URL we hand Interakt. Must be the same endpoint Meta would call,
 * because Interakt forwards Meta-format webhooks verbatim — so the existing
 * handler at /api/webhooks/whatsapp parses them unchanged.
 */
function webhookUrl() {
  const base = (process.env.BASE_URL || process.env.BACKEND_URL || '').replace(/\/+$/, '');
  if (!base) throw new Error('BASE_URL is not configured — cannot build the Interakt webhook URL.');
  return `${base}/api/webhooks/whatsapp`;
}

function verifyToken() {
  const token = process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN || process.env.META_WEBHOOK_VERIFY_TOKEN;
  if (!token) throw new Error('WHATSAPP_WEBHOOK_VERIFY_TOKEN is not configured.');
  return token;
}

/** Interakt returns Meta-style error envelopes; surface something readable. */
function describeError(error) {
  const d = error?.response?.data;
  return (
    d?.error?.message ||
    d?.message ||
    (typeof d === 'string' ? d.slice(0, 200) : null) ||
    error?.message ||
    'Unknown Interakt API error'
  );
}

/**
 * Register a WABA against our Interakt partner solution.
 *
 * `auto_subscribe` is deliberately false: we configure the webhook ourselves in
 * configureWebhook() so the callback URL is always ours. Letting Interakt
 * auto-subscribe risks it pointing somewhere we do not control.
 *
 * @param {object} params
 * @param {string} params.wabaId
 * @param {string} [params.phoneNumber] E.164. Send ONLY when the WABA holds more
 *        than one number — Interakt's docs say to omit the field otherwise.
 */
async function registerWaba({ wabaId, phoneNumber } = {}) {
  if (!wabaId) throw new Error('registerWaba: wabaId is required.');

  const wabaInfo = {
    waba_id: String(wabaId),
    solution_id: solutionId(),
    data_localization_region: process.env.INTERAKT_DATA_LOCALIZATION_REGION || 'IN'
  };
  if (phoneNumber) wabaInfo.phone_number = phoneNumber;

  const body = {
    entry: [{ changes: [{ value: { event: 'PARTNER_ADDED', waba_info: wabaInfo } }] }],
    auto_subscribe: false,
    object: 'tech_partner'
  };

  try {
    const res = await axios.post(`${partnerBase()}/organizations/tp-signup/`, body, {
      headers: { Authorization: isvToken(), 'Content-Type': 'application/json' },
      timeout: 20000
    });
    logger.info('[Interakt] WABA registered', { wabaId, success: res.data?.success });
    return { success: res.data?.success !== false, data: res.data };
  } catch (error) {
    const message = describeError(error);
    logger.error('[Interakt] tp-signup failed', { wabaId, status: error?.response?.status, message });
    const err = new Error(`Interakt registration failed: ${message}`);
    err.httpStatus = error?.response?.status;
    throw err;
  }
}

/**
 * Register our callback URL for a WABA.
 *
 * This is the endpoint that answers "Interakt ko apna webhook kaise dein" — once
 * set, Interakt delivers inbound messages AND delivery statuses (sent / delivered /
 * read / failed) to override_callback_uri in Meta's exact webhook format.
 *
 * Shape follows Interakt's "Add/Update Webhook URL" onboarding doc:
 *   POST {proxy}/v17.0/{WABA_ID}/subscribed_apps
 *   headers: x-access-token, x-waba-id
 *   body:    { override_callback_uri, verify_token }     <- FLAT, not nested
 *
 * Note this is WABA-level, not per phone number. Interakt's Postman collection also
 * documents a per-number variant (POST {proxy}/v17.0/{PHONE_NUMBER_ID} with the body
 * wrapped in `webhook_configuration`) — see configureNumberWebhook below. The
 * WABA-level call is used by default because it is what the onboarding doc
 * prescribes and it covers every number on the account.
 */
async function configureWebhook({ wabaId, callbackUrl } = {}) {
  if (!wabaId) throw new Error('configureWebhook: wabaId is required.');

  const url = `${proxyBase()}/${WEBHOOK_CONFIG_API_VERSION}/${wabaId}/subscribed_apps`;
  const body = {
    override_callback_uri: callbackUrl || webhookUrl(),
    verify_token: verifyToken()
  };

  try {
    const res = await axios.post(url, body, {
      headers: {
        'x-access-token': isvToken(),
        'x-waba-id': String(wabaId),
        'Content-Type': 'application/json'
      },
      timeout: 20000
    });
    logger.info('[Interakt] Webhook configured for WABA', { wabaId, callbackUri: body.override_callback_uri });
    return { success: res.data?.success !== false, data: res.data };
  } catch (error) {
    const message = describeError(error);
    logger.error('[Interakt] Webhook configuration failed', { wabaId, status: error?.response?.status, message });
    const err = new Error(`Interakt webhook configuration failed: ${message}`);
    err.httpStatus = error?.response?.status;
    throw err;
  }
}

/**
 * Per-phone-number webhook override (Postman: "Number-Level Webhook Configuration").
 * Only needed when one number in a WABA must post somewhere different from the rest.
 * Body is nested under `webhook_configuration` here — deliberately different from the
 * WABA-level call above; do not "unify" them.
 */
async function configureNumberWebhook({ phoneNumberId, wabaId, callbackUrl } = {}) {
  if (!phoneNumberId) throw new Error('configureNumberWebhook: phoneNumberId is required.');
  if (!wabaId) throw new Error('configureNumberWebhook: wabaId is required.');

  const url = `${proxyBase()}/${WEBHOOK_CONFIG_API_VERSION}/${phoneNumberId}`;
  const body = {
    webhook_configuration: {
      override_callback_uri: callbackUrl || webhookUrl(),
      verify_token: verifyToken()
    }
  };

  try {
    const res = await axios.post(url, body, {
      headers: {
        'x-access-token': isvToken(),
        'x-waba-id': String(wabaId),
        'x-phone-number-id': String(phoneNumberId),
        'Content-Type': 'application/json'
      },
      timeout: 20000
    });
    logger.info('[Interakt] Number-level webhook configured', { phoneNumberId, wabaId });
    return { success: res.data?.success !== false, data: res.data };
  } catch (error) {
    const message = describeError(error);
    logger.error('[Interakt] Number-level webhook configuration failed', { phoneNumberId, wabaId, message });
    const err = new Error(`Interakt number webhook configuration failed: ${message}`);
    err.httpStatus = error?.response?.status;
    throw err;
  }
}

/**
 * Detach a number from our Interakt solution. Best-effort by design: it runs on
 * the disconnect path, where a remote failure must not block the local cleanup.
 */
async function unsubscribe({ wabaId, phoneNumberId } = {}) {
  if (!wabaId) throw new Error('unsubscribe: wabaId is required.');

  try {
    const res = await axios.post(
      `${partnerBase()}/organizations/tp-unsubscribe/`,
      { waba_id: String(wabaId), phone_number_id: phoneNumberId ? String(phoneNumberId) : undefined },
      { headers: { Authorization: isvToken(), 'Content-Type': 'application/json' }, timeout: 15000 }
    );
    logger.info('[Interakt] Unsubscribed', { wabaId, phoneNumberId, message: res.data?.message });
    return { success: true, data: res.data };
  } catch (error) {
    const message = describeError(error);
    logger.warn('[Interakt] Unsubscribe failed (continuing with local disconnect)', { wabaId, phoneNumberId, message });
    return { success: false, error: message };
  }
}

/** True when the platform is configured to onboard through Interakt at all. */
function isConfigured() {
  return Boolean(process.env.INTERAKT_ISV_TOKEN && process.env.INTERAKT_SOLUTION_ID);
}

module.exports = {
  registerWaba,
  configureWebhook,
  configureNumberWebhook,
  unsubscribe,
  isConfigured,
  webhookUrl,
  solutionId
};
