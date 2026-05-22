/**
 * WhatsApp Webhook Service
 *
 * Single authoritative location for WhatsApp inbound message persistence and
 * post-persistence side-effects (sentiment / socket emit / AI queue / mark-as-read).
 *
 * Implements the dm_<phoneNumberId>_<senderId> threading pattern so all messages
 * from the same customer collapse into one conversation.
 *
 * Architecture:
 *   webhookController.handleWhatsAppWebhook (signature verify + ACK)
 *           │
 *           ▼
 *   processWhatsAppWebhook(payload)   ← top-level orchestrator
 *           │
 *           ├─ for each message change → processIncomingMessage(change, connection, payload)
 *           └─ for each status change  → processStatusUpdate(status)
 *
 *   processIncomingMessage() calls:
 *           upsertWhatsAppThread() → DB kernel (also used by BullMQ worker)
 *
 * Exports:
 *   processWhatsAppWebhook(payload)          → Promise<void>   — top-level dispatcher
 *   processIncomingMessage(change, conn)     → Promise<void>   — per-message pipeline
 *   processStatusUpdate(status)              → Promise<void>   — delivery status
 *   upsertWhatsAppThread(params)             → Promise<{ interaction, mid, skipped }>
 *   handleWhatsAppMessage(payload, orgId)    → Promise<Interaction|null>  (queue / legacy)
 */

const Interaction = require('../../models/Interaction');
const PlatformConnection = require('../../models/PlatformConnection');
const { generateChatRef } = require('../../utils/chatRefHelper');
const { emitToOrg } = require('../../utils/socketEmitter');
const { resolveContact, normalizeAuthorForPlatform } = require('../contactService');
const logger = require('../../config/logger');

/**
 * Find or create a unified Contact for an inbound WhatsApp sender and link it
 * on the Interaction thread. Non-fatal — never blocks message delivery.
 */
async function _resolveAndLinkContact({ interaction, author, organizationId, rawContact = {} }) {
  if (!interaction?._id || !author?.platformId) return null;

  try {
    const contactPayload = normalizeAuthorForPlatform('whatsapp', author, rawContact);
    const contact = await resolveContact(contactPayload, organizationId);
    if (contact) {
      await Interaction.findByIdAndUpdate(interaction._id, { contact: contact._id });
      if (typeof interaction.set === 'function') {
        interaction.set('contact', contact._id);
      } else {
        interaction.contact = contact._id;
      }
    }
    return contact;
  } catch (err) {
    logger.warn('[WhatsApp] Contact resolution failed (non-fatal)', { error: err.message });
    return null;
  }
}

/**
 * Upsert a WhatsApp conversation thread and append one inbound message.
 *
 * This is the shared DB kernel. Callers (controller + job) supply the already-parsed
 * values; both paths may enrich them differently (e.g. the controller enriches with
 * mediaId / location from whatsappService.processWebhookMessage), but the upsert
 * pattern itself is identical.
 *
 * @param {object} params
 * @param {string}  params.phoneNumberId  - The connected phone number ID (business)
 * @param {string}  params.senderId       - Customer WhatsApp number
 * @param {string}  params.mid            - Message id (wamid) for deduplication
 * @param {string}  params.textContent    - Resolved text body of the message
 * @param {string}  params.messageType    - 'text' | 'image' | 'video' | etc.
 * @param {object}  params.mergedAuthor   - { platformId, name, username }
 * @param {Date}    params.platformCreatedAt
 * @param {string}  params.organizationId
 * @param {string}  [params.connectionId] - PlatformConnection._id (optional; stored for reply routing)
 * @param {object}  [params.extraSet]     - Additional $set fields (e.g. mediaId, location)
 * @param {object}  [params.msgExtra]     - Additional fields to push into incomingMessages entry
 *
 * @returns {Promise<{ interaction: Interaction|null, mid: string, skipped: boolean }>}
 */
async function upsertWhatsAppThread({
  phoneNumberId,
  senderId,
  mid,
  textContent,
  messageType,
  mergedAuthor,
  platformCreatedAt,
  organizationId,
  connectionId,
  extraSet = {},
  msgExtra = {}
}) {
  const threadPlatformId = `dm_${String(phoneNumberId)}_${String(senderId)}`;

  let waBusinessAvatarUrl = null;
  if (connectionId) {
    const conn = await PlatformConnection.findById(connectionId)
      .select('platformProfilePicture metadata.profilePicture platformData.businessProfile')
      .lean();
    waBusinessAvatarUrl =
      conn?.platformProfilePicture ||
      conn?.metadata?.profilePicture ||
      conn?.platformData?.businessProfile?.profile_picture_url ||
      null;
  }

  // platformId is unique PER ORG, not globally. All queries must scope by organizationId
  // so two tenants sharing the same WhatsApp Business number cannot collide.
  const existing = await Interaction
    .findOne({ platformId: threadPlatformId, organization: organizationId })
    .select('_id metadata.lastMid author chatRef')
    .lean();

  // Idempotency: Meta can retry the same webhook — skip if mid is already recorded
  if (existing && existing.metadata?.lastMid === mid) {
    logger.debug('[whatsappWebhookService] Duplicate mid (webhook retry) — skipped', { threadPlatformId, mid });
    return { interaction: null, mid, skipped: true };
  }

  let chatRefData = null;
  if (!existing || !existing.chatRef) {
    chatRefData = await generateChatRef(organizationId).catch(() => ({ chatNumber: null, chatRef: null }));
  }

  const set = {
    organization: organizationId,
    platform: 'whatsapp',
    type: 'dm',
    platformId: threadPlatformId,
    threadId: String(senderId),
    content: textContent,
    author: mergedAuthor,
    platformCreatedAt,
    status: 'unread',
    isRead: false,
    'metadata.lastMid': mid,
    'metadata.phoneNumberId': String(phoneNumberId),
    ...(waBusinessAvatarUrl ? { 'metadata.whatsappBusinessAvatarUrl': waBusinessAvatarUrl } : {}),
    ...extraSet
  };

  if (connectionId) set.platformConnection = connectionId;

  const setOnInsert = { source: 'webhook' };

  // chatRef: backfill into $set for existing threads without one; $setOnInsert for new ones
  if (existing && !existing.chatRef && chatRefData?.chatRef) {
    set.chatNumber = chatRefData.chatNumber;
    set.chatRef = chatRefData.chatRef;
  } else if (!existing && chatRefData?.chatRef) {
    setOnInsert.chatNumber = chatRefData.chatNumber;
    setOnInsert.chatRef = chatRefData.chatRef;
  }

  // Step 1: Upsert the thread document (compound unique on { organization, platformId })
  await Interaction.findOneAndUpdate(
    { platformId: threadPlatformId, organization: organizationId },
    { $set: set, $setOnInsert: setOnInsert },
    { upsert: true }
  );

  // Step 2: Append message to list, guarding against duplicate mids from webhook retries
  const incomingMsg = {
    mid,
    text: textContent,
    timestamp: platformCreatedAt,
    type: messageType,
    ...msgExtra
  };

  await Interaction.updateOne(
    {
      platformId: threadPlatformId,
      organization: organizationId,
      'metadata.incomingMessages.mid': { $ne: mid }
    },
    {
      $push: {
        'metadata.incomingMessages': {
          $each: [incomingMsg],
          $slice: -100
        }
      }
    }
  );

  const interaction = await Interaction.findOne({
    platformId: threadPlatformId,
    organization: organizationId
  });
  return { interaction, mid, skipped: false };
}

/**
 * Handle a raw WhatsApp webhook payload (queue / legacy path).
 *
 * Parses the Meta payload format and calls upsertWhatsAppThread for DB persistence.
 * Extra work (sentiment, socket, AI queue, markAsRead) is done by the outer processWebhook
 * job or the webhookController — not here.
 *
 * @param {object} payload       - Raw Meta webhook POST body
 * @param {string} organizationId
 * @returns {Promise<Interaction|null>}
 */
async function handleWhatsAppMessage(payload, organizationId) {
  try {
    const entry = payload.entry?.[0];
    if (!entry) return null;

    for (const change of entry.changes || []) {
      const value = change.value || {};
      if (!value.messages || value.messages.length === 0) continue;

      const message = value.messages[0];
      const phoneNumberId = value.metadata?.phone_number_id;
      const senderId = String(message.from);
      const mid = message.id;
      const textContent = message.text?.body || message.body || '';

      const mergedAuthor = {
        platformId: senderId,
        name: value.contacts?.[0]?.profile?.name || senderId,
        username: value.contacts?.[0]?.wa_id || senderId
      };

      const platformCreatedAt = new Date(parseInt(message.timestamp) * 1000);

      const { interaction, skipped } = await upsertWhatsAppThread({
        phoneNumberId,
        senderId,
        mid,
        textContent,
        messageType: message.type || 'text',
        mergedAuthor,
        platformCreatedAt,
        organizationId
      });

      if (skipped) return null;

      await _resolveAndLinkContact({
        interaction,
        author: mergedAuthor,
        organizationId,
        rawContact: value.contacts?.[0] || {}
      });

      return interaction;
    }

    return null;
  } catch (error) {
    logger.error('[whatsappWebhookService] handleWhatsAppMessage error', { error: error.message });
    throw error;
  }
}

// ─── Orchestrators (controller entrypoint) ──────────────────────────────────

/**
 * Top-level processor for a WhatsApp webhook payload.
 *
 * Assumes the caller (controller) has already:
 *   1. verified the x-hub-signature-256 signature,
 *   2. sent the 200 ACK to Meta,
 *   3. confirmed req.body.object === 'whatsapp_business_account'.
 *
 * Iterates every entry/change, dispatches to processIncomingMessage or
 * processStatusUpdate. Errors for a single change are logged but do not
 * prevent sibling changes from being processed.
 *
 * @param {object} payload  The raw req.body
 * @returns {Promise<void>}
 */
async function processWhatsAppWebhook(payload) {
  if (!payload?.entry || payload.entry.length === 0) {
    logger.info('[WhatsApp Webhook] No entries to process');
    return;
  }

  logger.info(`[WhatsApp Webhook] Processing ${payload.entry.length} entry/entries`);

  for (const entry of payload.entry) {
    if (!entry.changes || entry.changes.length === 0) continue;

    for (const change of entry.changes) {
      if (change.field !== 'messages') {
        logger.debug('[WhatsApp Webhook] Skipping change (handler only processes field=messages)', {
          field: change.field
        });
        continue;
      }

      const value = change.value || {};

      // Incoming message path
      if (value.messages && value.messages.length > 0) {
        const phoneNumberId = value.metadata?.phone_number_id;
        if (!phoneNumberId) {
          logger.warn('[WhatsApp Webhook] Message change missing phone_number_id', { value });
        } else {
          const connection = await _lookupWhatsAppConnection(phoneNumberId);
          if (connection) {
            try {
              await processIncomingMessage(change, connection, payload);
            } catch (msgErr) {
              logger.error('[WhatsApp Webhook] processIncomingMessage failed', {
                error: msgErr.message,
                stack: msgErr.stack
              });
            }
          }
        }
      }

      // Delivery-status path — always evaluated so statuses are never skipped
      // even when messages and statuses arrive in the same change object
      if (value.statuses && value.statuses.length > 0) {
        for (const status of value.statuses) {
          try {
            await processStatusUpdate(status);
          } catch (statusErr) {
            logger.error('[WhatsApp Webhook] processStatusUpdate failed', {
              error: statusErr.message
            });
          }
        }
      }
    }
  }
}

/**
 * Find the active WhatsApp platform connection for a given phone_number_id.
 * Logs a diagnostic snapshot of all WhatsApp connections when no match is found.
 *
 * Exported internally only for test visibility; stable API is processWhatsAppWebhook.
 */
async function _lookupWhatsAppConnection(phoneNumberId) {
  if (phoneNumberId == null || phoneNumberId === '') {
    logger.warn('[WhatsApp Webhook] lookup called with empty phone_number_id');
    return null;
  }

  const pid = String(phoneNumberId).trim();

  const connection = await PlatformConnection.findOne({
    platform: 'whatsapp',
    isActive: true,
    $or: [{ 'platformData.phoneNumberId': pid }, { platformUserId: pid }]
  }).populate('organization');

  if (connection) {
    logger.info('[WhatsApp Webhook] Matched connection', {
      phoneNumberId: pid,
      verifiedName: connection.platformData?.verifiedName
    });
    return connection;
  }

  logger.warn('[WhatsApp Webhook] No active connection found for phone_number_id', {
    phoneNumberId: pid,
    hint: 'DB should set platformData.phoneNumberId or platformUserId (same as Meta phone number id) from Embedded Signup.'
  });

  // Diagnostic snapshot — helps when multiple tenants share the same business number
  // and someone's toggled isActive off. Kept at debug so it doesn't spam production.
  try {
    const all = await PlatformConnection.find({ platform: 'whatsapp' })
      .select('_id isActive platformData.phoneNumberId')
      .lean();
    logger.debug('[WhatsApp Webhook] WhatsApp connections in DB', {
      total: all.length,
      sample: all.slice(0, 5).map((c) => ({
        id: String(c._id),
        phoneNumberId: c.platformData?.phoneNumberId,
        isActive: c.isActive
      }))
    });
  } catch (e) {
    logger.debug('[WhatsApp Webhook] Diagnostic snapshot failed', { error: e.message });
  }

  return null;
}

/**
 * Full per-message pipeline (post-ACK):
 *   1. Parse via whatsappService.processWebhookMessage (media/location enrichment)
 *   2. Merge author from previous thread doc
 *   3. Upsert thread + push message (via upsertWhatsAppThread)
 *   4. Atomic sentiment $set (avoids VersionError with racing AI worker)
 *   5. markAsRead (best effort)
 *   6. Socket emit to org (best effort)
 *   7. Enqueue AI job + immediate auto-reply (best effort)
 *
 * Every side-effect is try/catch'd so one failure doesn't poison the rest.
 *
 * @param {object} change      webhook change node ({ field, value })
 * @param {object} connection  populated PlatformConnection (with organization)
 * @param {object} rawPayload  the full req.body (needed by whatsappService.processWebhookMessage)
 */
async function processIncomingMessage(change, connection, rawPayload) {
  const whatsappService = require('../../integrations/whatsapp/whatsappService');
  const aiService = require('../aiService');
  const autoReplyScheduler = require('../autoReplyScheduler');
  const { aiQueue } = require('../../config/queue');

  const value = change.value;
  const phoneNumberId = value.metadata.phone_number_id;
  const organizationId = connection.organization._id.toString();

  const parsed = await whatsappService.processWebhookMessage(rawPayload);
  if (!parsed?.success || parsed.skipped) return;

  const md = parsed.messageData;
  const senderId = String(md.from);
  const mid = md.platformId;

  // Merge author with whatever was previously stored so names don't downgrade
  // to the raw phone number once we've learned a real name.
  const prevAuthor = (
    await Interaction.findOne({
      platformId: `dm_${String(phoneNumberId)}_${senderId}`,
      organization: connection.organization._id
    })
      .select('author')
      .lean()
  )?.author || {};
  const mergedAuthor = {
    platformId: senderId,
    name: md.contact?.name || prevAuthor.name || senderId,
    username: md.contact?.wa_id || prevAuthor.username || senderId
  };

  const extraSet = { contentType: md.mediaType || 'text' };
  if (md.mediaId) {
    extraSet['metadata.mediaId'] = md.mediaId;
    extraSet['metadata.mediaType'] = md.mediaType;
    extraSet['metadata.hasMedia'] = true;
  }
  if (md.location) {
    extraSet['metadata.location'] = md.location;
  }

  const msgExtra = {};
  if (md.mediaId) {
    msgExtra.mediaId = md.mediaId;
    const rawType = md.mediaType || 'file';
    msgExtra.attachmentType =
      rawType === 'document' ? 'file' : rawType === 'sticker' ? 'image' : rawType;
  }

  const { interaction: savedInteraction, skipped } = await upsertWhatsAppThread({
    phoneNumberId,
    senderId,
    mid,
    textContent: md.content,
    messageType: md.type || 'text',
    mergedAuthor,
    platformCreatedAt: md.timestamp,
    organizationId,
    connectionId: connection._id,
    extraSet,
    msgExtra
  });

  if (skipped) {
    logger.info('[WhatsApp] Duplicate webhook (same mid) — skipped', { mid });
    return;
  }
  if (!savedInteraction) {
    logger.error('[WhatsApp] Thread upsert succeeded but document not found after fetch');
    return;
  }

  logger.info('[WhatsApp] Thread updated', {
    interactionId: String(savedInteraction._id),
    phoneNumberId,
    senderId
  });

  // Resolve unified Contact (phone → contacts list) — same as other webhook platforms.
  await _resolveAndLinkContact({
    interaction: savedInteraction,
    author: mergedAuthor,
    organizationId,
    rawContact: md.contact || value.contacts?.[0] || {}
  });

  // Track campaign recipient reply (most recent send to this number)
  try {
    const campaignService = require('../campaignService');
    await campaignService.markRecipientReplied({
      orgId: organizationId,
      phone: senderId
    });
  } catch (replyTrackErr) {
    logger.debug('[WhatsApp] Campaign reply tracking skipped', { error: replyTrackErr.message });
  }

  // ── Sentiment (atomic $set — avoids VersionError with AI worker races) ──
  if (savedInteraction.content) {
    try {
      const sentimentResult = aiService.fallbackSentimentAnalysis(savedInteraction.content);
      await Interaction.updateOne(
        { _id: savedInteraction._id },
        {
          $set: {
            sentiment: sentimentResult.sentiment,
            sentimentScore: sentimentResult.sentimentScore,
            sentimentConfidence: sentimentResult.sentimentConfidence
          }
        }
      );
      logger.info('[WhatsApp] Sentiment analyzed', {
        sentiment: sentimentResult.sentiment,
        interactionId: String(savedInteraction._id)
      });
    } catch (sentError) {
      logger.error('[WhatsApp] Sentiment analysis failed', { error: sentError.message });
    }
  }

  // ── Mark as read ────────────────────────────────────────────────────────
  try {
    await whatsappService.markAsRead(connection, mid);
  } catch (readError) {
    logger.error('[WhatsApp] Failed to mark as read', { error: readError.message });
  }

  // ── Socket emit ─────────────────────────────────────────────────────────
  try {
    emitToOrg(organizationId, 'new_interaction', {
      interaction: savedInteraction.toObject()
    });
  } catch (socketErr) {
    logger.error('[WhatsApp] Socket emit failed', { error: socketErr.message });
  }

  // ── AI pipeline + auto-reply queue (respects triggerMode/platforms/types) ──
  try {
    await aiQueue.add(
      { interactionId: savedInteraction._id },
      {
        attempts: 3,
        backoff: 2000,
        jobId: `ai-${savedInteraction._id}-${mid}`
      }
    );
    const queued = await autoReplyScheduler.queueImmediateAutoReply(
      savedInteraction._id.toString(),
      organizationId
    );
    if (queued) {
      logger.info('[WhatsApp] AI + auto-reply queued', {
        interactionId: String(savedInteraction._id)
      });
    }
  } catch (queueError) {
    logger.error('[WhatsApp] Failed to queue AI/auto-reply', { error: queueError.message });
  }
}

/**
 * Persist WhatsApp delivery-status update (sent / delivered / read / failed).
 *
 * Because Meta's status events don't carry organizationId, we match by the
 * platform-level `platformId` (wamid). Even though `platformId` is now
 * scoped by org for deduplication, it remains globally unique within WhatsApp
 * because wamids are generated by Meta — so a single-key match is safe here.
 *
 * @param {object} status  { id, status, timestamp }
 */
async function processStatusUpdate(status) {
  if (!status?.id) return;
  logger.info('[WhatsApp] Status update', { id: status.id, status: status.status });

  const campaignService = require('../campaignService');
  const errorDetail =
    status.errors?.[0]?.title ||
    status.errors?.[0]?.message ||
    status.errors?.[0]?.error_data?.details ||
    null;

  await campaignService.applyRecipientDeliveryStatus(
    status.id,
    status.status,
    status.timestamp,
    errorDetail
  );

  if (status.status === 'failed') {
    // Drop failed campaign deliveries from inbox — only successfully sent messages belong there.
    await Interaction.updateOne(
      {
        platform: 'whatsapp',
        'replies.platformResponseId': status.id,
        'replies.whatsappTemplatePreview.campaignId': { $exists: true, $ne: null }
      },
      { $pull: { replies: { platformResponseId: status.id } } }
    );
    return;
  }

  // Update delivery on outbound reply in thread (match by wamid on replies[])
  await Interaction.updateOne(
    { platform: 'whatsapp', 'replies.platformResponseId': status.id },
    {
      $set: {
        'replies.$.deliveryStatus': status.status,
        'replies.$.deliveryStatusAt': new Date(parseInt(status.timestamp, 10) * 1000)
      }
    }
  );
}

module.exports = {
  // Orchestrators (controller calls these)
  processWhatsAppWebhook,
  processIncomingMessage,
  processStatusUpdate,
  // DB kernel (used by both HTTP and BullMQ paths)
  upsertWhatsAppThread,
  // Queue / legacy path
  handleWhatsAppMessage
};
