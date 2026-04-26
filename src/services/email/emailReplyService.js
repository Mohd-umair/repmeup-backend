/**
 * Email Reply Service
 *
 * Routes an outbound reply to the correct provider (Gmail, Outlook, IMAP/SMTP)
 * based on the PlatformConnection's platformData.emailProvider.
 *
 * Called by replyService.js when interaction.platform === 'email'.
 *
 * Error contract
 * ──────────────
 * All functions throw a plain Error with a machine-readable `.code` property:
 *   EMAIL_CONNECTION_NOT_FOUND  - no active email connection for this interaction
 *   EMAIL_PROVIDER_UNSUPPORTED  - emailProvider not recognised
 *   GMAIL_SEND_FAILED           - Gmail API error
 *   OUTLOOK_SEND_FAILED         - Microsoft Graph error
 *   IMAP_SMTP_SEND_FAILED       - SMTP error for IMAP accounts
 *
 * Returns: { platformResponseId, status: 'sent'|'failed', errorMessage }
 */

const PlatformConnection = require('../../models/PlatformConnection');
const logger = require('../../config/logger');

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Send an email reply from the connected account.
 *
 * @param {object} interaction   - Mongoose Interaction doc (platform === 'email')
 * @param {string} replyText     - plain-text reply body
 * @param {string} [replyHtml]   - optional HTML body (falls back to <p>replyText</p>)
 * @returns {Promise<{ platformResponseId: string|null, status: string, errorMessage: string|null }>}
 */
async function sendEmailReply(interaction, replyText, replyHtml) {
  const connection = await _resolveConnection(interaction);
  if (!connection) {
    return {
      platformResponseId: null,
      status: 'failed',
      errorMessage: 'Email connection not found. Please reconnect your email account in Settings.'
    };
  }

  const provider = connection.platformData?.emailProvider;
  const emailMeta = interaction.metadata?.email || {};

  const replyOpts = {
    to: emailMeta.from?.address || interaction.author?.email || '',
    toName: emailMeta.from?.name || interaction.author?.name || '',
    subject: _buildReplySubject(emailMeta.subject),
    bodyText: replyText,
    bodyHtml: replyHtml || `<p>${_escapeHtml(replyText)}</p>`,
    inReplyTo: emailMeta.messageId || null,
    references: emailMeta.references || []
  };

  try {
    switch (provider) {
      case 'gmail':
        return await _sendViaGmail(connection, replyOpts, interaction);

      case 'outlook':
        return await _sendViaOutlook(connection, replyOpts, interaction);

      case 'imap':
        return await _sendViaSmtp(connection, replyOpts);

      default: {
        const err = new Error(`Email provider '${provider}' is not supported`);
        err.code = 'EMAIL_PROVIDER_UNSUPPORTED';
        return {
          platformResponseId: null,
          status: 'failed',
          errorMessage: err.message
        };
      }
    }
  } catch (err) {
    logger.error('[emailReplyService] send failed', {
      provider,
      interactionId: interaction._id,
      code: err.code,
      error: err.message
    });
    return {
      platformResponseId: null,
      status: 'failed',
      errorMessage: err.message || 'Failed to send email reply'
    };
  }
}

// ── Gmail ─────────────────────────────────────────────────────────────────────

async function _sendViaGmail(connection, opts, interaction) {
  const gmailService = require('../../integrations/google/gmailService');

  // Extract Gmail threadId from platformId: "email_<connId>_<gmailThreadId>"
  const parts = (interaction.platformId || '').split('_');
  const gmailThreadId = parts.length >= 3 ? parts.slice(2).join('_') : undefined;

  const result = await gmailService.sendReply(connection, {
    ...opts,
    threadId: gmailThreadId
  });

  return {
    platformResponseId: result.gmailId || result.messageId,
    status: 'sent',
    errorMessage: null
  };
}

// ── Outlook (Phase 2) ─────────────────────────────────────────────────────────

async function _sendViaOutlook(connection, opts, interaction) {
  const outlookService = require('../../integrations/microsoft/outlookService');

  const parts = (interaction.platformId || '').split('_');
  const conversationId = parts.length >= 3 ? parts.slice(2).join('_') : undefined;

  const result = await outlookService.sendReply(connection, {
    ...opts,
    conversationId
  });

  return {
    platformResponseId: result.messageId,
    status: 'sent',
    errorMessage: null
  };
}

// ── IMAP / SMTP (Phase 3) ─────────────────────────────────────────────────────

async function _sendViaSmtp(connection, opts) {
  const imapService = require('../../integrations/imap/imapService');
  const result = await imapService.sendViaSMTP(connection, opts);
  return {
    platformResponseId: result.messageId || null,
    status: 'sent',
    errorMessage: null
  };
}

// ── Connection Resolution ─────────────────────────────────────────────────────

async function _resolveConnection(interaction) {
  // Prefer the stored platformConnection
  if (interaction.platformConnection) {
    const conn = typeof interaction.platformConnection === 'object'
      ? interaction.platformConnection
      : await PlatformConnection.findById(interaction.platformConnection).lean();

    if (conn && conn.isActive && conn.status === 'connected') return conn;
  }

  // Fall back to any active email connection for this org
  return PlatformConnection.findOne({
    organization: interaction.organization,
    platform: 'email',
    isActive: true,
    status: 'connected'
  }).lean();
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function _buildReplySubject(originalSubject) {
  if (!originalSubject) return 'Re: (no subject)';
  if (originalSubject.toLowerCase().startsWith('re:')) return originalSubject;
  return `Re: ${originalSubject}`;
}

function _escapeHtml(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

module.exports = { sendEmailReply };
