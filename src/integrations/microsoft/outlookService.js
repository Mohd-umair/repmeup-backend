/**
 * Outlook / Microsoft Graph Service
 *
 * Handles Microsoft 365 / Outlook email integration via Microsoft Graph API:
 *  - OAuth 2.0 authorization code flow
 *  - Creating / renewing Graph change-notification subscriptions
 *  - Fetching individual messages
 *  - Sending replies
 *  - Downloading attachments
 *
 * Environment variables required:
 *   MICROSOFT_CLIENT_ID
 *   MICROSOFT_CLIENT_SECRET
 *   MICROSOFT_REDIRECT_URI   (e.g. https://api.repmeup.in/api/email/callback/outlook)
 *   OUTLOOK_WEBHOOK_CLIENT_STATE  (secret used to validate incoming Graph notifications)
 *
 * Error contract
 * ──────────────
 * All functions throw a plain Error with a machine-readable `.code` property:
 *   OUTLOOK_AUTH_FAILED        - token refresh / exchange failed
 *   OUTLOOK_FETCH_FAILED       - message fetch failed
 *   OUTLOOK_SEND_FAILED        - send failed
 *   OUTLOOK_SUBSCRIPTION_FAILED - Graph subscription create/renew failed
 */

const axios = require('axios');
const PlatformConnection = require('../../models/PlatformConnection');
const logger = require('../../config/logger');

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';
const MS_TOKEN_URL = 'https://login.microsoftonline.com/common/oauth2/v2.0/token';
const MS_AUTH_URL = 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize';

// Graph mail subscriptions expire after 3 days for mail resources
const SUBSCRIPTION_EXPIRY_DAYS = 2;

// ── OAuth ─────────────────────────────────────────────────────────────────────

/**
 * Generate the Microsoft OAuth consent URL.
 * @param {string} state - CSRF / org state token
 * @returns {string}
 */
function getAuthUrl(state) {
  const params = new URLSearchParams({
    client_id: process.env.MICROSOFT_CLIENT_ID,
    response_type: 'code',
    redirect_uri: process.env.MICROSOFT_REDIRECT_URI,
    scope: 'offline_access Mail.Read Mail.Send User.Read',
    response_mode: 'query',
    state
  });
  return `${MS_AUTH_URL}?${params.toString()}`;
}

/**
 * Exchange an authorization code for tokens.
 * @param {string} code
 * @returns {Promise<{ tokens: object, email: string, name: string }>}
 */
async function exchangeCodeForTokens(code) {
  const params = new URLSearchParams({
    client_id: process.env.MICROSOFT_CLIENT_ID,
    client_secret: process.env.MICROSOFT_CLIENT_SECRET,
    redirect_uri: process.env.MICROSOFT_REDIRECT_URI,
    grant_type: 'authorization_code',
    code
  });

  let tokenRes;
  try {
    tokenRes = await axios.post(MS_TOKEN_URL, params.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });
  } catch (err) {
    const outErr = new Error(`Microsoft token exchange failed: ${err.message}`);
    outErr.code = 'OUTLOOK_AUTH_FAILED';
    throw outErr;
  }

  const tokens = tokenRes.data;

  // Fetch user profile
  const profileRes = await axios.get(`${GRAPH_BASE}/me`, {
    headers: { Authorization: `Bearer ${tokens.access_token}` }
  });

  return {
    tokens,
    email: profileRes.data.mail || profileRes.data.userPrincipalName,
    name: profileRes.data.displayName || profileRes.data.mail
  };
}

// ── Token Refresh ─────────────────────────────────────────────────────────────

async function _refreshAccessToken(connection) {
  if (!connection.refreshToken) {
    const err = new Error('No refresh token available — user must reconnect Outlook');
    err.code = 'OUTLOOK_AUTH_FAILED';
    throw err;
  }

  const params = new URLSearchParams({
    client_id: process.env.MICROSOFT_CLIENT_ID,
    client_secret: process.env.MICROSOFT_CLIENT_SECRET,
    refresh_token: connection.refreshToken,
    grant_type: 'refresh_token',
    scope: 'offline_access Mail.Read Mail.Send User.Read'
  });

  const res = await axios.post(MS_TOKEN_URL, params.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
  });

  const tokens = res.data;
  const update = {
    accessToken: tokens.access_token,
    tokenExpiry: new Date(Date.now() + tokens.expires_in * 1000)
  };
  if (tokens.refresh_token) update.refreshToken = tokens.refresh_token;

  await PlatformConnection.findByIdAndUpdate(connection._id, update);
  return tokens.access_token;
}

async function _getAccessToken(connection) {
  if (connection.tokenExpiry && new Date(connection.tokenExpiry) > new Date(Date.now() + 60000)) {
    return connection.accessToken;
  }
  return _refreshAccessToken(connection);
}

// ── Graph Subscriptions ───────────────────────────────────────────────────────

/**
 * Create a Graph change-notification subscription for the connected mailbox.
 * Stores msSubscriptionId and msSubscriptionExpiry on the PlatformConnection.
 *
 * @param {object} connection - PlatformConnection document
 * @returns {Promise<void>}
 */
async function createSubscription(connection) {
  const token = await _getAccessToken(connection);
  const expiryDate = new Date(Date.now() + SUBSCRIPTION_EXPIRY_DAYS * 24 * 60 * 60 * 1000);

  let res;
  try {
    res = await axios.post(
      `${GRAPH_BASE}/subscriptions`,
      {
        changeType: 'created',
        notificationUrl: `${process.env.BACKEND_URL || process.env.FRONTEND_URL?.replace('/app', '')}/api/webhooks/outlook`,
        resource: 'me/mailFolders/inbox/messages',
        expirationDateTime: expiryDate.toISOString(),
        clientState: process.env.OUTLOOK_WEBHOOK_CLIENT_STATE || 'repmeup-outlook-webhook'
      },
      { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    const subErr = new Error(`Graph subscription creation failed: ${err.response?.data?.error?.message || err.message}`);
    subErr.code = 'OUTLOOK_SUBSCRIPTION_FAILED';
    throw subErr;
  }

  await PlatformConnection.findByIdAndUpdate(connection._id, {
    'platformData.msSubscriptionId': res.data.id,
    'platformData.msSubscriptionExpiry': expiryDate
  });

  logger.info('[outlookService] Graph subscription created', {
    connectionId: connection._id,
    subscriptionId: res.data.id,
    expiry: expiryDate
  });
}

/**
 * Renew an existing Graph subscription (extend its expiry).
 * @param {object} connection - PlatformConnection document
 */
async function renewSubscription(connection) {
  const subscriptionId = connection.platformData?.msSubscriptionId;
  if (!subscriptionId) {
    return createSubscription(connection);
  }

  const token = await _getAccessToken(connection);
  const expiryDate = new Date(Date.now() + SUBSCRIPTION_EXPIRY_DAYS * 24 * 60 * 60 * 1000);

  try {
    await axios.patch(
      `${GRAPH_BASE}/subscriptions/${subscriptionId}`,
      { expirationDateTime: expiryDate.toISOString() },
      { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    // Subscription may have expired beyond the grace period — recreate it
    if (err.response?.status === 404) {
      return createSubscription(connection);
    }
    const subErr = new Error(`Graph subscription renewal failed: ${err.message}`);
    subErr.code = 'OUTLOOK_SUBSCRIPTION_FAILED';
    throw subErr;
  }

  await PlatformConnection.findByIdAndUpdate(connection._id, {
    'platformData.msSubscriptionExpiry': expiryDate
  });

  logger.info('[outlookService] Graph subscription renewed', {
    connectionId: connection._id,
    subscriptionId
  });
}

/**
 * Delete a Graph subscription (called on disconnect).
 * @param {object} connection
 */
async function deleteSubscription(connection) {
  const subscriptionId = connection.platformData?.msSubscriptionId;
  if (!subscriptionId) return;

  try {
    const token = await _getAccessToken(connection);
    await axios.delete(`${GRAPH_BASE}/subscriptions/${subscriptionId}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    logger.info('[outlookService] Graph subscription deleted', { subscriptionId });
  } catch (err) {
    logger.warn('[outlookService] failed to delete Graph subscription', {
      subscriptionId,
      error: err.message
    });
  }
}

// ── Message Fetch ─────────────────────────────────────────────────────────────

/**
 * Fetch and parse a single Outlook message.
 * @param {object} connection  - PlatformConnection lean doc
 * @param {string} messageId   - Graph message ID
 * @returns {Promise<object>}  - structured message (same shape as gmailService.getMessage)
 */
async function fetchMessage(connection, messageId) {
  const token = await _getAccessToken(connection);

  let res;
  try {
    res = await axios.get(`${GRAPH_BASE}/me/messages/${messageId}`, {
      headers: { Authorization: `Bearer ${token}` },
      params: {
        $select: 'id,subject,from,toRecipients,ccRecipients,body,bodyPreview,receivedDateTime,conversationId,internetMessageId,inReplyTo,internetMessageHeaders,hasAttachments'
      }
    });
  } catch (err) {
    const fetchErr = new Error(`Graph message fetch failed: ${err.message}`);
    fetchErr.code = err.response?.status === 401 ? 'OUTLOOK_AUTH_FAILED' : 'OUTLOOK_FETCH_FAILED';
    fetchErr.messageId = messageId;
    throw fetchErr;
  }

  return _parseOutlookMessage(res.data, messageId);
}

function _parseOutlookMessage(msg, rawMessageId) {
  const headers = (msg.internetMessageHeaders || []).reduce((map, h) => {
    map[h.name.toLowerCase()] = h.value;
    return map;
  }, {});

  const inReplyTo = msg.inReplyTo || headers['in-reply-to'] || null;
  const referencesRaw = headers['references'] || '';
  const references = referencesRaw.trim().split(/\s+/).filter(Boolean);

  const htmlBody = msg.body?.contentType === 'html' ? msg.body.content : null;
  const textBody = msg.body?.contentType === 'text' ? msg.body.content : null;

  const contentText = textBody
    ? (textBody.length > 500 ? textBody.substring(0, 500) + '…' : textBody)
    : (msg.bodyPreview || msg.subject || '');

  return {
    messageId: msg.internetMessageId || `<outlook-${msg.id}>`,
    outlookId: msg.id,
    conversationId: msg.conversationId,
    inReplyTo,
    references,
    subject: msg.subject || '(no subject)',
    from: {
      name: msg.from?.emailAddress?.name || '',
      address: msg.from?.emailAddress?.address || ''
    },
    to: (msg.toRecipients || []).map(r => ({
      name: r.emailAddress?.name || '',
      address: r.emailAddress?.address || ''
    })),
    cc: (msg.ccRecipients || []).map(r => ({
      name: r.emailAddress?.name || '',
      address: r.emailAddress?.address || ''
    })),
    date: msg.receivedDateTime ? new Date(msg.receivedDateTime) : new Date(),
    snippet: msg.bodyPreview || '',
    htmlBody,
    textBody,
    contentText,
    hasAttachments: msg.hasAttachments || false,
    attachments: [],  // fetched separately via downloadAttachment if needed
    outlookRawId: rawMessageId
  };
}

// ── Attachment Download ───────────────────────────────────────────────────────

/**
 * Download a single Outlook attachment by ID.
 * @param {object} connection
 * @param {string} attachmentId  - Graph attachment ID
 * @param {string} [messageId]   - Graph message ID (for the API path)
 * @returns {Promise<Buffer>}
 */
async function downloadAttachment(connection, attachmentId, messageId) {
  const token = await _getAccessToken(connection);
  const res = await axios.get(
    `${GRAPH_BASE}/me/messages/${messageId}/attachments/${attachmentId}/$value`,
    { headers: { Authorization: `Bearer ${token}` }, responseType: 'arraybuffer' }
  );
  return Buffer.from(res.data);
}

// ── Send Reply ────────────────────────────────────────────────────────────────

/**
 * Send an email reply via Microsoft Graph.
 *
 * @param {object} connection
 * @param {object} opts
 * @param {string}   opts.to
 * @param {string}   [opts.toName]
 * @param {string}   opts.subject
 * @param {string}   opts.bodyHtml
 * @param {string}   opts.bodyText
 * @param {string}   [opts.inReplyTo]
 * @param {string}   [opts.conversationId]
 * @returns {Promise<{ messageId: string }>}
 */
async function sendReply(connection, opts) {
  const token = await _getAccessToken(connection);

  const message = {
    subject: opts.subject,
    body: {
      contentType: 'html',
      content: opts.bodyHtml || `<p>${opts.bodyText || ''}</p>`
    },
    toRecipients: [{
      emailAddress: {
        name: opts.toName || opts.to,
        address: opts.to
      }
    }]
  };

  let res;
  try {
    res = await axios.post(
      `${GRAPH_BASE}/me/sendMail`,
      { message, saveToSentItems: true },
      { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    const sendErr = new Error(`Graph sendMail failed: ${err.response?.data?.error?.message || err.message}`);
    sendErr.code = err.response?.status === 401 ? 'OUTLOOK_AUTH_FAILED' : 'OUTLOOK_SEND_FAILED';
    throw sendErr;
  }

  // Graph sendMail returns 202 with no body — use a synthetic messageId
  const sentMessageId = `<outlook-sent-${Date.now()}>`;
  logger.info('[outlookService] reply sent', { connectionId: connection._id, to: opts.to });
  return { messageId: sentMessageId };
}

module.exports = {
  getAuthUrl,
  exchangeCodeForTokens,
  createSubscription,
  renewSubscription,
  deleteSubscription,
  fetchMessage,
  downloadAttachment,
  sendReply
};
