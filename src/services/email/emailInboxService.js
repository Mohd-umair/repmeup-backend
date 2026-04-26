/**
 * Email Inbox Service
 *
 * Provider-agnostic layer that turns a parsed email message (from Gmail,
 * Outlook, or IMAP) into an Interaction document and emits the real-time
 * socket event so the inbox updates live.
 *
 * Architecture:
 *   emailAccountController / processEmailWebhook (job)
 *           │
 *           ▼
 *   upsertEmailThread(parsedMessage, connection)
 *           │
 *           ├─ findOrCreate Interaction (org + platformId unique)
 *           ├─ storeAttachments() — uploads to storageService
 *           └─ emitToOrg()       — real-time inbox update
 *
 * Threading strategy
 * ──────────────────
 * Each email thread is modelled as one Interaction.  The Gmail threadId /
 * Outlook conversationId / IMAP References chain is mapped to
 * Interaction.platformId = "email_<connectionId>_<threadKey>".
 *
 * Subsequent messages in the same thread are appended to
 * metadata.email.incomingMessages (same pattern as WhatsApp DMs).
 *
 * Exports:
 *   upsertEmailThread(parsedMessage, connection)   → Promise<{ interaction, skipped }>
 *   storeAttachments(attachments, connection)      → Promise<attachment[]>  (storageKeys filled)
 *   buildEmailPlatformId(connection, threadKey)    → string
 */

const Interaction = require('../../models/Interaction');
const { generateChatRef } = require('../../utils/chatRefHelper');
const { emitToOrg } = require('../../utils/socketEmitter');
const logger = require('../../config/logger');

// Max chars for Interaction.content (the "preview" text shown in inbox list)
const MAX_CONTENT_PREVIEW = 500;

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Build the stable platformId for an email thread.
 * Format: "email_<connectionId>_<threadKey>"
 * threadKey = gmailThreadId | msConversationId | IMAP References root
 */
function buildEmailPlatformId(connection, threadKey) {
  return `email_${String(connection._id)}_${threadKey}`;
}

/**
 * Derive a human-readable sender name from from-header.
 */
function _authorName(from) {
  if (!from) return 'Unknown';
  return from.name || from.address || 'Unknown';
}

// ── Attachment Storage ────────────────────────────────────────────────────────

/**
 * Upload attachment bytes to storageService and fill in storageKey.
 * Individual attachment failures are logged but do NOT abort the thread upsert.
 *
 * @param {Array}  attachments - array of attachment descriptors from gmailService / outlookService
 * @param {object} connection  - PlatformConnection lean doc
 * @returns {Promise<Array>}   - same array with storageKey filled where upload succeeded
 */
async function storeAttachments(attachments, connection) {
  if (!attachments || attachments.length === 0) return [];

  const storageService = require('../storageService');
  const stored = [];

  for (const att of attachments) {
    try {
      let buffer;

      // Gmail: fetch bytes via gmailService then upload
      if (att.gmailAttachmentId) {
        const gmailService = require('../../integrations/google/gmailService');
        buffer = await gmailService.downloadAttachment(
          connection,
          att.gmailMessageId,
          att.gmailAttachmentId
        );
      } else if (att.outlookAttachmentId) {
        const outlookService = require('../../integrations/microsoft/outlookService');
        buffer = await outlookService.downloadAttachment(connection, att.outlookAttachmentId);
      } else if (att.buffer) {
        // IMAP: buffer already in-memory
        buffer = att.buffer;
      }

      if (!buffer) {
        stored.push(att);
        continue;
      }

      const key = await storageService.uploadBuffer(buffer, {
        filename: att.filename,
        mimeType: att.mimeType,
        organizationId: String(connection.organization),
        folder: 'email-attachments'
      });

      stored.push({ ...att, storageKey: key, buffer: undefined });
    } catch (err) {
      logger.warn('[emailInboxService] attachment upload failed', {
        filename: att.filename,
        error: err.message,
        connectionId: connection._id
      });
      stored.push(att); // keep metadata even if upload failed
    }
  }

  return stored;
}

// ── Thread Upsert ─────────────────────────────────────────────────────────────

/**
 * Upsert an email thread.
 *
 * For a new email: creates the Interaction.
 * For a reply/continuation: appends to metadata.email.incomingMessages
 * (same pattern as WhatsApp DMs) so the agent sees a unified thread.
 *
 * @param {object} parsedMessage  - structured message from gmailService.getMessage()
 *                                  (or equivalent from outlookService / imapService)
 * @param {object} connection     - PlatformConnection lean doc
 * @returns {Promise<{ interaction: object, skipped: boolean }>}
 */
async function upsertEmailThread(parsedMessage, connection) {
  const organizationId = String(connection.organization);

  // Determine thread key:
  //  Gmail  → gmailThreadId
  //  Outlook → conversationId (set by outlookService parser)
  //  IMAP   → root Message-ID from References chain, or messageId itself
  const threadKey = parsedMessage.gmailThreadId
    || parsedMessage.conversationId
    || _resolveImapThreadKey(parsedMessage);

  const platformId = buildEmailPlatformId(connection, threadKey);

  // Skip messages sent BY the connected account (outbound)
  const connectedEmail = connection.platformData?.emailAddress?.toLowerCase();
  const senderEmail = parsedMessage.from?.address?.toLowerCase();
  if (connectedEmail && senderEmail === connectedEmail) {
    logger.debug('[emailInboxService] skipping outbound email', { platformId, senderEmail });
    return { interaction: null, skipped: true };
  }

  // Upload attachments (best-effort — failures do NOT block thread creation)
  const attachments = await storeAttachments(parsedMessage.attachments || [], connection);

  // Build the incoming-message entry (same sub-document pattern as WhatsApp)
  const incomingEntry = {
    mid: parsedMessage.messageId,
    text: parsedMessage.contentText || parsedMessage.snippet || '',
    timestamp: parsedMessage.date ? new Date(parsedMessage.date).getTime() : Date.now(),
    attachmentType: attachments.length ? 'file' : undefined,
    attachmentUrl: undefined  // email attachments are referenced by storageKey
  };

  // Build the email metadata sub-document
  const emailMeta = {
    subject: parsedMessage.subject || '(no subject)',
    from: parsedMessage.from || { name: '', address: '' },
    to: parsedMessage.to || [],
    cc: parsedMessage.cc || [],
    messageId: parsedMessage.messageId,
    inReplyTo: parsedMessage.inReplyTo || null,
    references: parsedMessage.references || [],
    htmlBody: parsedMessage.htmlBody || null,
    textBody: parsedMessage.textBody || null,
    hasAttachments: attachments.length > 0,
    attachments: attachments.map(a => ({
      filename: a.filename,
      mimeType: a.mimeType,
      size: a.size,
      storageKey: a.storageKey || null
    }))
  };

  // Content preview — used in inbox list
  const contentPreview = parsedMessage.contentText
    ? parsedMessage.contentText.substring(0, MAX_CONTENT_PREVIEW)
    : parsedMessage.subject || '(no content)';

  const author = {
    platformId: parsedMessage.from?.address || 'unknown',
    name: _authorName(parsedMessage.from),
    username: parsedMessage.from?.address || '',
    email: parsedMessage.from?.address || ''
  };

  // ── Try to find existing thread ───────────────────────────────────────────
  let interaction = await Interaction.findOne({
    organization: organizationId,
    platformId
  }).select('_id status metadata replies replyCount hasReplies').lean();

  if (interaction) {
    // Thread already exists — append incoming message to the history
    const alreadySeen = (interaction.metadata?.email?.references || [])
      .includes(parsedMessage.messageId);

    if (alreadySeen) {
      logger.debug('[emailInboxService] duplicate email message, skipping', {
        platformId,
        messageId: parsedMessage.messageId
      });
      return { interaction, skipped: true };
    }

    await Interaction.findByIdAndUpdate(interaction._id, {
      $set: {
        status: 'unread',
        isRead: false,
        content: contentPreview,
        'metadata.email.messageId': parsedMessage.messageId,
        'metadata.email.inReplyTo': parsedMessage.inReplyTo || null,
        'metadata.email.htmlBody': parsedMessage.htmlBody || null,
        'metadata.email.textBody': parsedMessage.textBody || null,
        'metadata.email.hasAttachments': attachments.length > 0
      },
      $addToSet: {
        'metadata.email.references': parsedMessage.messageId
      },
      $push: {
        'metadata.incomingMessages': {
          $each: [incomingEntry],
          $slice: -200  // keep last 200 messages in thread
        },
        'metadata.email.attachments': {
          $each: emailMeta.attachments.length ? emailMeta.attachments : []
        }
      }
    });

    const updated = await Interaction.findById(interaction._id).lean();
    _emitSocketUpdate(updated, organizationId);
    return { interaction: updated, skipped: false };
  }

  // ── Create new thread ─────────────────────────────────────────────────────
  const chatRef = await generateChatRef(organizationId);
  const newInteraction = new Interaction({
    organization: organizationId,
    platformConnection: connection._id,
    platform: 'email',
    type: 'email',
    platformId,
    content: contentPreview,
    contentType: parsedMessage.htmlBody ? 'html' : 'text',
    language: null,
    author,
    status: 'unread',
    isRead: false,
    chatRef,
    source: 'webhook',
    platformCreatedAt: parsedMessage.date || new Date(),
    metadata: {
      incomingMessages: [incomingEntry],
      lastMid: parsedMessage.messageId,
      email: {
        ...emailMeta,
        references: [parsedMessage.messageId]  // seed with this message
      }
    }
  });

  try {
    await newInteraction.save();
  } catch (err) {
    if (err.code === 11000) {
      // Race condition — duplicate platformId; just fetch and return
      logger.warn('[emailInboxService] duplicate key on email thread creation', { platformId });
      const existing = await Interaction.findOne({ organization: organizationId, platformId }).lean();
      return { interaction: existing, skipped: true };
    }
    throw err;
  }

  logger.info('[emailInboxService] new email thread created', {
    interactionId: newInteraction._id,
    platformId,
    from: parsedMessage.from?.address,
    subject: parsedMessage.subject
  });

  _emitSocketUpdate(newInteraction.toObject(), organizationId);
  return { interaction: newInteraction.toObject(), skipped: false };
}

// ── Socket Emit ───────────────────────────────────────────────────────────────

function _emitSocketUpdate(interaction, organizationId) {
  try {
    emitToOrg(organizationId, 'new_interaction', {
      interaction: {
        _id: interaction._id,
        platform: interaction.platform,
        type: interaction.type,
        status: interaction.status,
        content: interaction.content,
        author: interaction.author,
        platformId: interaction.platformId,
        metadata: { email: { subject: interaction.metadata?.email?.subject } },
        createdAt: interaction.createdAt
      }
    });
  } catch (err) {
    logger.warn('[emailInboxService] socket emit failed', { error: err.message });
  }
}

// ── IMAP Thread Key ───────────────────────────────────────────────────────────

/**
 * Determine a stable thread key from RFC 2822 References / In-Reply-To headers.
 * Falls back to the message's own messageId.
 */
function _resolveImapThreadKey(parsedMessage) {
  if (parsedMessage.references?.length) {
    return parsedMessage.references[0]; // root of the chain
  }
  if (parsedMessage.inReplyTo) {
    return parsedMessage.inReplyTo;
  }
  return parsedMessage.messageId || `unknown-${Date.now()}`;
}

module.exports = {
  upsertEmailThread,
  storeAttachments,
  buildEmailPlatformId
};
