/**
 * Gmail Service
 *
 * Wraps the Gmail REST API for:
 *  - Setting up / renewing Pub/Sub push notifications (watch)
 *  - Fetching new messages using history delta
 *  - Fetching and decoding a single message
 *  - Sending a reply via Gmail API (MIME-encoded)
 *
 * All functions accept a PlatformConnection document and use its stored
 * accessToken / refreshToken.  Token refresh is handled transparently via
 * the googleapis OAuth2 client.
 *
 * Error contract
 * ──────────────
 * All functions throw a plain Error with a machine-readable `.code` property
 * on recoverable failures (e.g. 'GMAIL_AUTH_FAILED', 'GMAIL_WATCH_FAILED').
 * Controllers / services catch and translate.
 */

const { google } = require('googleapis');
const { Buffer } = require('buffer');
const logger = require('../../config/logger');
const PlatformConnection = require('../../models/PlatformConnection');

// Gmail Pub/Sub topic — organisations push to this topic name.
// Override via env if you run separate topics per environment.
const GMAIL_PUBSUB_TOPIC = process.env.GMAIL_PUBSUB_TOPIC || 'projects/repmeup/topics/gmail-inbox';

// Watch expires every 7 days; we set expiry to 6 days 20 hours so the renewal
// cron (runs every 6 days) always catches connections before they lapse.
const WATCH_EXPIRY_MS = 6 * 24 * 60 * 60 * 1000 + 20 * 60 * 60 * 1000;

// ── OAuth2 Client Factory ─────────────────────────────────────────────────────

/**
 * Build an authenticated OAuth2 client from a PlatformConnection.
 * Automatically refreshes the access token if it is expired.
 *
 * @param {object} connection - PlatformConnection lean doc or Mongoose doc
 * @returns {google.auth.OAuth2}
 */
function _buildOAuth2Client(connection) {
  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );

  oauth2Client.setCredentials({
    access_token: connection.accessToken,
    refresh_token: connection.refreshToken,
    expiry_date: connection.tokenExpiry ? new Date(connection.tokenExpiry).getTime() : undefined
  });

  // Persist refreshed tokens back to the DB transparently
  oauth2Client.on('tokens', async (tokens) => {
    try {
      const update = {};
      if (tokens.access_token) update.accessToken = tokens.access_token;
      if (tokens.expiry_date) update.tokenExpiry = new Date(tokens.expiry_date);
      if (tokens.refresh_token) update.refreshToken = tokens.refresh_token;
      if (Object.keys(update).length) {
        await PlatformConnection.findByIdAndUpdate(connection._id, update);
        logger.debug('[gmailService] persisted refreshed OAuth tokens', { connectionId: connection._id });
      }
    } catch (err) {
      logger.error('[gmailService] failed to persist refreshed tokens', { error: err.message });
    }
  });

  return oauth2Client;
}

// ── Watch ─────────────────────────────────────────────────────────────────────

/**
 * Set up (or renew) a Gmail Pub/Sub watch for the connected inbox.
 * Stores the new historyId and watchExpiry on the PlatformConnection.
 *
 * @param {object} connection - PlatformConnection document (must have _id)
 * @returns {Promise<{ historyId: string, expiry: Date }>}
 */
async function watchInbox(connection) {
  const auth = _buildOAuth2Client(connection);
  const gmail = google.gmail({ version: 'v1', auth });

  let res;
  try {
    res = await gmail.users.watch({
      userId: 'me',
      requestBody: {
        topicName: GMAIL_PUBSUB_TOPIC,
        labelIds: ['INBOX']
      }
    });
  } catch (err) {
    const code = err?.response?.status;
    const gmailErr = new Error(`Gmail watch() failed: ${err.message}`);
    gmailErr.code = code === 401 ? 'GMAIL_AUTH_FAILED' : 'GMAIL_WATCH_FAILED';
    gmailErr.status = code;
    throw gmailErr;
  }

  const historyId = res.data.historyId;
  const expiry = new Date(Date.now() + WATCH_EXPIRY_MS);

  await PlatformConnection.findByIdAndUpdate(connection._id, {
    'platformData.watchHistoryId': historyId,
    'platformData.watchExpiry': expiry,
    status: 'connected',
    isActive: true
  });

  logger.info('[gmailService] watch set up', {
    connectionId: connection._id,
    historyId,
    expiry
  });

  return { historyId, expiry };
}

/**
 * Renew an existing Gmail watch (same as watchInbox — the API is idempotent).
 *
 * @param {string|object} connectionId - PlatformConnection _id or doc
 */
async function renewWatch(connectionId) {
  const connection = typeof connectionId === 'object'
    ? connectionId
    : await PlatformConnection.findById(connectionId).lean();

  if (!connection) {
    logger.warn('[gmailService] renewWatch: connection not found', { connectionId });
    return;
  }

  return watchInbox(connection);
}

// ── History Delta ─────────────────────────────────────────────────────────────

/**
 * Fetch message IDs added since the stored historyId.
 * Updates the stored historyId to the latest value after fetching.
 *
 * @param {object} connection - PlatformConnection lean doc
 * @param {string} [incomingHistoryId] - historyId from the Pub/Sub push (optional override)
 * @returns {Promise<string[]>} - array of Gmail message IDs
 */
async function fetchNewMessageIds(connection, incomingHistoryId) {
  const startHistoryId = incomingHistoryId || connection.platformData?.watchHistoryId;
  if (!startHistoryId) {
    logger.warn('[gmailService] no startHistoryId available — cannot fetch delta', {
      connectionId: connection._id
    });
    return [];
  }

  const auth = _buildOAuth2Client(connection);
  const gmail = google.gmail({ version: 'v1', auth });

  let allMessageIds = [];
  let pageToken;
  let latestHistoryId = startHistoryId;

  try {
    do {
      const res = await gmail.users.history.list({
        userId: 'me',
        startHistoryId,
        historyTypes: ['messageAdded'],
        labelId: 'INBOX',
        maxResults: 500,
        pageToken
      });

      if (res.data.historyId) latestHistoryId = res.data.historyId;
      pageToken = res.data.nextPageToken;

      const history = res.data.history || [];
      for (const record of history) {
        const added = record.messagesAdded || [];
        for (const { message } of added) {
          if (message?.id) allMessageIds.push(message.id);
        }
      }
    } while (pageToken);
  } catch (err) {
    const code = err?.response?.status;
    if (code === 404) {
      // historyId expired (> 30 days old) — reset watch from scratch
      logger.warn('[gmailService] historyId expired, resetting watch', { connectionId: connection._id });
      await watchInbox(connection);
      return [];
    }
    const gmailErr = new Error(`Gmail history.list failed: ${err.message}`);
    gmailErr.code = code === 401 ? 'GMAIL_AUTH_FAILED' : 'GMAIL_HISTORY_FAILED';
    throw gmailErr;
  }

  // Persist the new historyId so the next delta starts from here
  if (latestHistoryId !== startHistoryId) {
    await PlatformConnection.findByIdAndUpdate(connection._id, {
      'platformData.watchHistoryId': latestHistoryId
    });
  }

  // Deduplicate (Gmail may repeat IDs across history records)
  return [...new Set(allMessageIds)];
}

// ── Message Fetch & Parse ─────────────────────────────────────────────────────

/**
 * Fetch a single Gmail message and return a structured object.
 *
 * @param {object} connection - PlatformConnection lean doc
 * @param {string} messageId  - Gmail message ID
 * @returns {Promise<object>}  - structured message object
 */
async function getMessage(connection, messageId) {
  const auth = _buildOAuth2Client(connection);
  const gmail = google.gmail({ version: 'v1', auth });

  let res;
  try {
    res = await gmail.users.messages.get({
      userId: 'me',
      id: messageId,
      format: 'full'
    });
  } catch (err) {
    const code = err?.response?.status;
    const gmailErr = new Error(`Gmail messages.get failed: ${err.message}`);
    gmailErr.code = code === 401 ? 'GMAIL_AUTH_FAILED' : 'GMAIL_FETCH_FAILED';
    gmailErr.messageId = messageId;
    throw gmailErr;
  }

  return _parseGmailMessagePayload(res.data);
}

/**
 * Parse a Gmail message resource into a flat, provider-agnostic object
 * compatible with emailInboxService.upsertEmailThread().
 *
 * @param {object} msg - raw Gmail message resource
 * @returns {object}
 */
function _parseGmailMessagePayload(msg) {
  const headers = _headersToMap(msg.payload?.headers || []);

  const parsed = {
    messageId: headers['message-id'] || `<gmail-${msg.id}>`,
    gmailId: msg.id,
    gmailThreadId: msg.threadId,
    inReplyTo: headers['in-reply-to'] || null,
    references: _parseReferences(headers['references']),
    subject: headers['subject'] || '(no subject)',
    from: _parseEmailAddress(headers['from']),
    to: _parseEmailAddressList(headers['to']),
    cc: _parseEmailAddressList(headers['cc']),
    date: headers['date'] ? new Date(headers['date']) : new Date(),
    snippet: msg.snippet || '',
    labelIds: msg.labelIds || []
  };

  // Extract body parts
  const { htmlBody, textBody, attachments } = _extractBodyAndAttachments(msg.payload, msg.id);
  parsed.htmlBody = htmlBody;
  parsed.textBody = textBody;
  parsed.attachments = attachments;
  parsed.hasAttachments = attachments.length > 0;

  // Best text for Interaction.content (snippet if no plain text)
  parsed.contentText = textBody
    ? (textBody.length > 2000 ? textBody.substring(0, 2000) + '…' : textBody)
    : parsed.snippet;

  return parsed;
}

// ── Body & Attachment Extraction ──────────────────────────────────────────────

function _extractBodyAndAttachments(payload, messageId) {
  let htmlBody = null;
  let textBody = null;
  const attachments = [];

  function walk(part) {
    if (!part) return;
    const mime = part.mimeType || '';
    const body = part.body || {};

    if (mime === 'text/html' && body.data) {
      htmlBody = htmlBody || _decodeBase64(body.data);
    } else if (mime === 'text/plain' && body.data) {
      textBody = textBody || _decodeBase64(body.data);
    } else if (body.attachmentId) {
      attachments.push({
        filename: part.filename || 'attachment',
        mimeType: mime,
        size: body.size || 0,
        // attachmentId is used to fetch the actual bytes via gmail.users.messages.attachments.get
        gmailAttachmentId: body.attachmentId,
        gmailMessageId: messageId,
        storageKey: null  // filled after upload to storageService
      });
    }

    if (part.parts) {
      for (const child of part.parts) walk(child);
    }
  }

  walk(payload);
  return { htmlBody, textBody, attachments };
}

function _decodeBase64(data) {
  return Buffer.from(data, 'base64').toString('utf-8');
}

// ── Header Helpers ────────────────────────────────────────────────────────────

function _headersToMap(headers) {
  const map = {};
  for (const h of headers) {
    map[h.name.toLowerCase()] = h.value;
  }
  return map;
}

function _parseEmailAddress(raw) {
  if (!raw) return { name: '', address: '' };
  const match = raw.match(/^(.*?)\s*<([^>]+)>$/);
  if (match) return { name: match[1].trim().replace(/^"|"$/g, ''), address: match[2].trim() };
  return { name: '', address: raw.trim() };
}

function _parseEmailAddressList(raw) {
  if (!raw) return [];
  return raw.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/)
    .map(s => _parseEmailAddress(s.trim()))
    .filter(a => a.address);
}

function _parseReferences(raw) {
  if (!raw) return [];
  return raw.trim().split(/\s+/).filter(Boolean);
}

// ── Download Attachment ───────────────────────────────────────────────────────

/**
 * Download a Gmail attachment's raw bytes.
 *
 * @param {object} connection
 * @param {string} messageId       - Gmail message ID
 * @param {string} attachmentId    - Gmail attachment ID from getMessage()
 * @returns {Promise<Buffer>}
 */
async function downloadAttachment(connection, messageId, attachmentId) {
  const auth = _buildOAuth2Client(connection);
  const gmail = google.gmail({ version: 'v1', auth });

  const res = await gmail.users.messages.attachments.get({
    userId: 'me',
    messageId,
    id: attachmentId
  });

  return Buffer.from(res.data.data, 'base64');
}

// ── Send Reply ────────────────────────────────────────────────────────────────

/**
 * Send an email reply via Gmail API.
 *
 * @param {object} connection  - PlatformConnection lean doc
 * @param {object} opts
 * @param {string}   opts.to          - recipient email address
 * @param {string}   opts.toName      - recipient display name
 * @param {string}   opts.subject     - reply subject (caller should prefix "Re: ")
 * @param {string}   opts.bodyHtml    - HTML body of the reply
 * @param {string}   opts.bodyText    - plain-text body of the reply
 * @param {string}   [opts.inReplyTo] - Message-ID of the original email
 * @param {string[]} [opts.references]- References header chain
 * @param {string}   [opts.threadId]  - Gmail threadId to keep in thread
 * @returns {Promise<{ messageId: string, gmailId: string }>}
 */
async function sendReply(connection, opts) {
  const auth = _buildOAuth2Client(connection);
  const gmail = google.gmail({ version: 'v1', auth });

  const from = `${connection.platformData?.emailAddress || connection.platformDisplayName || ''} <${connection.platformData?.emailAddress}>`;
  const to = opts.toName ? `${opts.toName} <${opts.to}>` : opts.to;

  const referencesHeader = opts.references?.length
    ? `References: ${opts.references.join(' ')}\r\n`
    : '';
  const inReplyToHeader = opts.inReplyTo
    ? `In-Reply-To: ${opts.inReplyTo}\r\n`
    : '';

  const mime = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${opts.subject}`,
    `MIME-Version: 1.0`,
    `Content-Type: multipart/alternative; boundary="===boundary==="`,
    referencesHeader.trimEnd(),
    inReplyToHeader.trimEnd(),
    '',
    '--===boundary===',
    'Content-Type: text/plain; charset=utf-8',
    '',
    opts.bodyText || opts.bodyHtml?.replace(/<[^>]*>/g, '') || '',
    '--===boundary===',
    'Content-Type: text/html; charset=utf-8',
    '',
    opts.bodyHtml || `<p>${opts.bodyText || ''}</p>`,
    '--===boundary===--'
  ]
    .filter(l => l !== null && l !== undefined)
    .join('\r\n');

  const encoded = Buffer.from(mime).toString('base64url');

  let res;
  try {
    res = await gmail.users.messages.send({
      userId: 'me',
      requestBody: {
        raw: encoded,
        threadId: opts.threadId || undefined
      }
    });
  } catch (err) {
    const code = err?.response?.status;
    const gmailErr = new Error(`Gmail send failed: ${err.message}`);
    gmailErr.code = code === 401 ? 'GMAIL_AUTH_FAILED' : 'GMAIL_SEND_FAILED';
    throw gmailErr;
  }

  logger.info('[gmailService] reply sent', {
    connectionId: connection._id,
    gmailId: res.data.id,
    threadId: res.data.threadId
  });

  return {
    messageId: `<gmail-${res.data.id}>`,
    gmailId: res.data.id,
    gmailThreadId: res.data.threadId
  };
}

// ── OAuth URL Builder (used by emailAccountController) ───────────────────────

/**
 * Generate the Gmail OAuth consent URL.
 *
 * @param {string} state - opaque state string (org ID + CSRF token)
 * @returns {string}
 */
function getGmailAuthUrl(state) {
  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GMAIL_REDIRECT_URI || process.env.GOOGLE_REDIRECT_URI
  );

  return oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',        // force refresh_token on every consent
    scope: [
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/gmail.send',
      'https://www.googleapis.com/auth/gmail.modify',
      'https://www.googleapis.com/auth/userinfo.email',
      'https://www.googleapis.com/auth/userinfo.profile'
    ],
    state
  });
}

/**
 * Exchange an authorization code for tokens.
 *
 * @param {string} code  - code from OAuth callback query param
 * @returns {Promise<{ tokens: object, email: string, name: string }>}
 */
async function exchangeCodeForTokens(code) {
  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GMAIL_REDIRECT_URI || process.env.GOOGLE_REDIRECT_URI
  );

  const { tokens } = await oauth2Client.getToken(code);
  oauth2Client.setCredentials(tokens);

  const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
  const { data: userInfo } = await oauth2.userinfo.get();

  return {
    tokens,
    email: userInfo.email,
    name: userInfo.name || userInfo.email
  };
}

module.exports = {
  watchInbox,
  renewWatch,
  fetchNewMessageIds,
  getMessage,
  downloadAttachment,
  sendReply,
  getGmailAuthUrl,
  exchangeCodeForTokens,
  // Exposed for tests
  _parseGmailMessagePayload,
  _parseEmailAddress
};
