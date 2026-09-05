/**
 * IMAP Service
 *
 * Generic IMAP / SMTP integration for connecting any email account that
 * supports standard protocols (Gmail App Passwords, Yahoo, Zoho, custom
 * domains, etc.).
 *
 * Uses:
 *   imapflow  — modern async IMAP client
 *   mailparser — parse raw MIME messages into structured objects
 *   nodemailer — already installed — used for SMTP send
 *
 * Credentials stored in PlatformConnection.accessToken are AES-256-GCM
 * encrypted (see emailAccountController._encrypt).  This service decrypts
 * them before use and never logs them.
 *
 * Error contract
 * ──────────────
 *   IMAP_AUTH_FAILED    - wrong credentials
 *   IMAP_CONNECT_FAILED - network / server unreachable
 *   IMAP_FETCH_FAILED   - error during UID fetch
 *   IMAP_SMTP_FAILED    - SMTP send error
 */

const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const nodemailer = require('nodemailer');
const crypto = require('crypto');
const PlatformConnection = require('../../models/PlatformConnection');
const logger = require('../../config/logger');

// Max messages to fetch per poll cycle (prevents RAM spikes)
const MAX_MESSAGES_PER_POLL = 50;

// ── Credential Decryption ─────────────────────────────────────────────────────

function _decrypt(encrypted) {
  if (!encrypted || !encrypted.includes(':')) return encrypted; // plain text fallback
  const [ivB64, tagB64, cipherB64] = encrypted.split(':');
  const key = _encryptionKey();
  const iv = Buffer.from(ivB64, 'base64');
  const tag = Buffer.from(tagB64, 'base64');
  const ciphertext = Buffer.from(cipherB64, 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf-8');
}

function _encryptionKey() {
  const raw = process.env.EMAIL_ENCRYPTION_KEY || process.env.JWT_SECRET || 'default-dev-key-32-chars-padding!!';
  return crypto.createHash('sha256').update(raw).digest();
}

// ── IMAP Client Factory ───────────────────────────────────────────────────────

function _buildImapClient(connection) {
  const password = _decrypt(connection.accessToken);
  const { imapHost, imapPort, imapSecure, emailAddress } = connection.platformData || {};

  return new ImapFlow({
    host: imapHost,
    port: imapPort || (imapSecure ? 993 : 143),
    secure: imapSecure !== false,
    auth: {
      user: emailAddress,
      pass: password
    },
    logger: false  // disable imapflow's default console logger
  });
}

// ── Test Connection ───────────────────────────────────────────────────────────

/**
 * Attempt a brief IMAP connection to validate credentials.
 * @param {object} config - { imapHost, imapPort, imapSecure, emailAddress, password }
 * @returns {Promise<{ success: boolean, error?: string }>}
 */
async function testConnection(config) {
  const client = new ImapFlow({
    host: config.imapHost,
    port: config.imapPort || (config.imapSecure ? 993 : 143),
    secure: config.imapSecure !== false,
    auth: {
      user: config.emailAddress,
      pass: config.password
    },
    logger: false,
    connectionTimeout: 10000
  });

  try {
    await client.connect();
    await client.logout();
    return { success: true };
  } catch (err) {
    logger.warn('[imapService] test connection failed', {
      host: config.imapHost,
      user: config.emailAddress,
      error: err.message
    });
    const isAuthError = err.message?.toLowerCase().includes('auth') ||
      err.message?.toLowerCase().includes('login');
    return {
      success: false,
      error: isAuthError ? 'Authentication failed — check your email and password' : err.message
    };
  }
}

// ── Fetch New Messages ────────────────────────────────────────────────────────

/**
 * Fetch messages received since the last polled UID.
 * Updates platformData.lastPolledUid after successful fetch.
 *
 * @param {object} connection - PlatformConnection lean doc
 * @returns {Promise<Array>}  - array of parsed message objects
 */
async function fetchNewMessages(connection) {
  const client = _buildImapClient(connection);
  const lastPolledUid = connection.platformData?.lastPolledUid || 0;

  try {
    await client.connect();
    await client.mailboxOpen('INBOX');

    // Search for messages with UID > lastPolledUid
    const searchResult = await client.search(
      lastPolledUid > 0
        ? { uid: `${lastPolledUid + 1}:*` }
        : { since: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) } // last 7 days on first run
    );

    if (!searchResult || searchResult.length === 0) {
      await client.logout();
      return [];
    }

    // Cap to avoid memory spikes
    const uids = searchResult.slice(0, MAX_MESSAGES_PER_POLL);
    let maxUid = lastPolledUid;
    const messages = [];

    for await (const msg of client.fetch(uids, { source: true }, { uid: true })) {
      try {
        const parsed = await simpleParser(msg.source);
        const structured = _parseMailparserMessage(parsed, msg.uid);
        messages.push(structured);
        if (msg.uid > maxUid) maxUid = msg.uid;
      } catch (parseErr) {
        logger.warn('[imapService] failed to parse message', {
          uid: msg.uid,
          error: parseErr.message
        });
      }
    }

    await client.logout();

    // Persist the new max UID so next poll only fetches newer messages
    if (maxUid > lastPolledUid) {
      await PlatformConnection.findByIdAndUpdate(connection._id, {
        'platformData.lastPolledUid': maxUid,
        lastSyncAt: new Date()
      });
    }

    return messages;
  } catch (err) {
    try { await client.logout(); } catch {}

    const isAuth = err.message?.toLowerCase().includes('auth') ||
      err.authenticationFailed ||
      err.message?.includes('[AUTHENTICATIONFAILED]');

    const imapErr = new Error(`IMAP fetch failed: ${err.message}`);
    imapErr.code = isAuth ? 'IMAP_AUTH_FAILED' : 'IMAP_FETCH_FAILED';
    throw imapErr;
  }
}

// ── Message Parser ────────────────────────────────────────────────────────────

function _parseMailparserMessage(parsed, uid) {
  const from = parsed.from?.value?.[0];
  const to = (parsed.to?.value || []).map(a => ({ name: a.name || '', address: a.address || '' }));
  const cc = (parsed.cc?.value || []).map(a => ({ name: a.name || '', address: a.address || '' }));

  const references = parsed.references
    ? (Array.isArray(parsed.references) ? parsed.references : [parsed.references])
    : [];

  const textBody = parsed.text || null;
  const htmlBody = parsed.html || null;
  const contentText = textBody
    ? (textBody.length > 500 ? textBody.substring(0, 500) + '…' : textBody)
    : (parsed.subject || '');

  const attachments = (parsed.attachments || [])
    .filter(a => a.contentDisposition === 'attachment')
    .map(a => ({
      filename: a.filename || 'attachment',
      mimeType: a.contentType || 'application/octet-stream',
      size: a.size || 0,
      buffer: a.content,  // Buffer — storeAttachments will upload this
      storageKey: null
    }));

  return {
    messageId: parsed.messageId || `<imap-uid-${uid}>`,
    imapUid: uid,
    inReplyTo: parsed.inReplyTo || null,
    references,
    subject: parsed.subject || '(no subject)',
    from: { name: from?.name || '', address: from?.address || '' },
    to,
    cc,
    date: parsed.date || new Date(),
    snippet: contentText.substring(0, 200),
    htmlBody,
    textBody,
    contentText,
    hasAttachments: attachments.length > 0,
    attachments
  };
}

// ── SMTP Send ─────────────────────────────────────────────────────────────────

/**
 * Send a reply via the connection's SMTP server.
 *
 * @param {object} connection  - PlatformConnection lean doc
 * @param {object} opts
 * @param {string}   opts.to
 * @param {string}   [opts.toName]
 * @param {string}   opts.subject
 * @param {string}   opts.bodyHtml
 * @param {string}   opts.bodyText
 * @param {string}   [opts.inReplyTo]
 * @param {string[]} [opts.references]
 * @returns {Promise<{ messageId: string }>}
 */
async function sendViaSMTP(connection, opts) {
  const password = _decrypt(connection.accessToken);
  const { smtpHost, smtpPort, smtpSecure, emailAddress } = connection.platformData || {};

  const transporter = nodemailer.createTransport({
    host: smtpHost,
    port: smtpPort || (smtpSecure ? 465 : 587),
    secure: smtpSecure !== false,
    auth: { user: emailAddress, pass: password }
  });

  const mailOptions = {
    from: `${connection.platformDisplayName || emailAddress} <${emailAddress}>`,
    to: opts.toName ? `${opts.toName} <${opts.to}>` : opts.to,
    subject: opts.subject,
    text: opts.bodyText || opts.bodyHtml?.replace(/<[^>]*>/g, '') || '',
    html: opts.bodyHtml || undefined
  };

  if (opts.inReplyTo) mailOptions.inReplyTo = opts.inReplyTo;
  if (opts.references?.length) mailOptions.references = opts.references.join(' ');

  try {
    const info = await transporter.sendMail(mailOptions);
    logger.info('[imapService] SMTP reply sent', {
      connectionId: connection._id,
      messageId: info.messageId
    });
    return { messageId: info.messageId };
  } catch (err) {
    const smtpErr = new Error(`SMTP send failed: ${err.message}`);
    smtpErr.code = 'IMAP_SMTP_FAILED';
    throw smtpErr;
  }
}

module.exports = {
  testConnection,
  fetchNewMessages,
  sendViaSMTP
};
