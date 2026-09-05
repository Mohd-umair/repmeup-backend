'use strict';

/**
 * Twilio integration for the AI Voice IVR.
 *
 * - BYOW: one client per org from customer SID + token.
 * - Managed: Twilio subaccount under TWILIO_MASTER_ACCOUNT_SID; provisioned on demand.
 * - Webhook signature validation uses the same Auth Token as the REST client for that org.
 */

const twilio = require('twilio');
const VoicePhoneCredential = require('../../models/VoicePhoneCredential');
const logger = require('../../config/logger');

const svcLogger = logger.createChild({ module: 'twilioService' });

function getMasterClient() {
  const sid = String(process.env.TWILIO_MASTER_ACCOUNT_SID || '').trim();
  const token = String(process.env.TWILIO_MASTER_AUTH_TOKEN || '').trim();
  if (!sid || !token) {
    const err = new Error('Platform telephony master credentials are not configured');
    err.statusCode = 503;
    throw err;
  }
  return twilio(sid, token);
}

/**
 * Ensure a managed org has a Twilio subaccount. Idempotent; closes orphan subaccount on provisioning races.
 */
async function ensureManagedSubaccount(organizationId) {
  const orgStr = String(organizationId);
  const master = getMasterClient();

  const existing = await VoicePhoneCredential.findOne({ organization: organizationId }).lean();
  if (!existing || existing.telephonyMode !== 'managed') return;
  if (existing.twilioSubaccountSid && existing.twilioSubaccountAuthToken) return;

  const friendlyName = `repmeup-${orgStr.slice(-10)}`;
  let createdSid = null;
  try {
    const sub = await master.api.v2010.accounts.create({ friendlyName: friendlyName });
    createdSid = sub.sid;
    const updated = await VoicePhoneCredential.findOneAndUpdate(
      {
        organization: organizationId,
        telephonyMode: 'managed',
        $or: [
          { twilioSubaccountSid: { $exists: false } },
          { twilioSubaccountSid: '' },
          { twilioSubaccountSid: null }
        ]
      },
      {
        $set: {
          twilioSubaccountSid: sub.sid,
          twilioSubaccountAuthToken: sub.authToken
        }
      },
      { new: true }
    );

    if (!updated && createdSid) {
      try {
        await master.api.v2010.accounts(createdSid).update({ status: 'closed' });
      } catch (closeErr) {
        svcLogger.warn('[twilio] Closed duplicate subaccount after race', {
          sid: createdSid,
          error: closeErr.message
        });
      }
    }
  } catch (err) {
    svcLogger.error('[twilio] Subaccount create failed', { error: err.message, orgId: orgStr });
    throw err;
  }
}

/** @param {object} credential VoicePhoneCredential lean doc */
function resolveAccountSidToken(credential) {
  const mode = credential.telephonyMode === 'managed' ? 'managed' : 'byow';
  if (mode === 'managed') {
    return {
      sid: credential.twilioSubaccountSid || '',
      token: credential.twilioSubaccountAuthToken || ''
    };
  }
  return {
    sid: credential.twilioAccountSid || '',
    token: credential.twilioAuthToken || ''
  };
}

/**
 * @param {object} credential VoicePhoneCredential document (or plain object).
 * @returns {object} Twilio REST client
 */
function buildClientFromCredential(credential) {
  const { sid, token } = resolveAccountSidToken(credential);
  if (!sid || !token) {
    const err = new Error('Telephony credentials not configured for this organization');
    err.statusCode = 412;
    throw err;
  }
  return twilio(sid, token);
}

async function getCredential(organizationId) {
  const credential = await VoicePhoneCredential.findOne({ organization: organizationId }).lean();
  if (!credential || !credential.isActive) {
    const err = new Error('Voice IVR not configured for this organization');
    err.statusCode = 412;
    throw err;
  }
  return credential;
}

/**
 * @returns {Promise<{ client: import('twilio').Twilio, credential: object, authTokenForSignature: string }>}
 */
async function getClient(organizationId) {
  const credential = await getCredential(organizationId);
  if (credential.telephonyMode === 'managed') {
    await ensureManagedSubaccount(organizationId);
  }
  const fresh = await getCredential(organizationId);
  const { token } = resolveAccountSidToken(fresh);
  return {
    client: buildClientFromCredential(fresh),
    credential: fresh,
    authTokenForSignature: token
  };
}

async function getWebhookAuthToken(organizationId) {
  const credential = await VoicePhoneCredential.findOne({ organization: organizationId }).lean();
  if (!credential || !credential.isActive) return '';
  const { token } = resolveAccountSidToken(credential);
  return token || '';
}

/**
 * Close managed subaccount when removing credentials (best effort).
 */
async function closeManagedSubaccountIfAny(credentialDoc) {
  if (!credentialDoc || credentialDoc.telephonyMode !== 'managed' || !credentialDoc.twilioSubaccountSid) {
    return;
  }
  try {
    const master = getMasterClient();
    await master.api.v2010.accounts(credentialDoc.twilioSubaccountSid).update({ status: 'closed' });
  } catch (err) {
    svcLogger.warn('[twilio] Could not close subaccount', {
      sid: credentialDoc.twilioSubaccountSid,
      error: err.message
    });
  }
}

function resolvePublicBaseUrl(credential) {
  const trimmed = ((credential && credential.publicBaseUrl) || '').replace(/\/$/, '');
  if (trimmed) return trimmed;
  return String(process.env.PUBLIC_API_BASE_URL || '').replace(/\/$/, '');
}

/** Twilio returns 404 when that geography has no inventory for that number class (Local vs National vs Mobile, etc.). */
function isAvailableNumberTypeNotFound(err) {
  const status = Number(err?.status ?? err?.statusCode ?? err?.response?.status);
  if (status === 404) return true;
  const code = err?.code;
  if (code === 20404 || Number(code) === 20404) return true;
  const msg = String(err?.message || err?.body?.message || '');
  if (/AvailablePhoneNumbers\//i.test(msg) && /not\s*found|404|was not found/i.test(msg)) return true;
  return false;
}

function mapAvailableNumberRow(n, numberType) {
  return {
    phoneNumber: n.phoneNumber,
    friendlyName: n.friendlyName,
    locality: n.locality,
    region: n.region,
    postalCode: n.postalCode,
    isoCountry: n.isoCountry,
    capabilities: n.capabilities,
    numberType
  };
}

/**
 * Search numbers available to purchase.
 * Tries Local → National → Mobile → Toll-free (many countries omit Local or use National for fixed-line).
 * @param {string} organizationId
 * @param {object} options { country='US', areaCode?, contains?, limit=20 }
 */
async function searchAvailableNumbers(organizationId, { country = 'US', areaCode, contains, limit = 20 } = {}) {
  const limitNum = Math.min(30, Math.max(1, parseInt(limit, 10) || 20));
  const { client } = await getClient(organizationId);
  const iso = String(country || 'US').toUpperCase();

  const baseParams = { limit: limitNum, voiceEnabled: true };
  if (contains) baseParams.contains = contains;

  const withOptionalAreaCode = (params) => {
    const p = { ...params };
    if (areaCode) p.areaCode = areaCode;
    return p;
  };

  const apn = client.availablePhoneNumbers(iso);

  const buildAttempts = (paramsBase) => [
    { type: 'local', run: () => apn.local.list(withOptionalAreaCode(paramsBase)) },
    { type: 'national', run: () => apn.national.list(withOptionalAreaCode(paramsBase)) },
    { type: 'mobile', run: () => apn.mobile.list(withOptionalAreaCode(paramsBase)) },
    { type: 'tollFree', run: () => apn.tollFree.list({ ...paramsBase }) }
  ];

  const runPasses = async (paramsBase) => {
    for (const { type, run } of buildAttempts(paramsBase)) {
      try {
        const list = await run();
        if (Array.isArray(list) && list.length > 0) {
          return list.map((n) => mapAvailableNumberRow(n, type));
        }
      } catch (err) {
        if (isAvailableNumberTypeNotFound(err)) {
          svcLogger.debug('[twilio] No inventory for number class, trying next', {
            country: iso,
            type,
            message: err?.message
          });
          continue;
        }
        throw err;
      }
    }
    return null;
  };

  let results = await runPasses(baseParams);
  if (!results) {
    const loose = { limit: limitNum };
    if (contains) loose.contains = contains;
    results = await runPasses(loose);
    if (results) {
      results = results.filter((r) => r.capabilities?.voice !== false);
    }
  }
  return results || [];
}

/**
 * Purchase a phone number and configure it to hit our inbound webhook.
 * @param {string} organizationId
 * @param {string} phoneNumber  E.164, e.g. +14155552671
 */
async function purchaseNumber(organizationId, phoneNumber) {
  const { client, credential } = await getClient(organizationId);
  const base = resolvePublicBaseUrl(credential);
  if (!base) {
    const err = new Error('Public API base URL is not configured (set PUBLIC_API_BASE_URL or public base URL)');
    err.statusCode = 400;
    throw err;
  }
  const result = await client.incomingPhoneNumbers.create({
    phoneNumber,
    voiceUrl: `${base}/api/voice/webhooks/incoming`,
    voiceMethod: 'POST',
    statusCallback: `${base}/api/voice/webhooks/status`,
    statusCallbackMethod: 'POST'
  });
  return {
    sid: result.sid,
    phoneNumber: result.phoneNumber,
    friendlyName: result.friendlyName,
    capabilities: result.capabilities
  };
}

/** Release (delete) a phone number from the Twilio account. */
async function releaseNumber(organizationId, twilioSid) {
  const { client } = await getClient(organizationId);
  await client.incomingPhoneNumbers(twilioSid).remove();
}

/** Update a number's voice webhook URLs (used when re-pointing to a new public URL). */
async function updateNumberWebhooks(organizationId, twilioSid) {
  const { client, credential } = await getClient(organizationId);
  const base = resolvePublicBaseUrl(credential);
  if (!base) return null;
  return client.incomingPhoneNumbers(twilioSid).update({
    voiceUrl: `${base}/api/voice/webhooks/incoming`,
    voiceMethod: 'POST',
    statusCallback: `${base}/api/voice/webhooks/status`,
    statusCallbackMethod: 'POST'
  });
}

/**
 * Initiate an outbound call from the org's Twilio number.
 * The TwiML the caller hears comes from /api/voice/webhooks/incoming (same handler as inbound).
 */
async function createOutboundCall(organizationId, { from, to, agentId }) {
  const { client, credential } = await getClient(organizationId);
  const base = resolvePublicBaseUrl(credential);
  if (!base) {
    const err = new Error('Public API base URL is not configured');
    err.statusCode = 400;
    throw err;
  }
  const url = `${base}/api/voice/webhooks/incoming?agentId=${encodeURIComponent(agentId || '')}`;
  const call = await client.calls.create({
    to,
    from,
    url,
    statusCallback: `${base}/api/voice/webhooks/status`,
    statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
    statusCallbackMethod: 'POST'
  });
  return { sid: call.sid, status: call.status, from, to };
}

/**
 * Build TwiML that streams the call's audio to our WebSocket gateway.
 *
 * @param {object} opts
 * @param {string} opts.wsUrl      wss://… absolute URL for the media stream
 * @param {string} [opts.greeting] If set, says it via cloud TTS before <Connect><Stream>
 * @param {string} [opts.callSid]  passed to the gateway as a custom parameter
 * @param {string} [opts.agentId]
 * @returns {string} TwiML XML
 */
function buildStreamTwiml({ wsUrl, greeting, callSid, agentId }) {
  const VoiceResponse = twilio.twiml.VoiceResponse;
  const response = new VoiceResponse();

  if (greeting && greeting.trim()) {
    response.say({ voice: 'Polly.Joanna' }, greeting);
  }

  const connect = response.connect();
  const stream = connect.stream({ url: wsUrl });
  if (callSid) stream.parameter({ name: 'callSid', value: String(callSid) });
  if (agentId) stream.parameter({ name: 'agentId', value: String(agentId) });

  return response.toString();
}

/**
 * Verify the X-Twilio-Signature header on an Express request.
 * Body-parsed form data is required (Twilio sends application/x-www-form-urlencoded).
 *
 * @param {object} req         Express request
 * @param {string} authToken   Twilio Auth Token (for the account that received the webhook)
 * @returns {boolean}
 */
function validateWebhookSignature(req, authToken) {
  if (!authToken) return false;
  const signature = req.header('X-Twilio-Signature');
  if (!signature) return false;
  const proto = req.header('X-Forwarded-Proto') || req.protocol;
  const host = req.header('X-Forwarded-Host') || req.get('host');
  const url = `${proto}://${host}${req.originalUrl}`;
  const params = { ...req.body };
  return twilio.validateRequest(authToken, signature, url, params);
}

module.exports = {
  buildClient: buildClientFromCredential,
  getCredential,
  getClient,
  getWebhookAuthToken,
  ensureManagedSubaccount,
  closeManagedSubaccountIfAny,
  searchAvailableNumbers,
  purchaseNumber,
  releaseNumber,
  updateNumberWebhooks,
  createOutboundCall,
  buildStreamTwiml,
  validateWebhookSignature,
  resolvePublicBaseUrl
};
