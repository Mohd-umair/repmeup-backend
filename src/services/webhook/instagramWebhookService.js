/**
 * Instagram Webhook Service
 *
 * Single authoritative location for all Instagram webhook message-handling logic.
 * Both webhookController.js and processWebhook.js delegate here so a bug fix or
 * improvement only needs to be made once.
 *
 * Exports:
 *   handleInstagramMessage(payload, organizationId) → Promise<Interaction|null>
 */

const Interaction = require('../../models/Interaction');
const PlatformConnection = require('../../models/PlatformConnection');
const instagramService = require('../../integrations/meta/instagramService');
const { emitToOrg } = require('../../utils/socketEmitter');
const { generateChatRef } = require('../../utils/chatRefHelper');
const { resetAutoReplyCountersForNewInbound } = require('../../utils/interactionThreadDm');
const {
  formatPostbackIncomingText,
  notifyLinkedCommentInboxRefresh,
  resolveDmThreadTarget,
  finalizeDmThreadForCtd
} = require('../inbox/commentDmThreadLinkService');
const logger = require('../../config/logger');

// ─── Private helpers ─────────────────────────────────────────────────────────

/**
 * Fetch Instagram commenter/DM author profile (username, name, avatar) for inbox display.
 * Webhook only sends sender.id; this resolves the human-readable profile via IG User Profile API.
 * For DMs, pass the accessToken of the IG connection that received the message (Meta requirement).
 * Returns { username, name, avatarUrl } — any field may be undefined when API is unavailable.
 */
async function fetchInstagramAuthorProfile(organizationId, igUserId, accessTokenFromConnection = null) {
  if (!igUserId) return {};
  let token = accessTokenFromConnection;
  if (!token) {
    try {
      const connection = await PlatformConnection.findOne({
        organization: organizationId,
        platform: 'instagram',
        status: 'connected',
        isActive: true
      }).sort({ updatedAt: -1 }).select('accessToken');
      token = connection?.accessToken;
    } catch (e) {
      logger.warn('[instagramWebhookService] fetchInstagramAuthorProfile: connection lookup failed', { error: e.message });
      return {};
    }
  }
  if (!token) return {};
  try {
    const profile = await instagramService._fetchInstagramUserProfile(token, igUserId);
    if (!profile) return {};
    return {
      username: profile.username || undefined,
      name: profile.name || profile.username || undefined,
      avatarUrl: profile.profile_pic || profile.profile_picture_url || undefined
    };
  } catch (e) {
    logger.warn('[instagramWebhookService] fetchInstagramAuthorProfile failed', { igUserId, error: e.message });
    return {};
  }
}

/**
 * Fetch only the avatar URL for a commenter/mention author (lightweight legacy helper).
 * @deprecated Use fetchInstagramAuthorProfile when you also need username/name.
 */
async function fetchInstagramAuthorAvatar(organizationId, igUserId) {
  if (!igUserId) return undefined;
  try {
    const connection = await PlatformConnection.findOne({
      organization: organizationId,
      platform: 'instagram',
      status: 'connected',
      isActive: true
    }).select('accessToken');
    if (!connection?.accessToken) return undefined;
    const profile = await instagramService._fetchInstagramUserProfile(connection.accessToken, igUserId);
    return profile?.profile_pic || profile?.profile_picture_url || undefined;
  } catch (_) {
    return undefined;
  }
}

/**
 * Attachment shapes Meta sends when a user shares IG content in DM.
 * Often delivered as is_echo with sender = professional account id and recipient = the customer
 * (same pattern as shared feed posts).
 *
 * Reels in particular use type `ig_reel` / `reel` — if we only allow `share` / `ig_post`,
 * those echoes are skipped and never reach the inbox.
 *
 * @see https://developers.facebook.com/docs/instagram-messaging/webhooks/
 */
function isInstagramUserSharedMediaEchoAttachment(att) {
  if (!att) return false;
  const t = String(att.type || '').toLowerCase();
  return (
    t === 'share' ||
    t === 'ig_post' ||
    t === 'ig_reel' ||
    t === 'reel' ||
    t === 'story' ||
    t === 'ig_story' ||
    !!(att.payload && att.payload.ig_post_media_id)
  );
}

/**
 * Meta sometimes delivers a user-shared IG post/reel/story in DM with is_echo:true, sender = IG business id.
 * We still want an inbox thread for the user who shared the content.
 */
function isInstagramSharePostEcho(event, message, igAccountId) {
  if (!message?.is_echo || !igAccountId) return false;
  if (String(event.sender?.id) !== String(igAccountId) || !event.recipient?.id) return false;
  const atts = message.attachments || [];
  return atts.some(isInstagramUserSharedMediaEchoAttachment);
}

/** Pick the best attachment field for shared IG post / reel / story / media in DMs. */
function buildInstagramDmAttachmentFields(message) {
  const atts = message.attachments || [];
  const lower = (t) => String(t || '').toLowerCase();

  const primary =
    atts.find((a) => a && (a.type === 'ig_post' || (a.payload && a.payload.ig_post_media_id))) ||
    atts.find((a) => a && ['ig_reel', 'reel'].includes(lower(a.type))) ||
    atts.find((a) => a && ['story', 'ig_story'].includes(lower(a.type))) ||
    atts.find((a) => a && a.type === 'share') ||
    atts[0];
  const p = primary?.payload || {};
  const igPostMediaId =
    p.ig_post_media_id ||
    p.reel_media_id ||
    p.reel_video_id ||
    p.ig_reel_media_id ||
    p.media_id ||
    null;
  const rawType = lower(primary?.type || '');
  const attachmentType =
    rawType === 'reel' ? 'ig_reel' : (primary?.type || (igPostMediaId ? 'share' : 'file'));
  return {
    attachmentType,
    attachmentUrl: p.url || p.attachment_url || p.preview_url || null,
    igPostMediaId,
    shareTitle: typeof p.title === 'string' ? p.title : null
  };
}

/** Placeholder line for thread `content` and incomingMessages when there is no caption text. */
function buildInstagramDmPlaceholderText(attachmentType, igPostMediaId) {
  const t = String(attachmentType || '').toLowerCase();
  if (t === 'ig_reel' || t === 'reel') return '[Shared Instagram reel]';
  if (t === 'story' || t === 'ig_story') return '[Shared Instagram story]';
  if (t === 'ig_post' || t === 'share') return '[Shared Instagram post]';
  if (igPostMediaId) return '[Shared Instagram post]';
  if (t === 'story_mention' || t === 'ig_story_mention') return '[Story mention]';
  if (attachmentType) return `[${attachmentType}]`;
  return '';
}

/**
 * Detect story reply or story @mention from Instagram Messaging webhook payload.
 * @returns {{ storyMediaId: string|null, triggerType: 'story_reply'|'story_mention'|null, replyText: string }}
 */
function extractStoryContext(message) {
  if (!message) {
    return { storyMediaId: null, triggerType: null, replyText: '' };
  }

  const replyText = (message.text || '').trim();
  const replyStoryId = message.reply_to?.story?.id;
  if (replyStoryId) {
    return {
      storyMediaId: String(replyStoryId),
      triggerType: 'story_reply',
      replyText
    };
  }

  const atts = message.attachments || [];
  for (const att of atts) {
    const t = String(att?.type || '').toLowerCase();
    if (t === 'story_mention' || t === 'ig_story_mention') {
      const p = att.payload || {};
      const storyId = p.story_media_id || p.media_id || p.id || null;
      if (storyId) {
        return {
          storyMediaId: String(storyId),
          triggerType: 'story_mention',
          replyText
        };
      }
    }
  }

  return { storyMediaId: null, triggerType: null, replyText };
}

async function lookupLinkedStoryProducts(organizationId, storyMediaId) {
  if (!storyMediaId) return { linkedProductCount: 0, linkedProductNames: [] };
  try {
    const Product = require('../../models/Product');
    const linked = await Product.find({
      organization: organizationId,
      isActive: true,
      $or: [
        { instagramStoryIds: String(storyMediaId) },
        { instagramPostIds: String(storyMediaId) }
      ]
    }).select('name').limit(20).lean();
    return {
      linkedProductCount: linked.length,
      linkedProductNames: linked.map(p => p.name).filter(Boolean)
    };
  } catch (err) {
    logger.warn('[instagramWebhookService] story linked product lookup failed', { error: err.message });
    return { linkedProductCount: 0, linkedProductNames: [] };
  }
}

/**
 * Persist a CTA postback tap on the Instagram DM thread so unified CTD inbox can merge it.
 */
async function persistInstagramPostbackToDmThread({
  event,
  organizationId,
  igAccountId,
  senderId,
  payload,
  title,
  platformConnectionId,
  dmReceiverConnection
}) {
  const { threadPlatformId, igAccountId: resolvedIgAccountId, sourceCommentInteractionId } =
    await resolveDmThreadTarget({
      organizationId,
      instagramUserId: senderId,
      webhookEntryId: igAccountId,
      connection: dmReceiverConnection,
      payload
    });

  const mid = event.postback?.mid
    || `postback_${event.timestamp || Date.now()}_${String(payload).slice(0, 48)}`;
  const text = formatPostbackIncomingText(title, payload);

  const existing = await Interaction
    .findOne({ platformId: threadPlatformId, organization: organizationId })
    .select('_id metadata.lastMid author chatRef metadata.sourceCommentInteractionId')
    .lean();

  if (existing?.metadata?.lastMid === mid) {
    logger.debug('[instagramWebhookService] Duplicate postback mid (webhook retry)', { threadPlatformId, mid });
    return Interaction.findOne({ platformId: threadPlatformId, organization: organizationId });
  }

  const profile = await fetchInstagramAuthorProfile(
    organizationId,
    String(senderId),
    dmReceiverConnection?.accessToken || null
  );

  const existingAuthor = existing?.author || {};
  const mergedAuthor = {
    platformId: String(senderId),
    username: profile.username || existingAuthor.username || undefined,
    name: profile.name || existingAuthor.name || profile.username || existingAuthor.username || 'Instagram User'
  };
  if (profile.avatarUrl) mergedAuthor.avatarUrl = profile.avatarUrl;
  else if (existingAuthor.avatarUrl) mergedAuthor.avatarUrl = existingAuthor.avatarUrl;

  let chatRefFields = {};
  if (!existing?.chatRef) {
    chatRefFields = await generateChatRef(organizationId).catch(() => ({ chatNumber: null, chatRef: null }));
  }

  const updateFields = {
    organization: organizationId,
    platform: 'instagram',
    type: 'dm',
    platformId: threadPlatformId,
    content: text,
    author: mergedAuthor,
    threadId: String(senderId),
    platformCreatedAt: new Date(event.timestamp || Date.now()),
    'metadata.lastMid': mid,
    'metadata.instagramAccountId': resolvedIgAccountId || igAccountId,
    // Store the raw postback payload so processWebhook can:
    //  1. Route the event as 'instagram.postback' (not 'instagram.dm')
    //  2. Detect commerce postbacks (SALES:*/PICK:*) and suppress AI — the
    //     sales conversation service already handled the response in handlePostback.
    'metadata.buttonPayload': payload,
    'metadata.postback': true,
    status: 'unread',
    isRead: false
  };
  if (platformConnectionId) updateFields.platformConnection = platformConnectionId;
  if (sourceCommentInteractionId) {
    updateFields['metadata.sourceCommentInteractionId'] = sourceCommentInteractionId;
    updateFields['metadata.isCommentShadowDm'] = true;
  }
  if (existing && !existing.chatRef && chatRefFields?.chatRef) {
    updateFields.chatNumber = chatRefFields.chatNumber;
    updateFields.chatRef = chatRefFields.chatRef;
  }

  const setOnInsertFields = (!existing && chatRefFields?.chatRef)
    ? { chatNumber: chatRefFields.chatNumber, chatRef: chatRefFields.chatRef, source: 'webhook' }
    : { source: 'webhook' };

  await Interaction.findOneAndUpdate(
    { platformId: threadPlatformId, organization: organizationId },
    { $set: updateFields, $setOnInsert: setOnInsertFields },
    { upsert: true }
  );

  const incomingMsg = {
    mid,
    text,
    timestamp: event.timestamp || Date.now(),
    type: 'postback'
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

  let interaction = await Interaction.findOne({
    platformId: threadPlatformId,
    organization: organizationId
  });

  if (interaction && organizationId) {
    interaction = await finalizeDmThreadForCtd({
      organizationId,
      dmInteraction: interaction,
      threadPlatformId,
      sourceCommentInteractionId,
      instagramUserId: senderId
    }) || interaction;
  }

  return interaction;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Handle an Instagram webhook payload for a given organization.
 *
 * Supports two payload formats:
 *  1. Instagram Messaging (DMs): entry[].messaging[] / entry[].standby[]
 *  2. Graph API changes: entry[].changes[] with field "comments", "mentions", or "messages"
 *
 * @param {object} payload       - Raw Meta webhook POST body
 * @param {string} organizationId
 * @returns {Promise<Interaction|null>}
 */
async function handleInstagramMessage(payload, organizationId) {
  try {
    const entry = payload.entry?.[0];
    if (!entry) {
      logger.warn('[instagramWebhookService] No entry in payload');
      return null;
    }

    // Resolve Instagram connection so we can set platformConnection on new DMs (needed for reply)
    const igAccountId = entry.id;
    let platformConnectionId = null;
    let dmReceiverConnection = null;

    if (igAccountId) {
      let conn = await PlatformConnection.findOne({
        organization: organizationId,
        platform: 'instagram',
        platformUserId: { $in: [String(igAccountId), igAccountId].filter(Boolean) },
        status: { $in: ['connected', 'available'] },
        isActive: true
      }).sort({ updatedAt: -1 }).select('_id accessToken platformUserId platformPageId platformData metadata platformUsername').lean();

      if (!conn) {
        conn = await PlatformConnection.findOne({
          organization: organizationId,
          platform: 'instagram',
          $or: [
            { platformPageId: { $in: [String(igAccountId), igAccountId].filter(Boolean) } },
            { 'platformData.businessAccountId': String(igAccountId) }
          ],
          status: { $in: ['connected', 'available'] },
          isActive: true
        }).sort({ updatedAt: -1 }).select('_id accessToken platformUserId platformPageId platformData metadata platformUsername').lean();
      }

      if (conn) {
        platformConnectionId = conn._id;
        dmReceiverConnection = conn;
      } else {
        logger.warn('[instagramWebhookService] No connection found', { igAccountId, organizationId });
      }
    }

    // ── Instagram Messaging DMs: entry.messaging[] and entry.standby[] ──────────
    const messaging = entry.messaging || [];
    const standby = entry.standby || [];
    const allMessageEvents = [...messaging, ...standby];

    if (allMessageEvents.length === 0) {
      const hasComments = !!(entry.changes?.some(c => c.field === 'comments'));
      const hasMentions = !!(entry.changes?.some(c => c.field === 'mentions'));
      logger.info('[instagramWebhookService] No DM/standby events — checking changes', {
        entryId: entry.id,
        hasComments,
        hasMentions
      });
    }

    for (const event of allMessageEvents) {
      // ── Postback events (CTA button taps) ─────────────────────────────
      // When a user taps a postback button on a Generic Template DM, Meta sends
      // an event shape with `postback` instead of `message`. We route it to the
      // sales conversation service which sends the appropriate canned reply.
      if (event.postback && !event.message) {
        const senderId = String(event.sender?.id || '');
        const payload = String(event.postback.payload || '');
        const title = String(event.postback.title || '');
        logger.info('[instagramWebhookService] Postback received', {
          senderId, payload, title
        });
        if (senderId && payload) {
          let postbackInteraction = null;
          if (igAccountId) {
            try {
              postbackInteraction = await persistInstagramPostbackToDmThread({
                event,
                organizationId,
                igAccountId,
                senderId,
                payload,
                title,
                platformConnectionId,
                dmReceiverConnection
              });
            } catch (persistErr) {
              logger.warn('[instagramWebhookService] postback persist error (non-fatal)', {
                error: persistErr.message
              });
            }
          }
          try {
            const salesConvSvc = require('../salesConversationService');
            await salesConvSvc.handlePostback({
              instagramUserId: senderId,
              organizationId,
              payload,
              title,
              platformConnectionId
            });
          } catch (pbErr) {
            logger.warn('[instagramWebhookService] handlePostback error (non-fatal)', { error: pbErr.message });
          }
          if (postbackInteraction) {
            return postbackInteraction;
          }
        }
        continue;
      }

      const message = event.message;
      if (!message) continue;
      if (message.is_deleted || message.is_unsupported) {
        logger.info('[instagramWebhookService] Skipping deleted/unsupported message');
        continue;
      }

      const sharePostEcho = isInstagramSharePostEcho(event, message, igAccountId);
      if (message.is_echo && !sharePostEcho) {
        logger.info('[instagramWebhookService] Skipping echo (not user-shared media)');
        continue;
      }

      const partnerId = sharePostEcho ? event.recipient?.id : event.sender?.id;
      const mid = message.mid;
      const storyContext = sharePostEcho
        ? { storyMediaId: null, triggerType: null, replyText: '' }
        : extractStoryContext(message);
      const { attachmentType, attachmentUrl, igPostMediaId, shareTitle } = buildInstagramDmAttachmentFields(message);
      const text =
        message.text ||
        shareTitle ||
        (storyContext.triggerType === 'story_mention' ? '[Story mention]' : null) ||
        (storyContext.triggerType === 'story_reply' && !message.text ? '[Story reply]' : null) ||
        buildInstagramDmPlaceholderText(attachmentType, igPostMediaId);

      if (!mid || !partnerId) {
        logger.warn('[instagramWebhookService] Message missing mid or partnerId', {
          hasMid: !!mid,
          hasPartnerId: !!partnerId,
          sharePostEcho
        });
        continue;
      }

      if (sharePostEcho) {
        logger.info('[instagramWebhookService] User-shared media echo routed to inbox', {
          partnerId: String(partnerId),
          attachmentType: attachmentType || undefined,
          igPostMediaId: igPostMediaId || undefined
        });
      }

      // Fetch username/name/profile_pic from IG User Profile API (webhook only sends ids)
      const profile = await fetchInstagramAuthorProfile(
        organizationId,
        String(partnerId),
        dmReceiverConnection?.accessToken || null
      );
      if (!profile.username && !profile.name && !profile.avatarUrl) {
        logger.debug('[instagramWebhookService] No profile for partnerId (expected without Advanced Access)', {
          partnerId: String(partnerId)
        });
      }

      const author = {
        platformId: String(partnerId),
        username: profile.username,
        name: profile.name || profile.username || 'Instagram User'
      };
      if (profile.avatarUrl) author.avatarUrl = profile.avatarUrl;

      const { threadPlatformId, igAccountId: resolvedIgAccountId, sourceCommentInteractionId } =
        await resolveDmThreadTarget({
          organizationId,
          instagramUserId: String(partnerId),
          webhookEntryId: igAccountId,
          connection: dmReceiverConnection
        });

      const existing = await Interaction
        .findOne({ platformId: threadPlatformId, organization: organizationId })
        .select('_id metadata.lastMid author chatRef')
        .lean();

      if (existing && existing.metadata?.lastMid === mid) {
        // Meta webhook retry — do not re-queue AI / auto-reply
        logger.debug('[instagramWebhookService] Duplicate mid (webhook retry)', { threadPlatformId, mid });
        return null;
      }

      const existingAuthor = existing?.author || {};
      const mergedAuthor = {
        platformId: String(partnerId),
        username: profile.username || existingAuthor.username || undefined,
        name: profile.name || existingAuthor.name || profile.username || existingAuthor.username || 'Instagram User'
      };
      if (profile.avatarUrl) mergedAuthor.avatarUrl = profile.avatarUrl;
      else if (existingAuthor.avatarUrl) mergedAuthor.avatarUrl = existingAuthor.avatarUrl;

      let _igDmChatRef = null;
      if (!existing || !existing.chatRef) {
        _igDmChatRef = await generateChatRef(organizationId).catch(() => ({ chatNumber: null, chatRef: null }));
      }

      const updateFields = {
        organization: organizationId,
        platform: 'instagram',
        type: 'dm',
        platformId: threadPlatformId,
        content: text,
        author: mergedAuthor,
        threadId: String(partnerId),
        platformCreatedAt: new Date(event.timestamp),
        'metadata.lastMid': mid,
        'metadata.instagramAccountId': resolvedIgAccountId || igAccountId,
        status: 'unread',
        isRead: false
      };
      if (platformConnectionId) updateFields.platformConnection = platformConnectionId;
      if (sourceCommentInteractionId) {
        updateFields['metadata.sourceCommentInteractionId'] = sourceCommentInteractionId;
        updateFields['metadata.isCommentShadowDm'] = true;
      }

      if (storyContext.storyMediaId && storyContext.triggerType) {
        const { linkedProductCount, linkedProductNames } = await lookupLinkedStoryProducts(
          organizationId,
          storyContext.storyMediaId
        );
        updateFields['metadata.isStoryEngagement'] = true;
        updateFields['metadata.storyMediaId'] = storyContext.storyMediaId;
        updateFields['metadata.storyTriggerType'] = storyContext.triggerType;
        updateFields['metadata.storyReplyText'] = storyContext.replyText;
        updateFields['metadata.postId'] = storyContext.storyMediaId;
        updateFields['metadata.linkedProductCount'] = linkedProductCount;
        updateFields['metadata.linkedProductNames'] = linkedProductNames;
      }

      // Backfill chatRef into $set for existing interactions that don't have it
      if (existing && !existing.chatRef && _igDmChatRef?.chatRef) {
        updateFields.chatNumber = _igDmChatRef.chatNumber;
        updateFields.chatRef = _igDmChatRef.chatRef;
      }

      const setOnInsertFields = (!existing && _igDmChatRef?.chatRef)
        ? { chatNumber: _igDmChatRef.chatNumber, chatRef: _igDmChatRef.chatRef, source: 'webhook' }
        : { source: 'webhook' };

      // Step 1: Upsert the thread (compound unique on { organization, platformId })
      await Interaction.findOneAndUpdate(
        { platformId: threadPlatformId, organization: organizationId },
        { $set: updateFields, $setOnInsert: setOnInsertFields },
        { upsert: true }
      );

      // Step 2: Append message only if this mid is not already stored (webhook retry guard)
      const incomingMsg = { mid, text, timestamp: event.timestamp };
      if (attachmentUrl) incomingMsg.attachmentUrl = attachmentUrl;
      if (attachmentType) incomingMsg.attachmentType = attachmentType;
      if (igPostMediaId) incomingMsg.igPostMediaId = igPostMediaId;
      if (storyContext.storyMediaId) {
        incomingMsg.storyMediaId = storyContext.storyMediaId;
        incomingMsg.storyTriggerType = storyContext.triggerType;
      }

      const pushResult = await Interaction.updateOne(
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

      // A genuinely new inbound DM (not a webhook retry) means the customer is
      // actively re-engaging. Reset the per-thread auto-reply hard-stop counters so a
      // long-lived conversation isn't permanently locked out of auto-reply once it has
      // crossed maxAutoReplies. The cap still protects against AI-to-AI loops, because
      // those have no inbound message between replies to trigger this reset.
      if (pushResult.modifiedCount > 0) {
        await resetAutoReplyCountersForNewInbound(Interaction, {
          platformId: threadPlatformId,
          organization: organizationId
        });
      }

      let interaction = await Interaction.findOne({
        platformId: threadPlatformId,
        organization: organizationId
      });

      if (interaction && sourceCommentInteractionId) {
        interaction = await finalizeDmThreadForCtd({
          organizationId,
          dmInteraction: interaction,
          threadPlatformId,
          sourceCommentInteractionId,
          instagramUserId: String(partnerId)
        }) || interaction;
      }

      // Emit real-time socket event so frontend inbox updates immediately
      if (interaction && organizationId) {
        emitToOrg(organizationId.toString(), 'new_interaction', {
          interaction: interaction.toObject()
        });
        await notifyLinkedCommentInboxRefresh(
          organizationId,
          interaction.toObject ? interaction.toObject() : interaction
        );
      }

      // ── Sales conversation: handle multi-turn DM funnel (non-blocking) ──
      if (interaction && !sharePostEcho) {
        const salesConvSvc = require('../salesConversationService');
        salesConvSvc.handleInboundDm(interaction.toObject ? interaction.toObject() : interaction, organizationId)
          .catch(err => logger.warn('[instagramWebhookService] salesConversationService error (non-fatal)', { error: err.message }));
      }

      return interaction;
    }

    // ── Graph API format: entry.changes[] (comments, mentions, legacy messages) ─
    const changes = entry.changes || [];
    for (const change of changes) {

      if (change.field === 'comments') {
        const comment = change.value;

        // Skip own comments: when the connected IG account posts a comment, from.id equals igAccountId
        if (comment.from && String(comment.from.id) === String(igAccountId)) {
          logger.info('[instagramWebhookService] Skipping own comment from connected account', {
            commentId: comment.id,
            fromId: comment.from.id,
            igAccountId
          });
          return null;
        }

        const parentCommentId = comment.parent_id != null && comment.parent_id !== '' ? String(comment.parent_id) : null;
        const isReply = !!parentCommentId;

        const authorId = comment.from?.id;
        const avatarUrl = await fetchInstagramAuthorAvatar(organizationId, authorId);
        const author = {
          platformId: authorId,
          username: comment.from?.username,
          name: comment.from?.username
        };
        if (avatarUrl) author.avatarUrl = avatarUrl;

        const rawTs = comment.timestamp ?? comment.created_time ?? entry.time;
        let platformCreatedAt = new Date();
        if (rawTs != null) {
          const ms = typeof rawTs === 'number' ? (rawTs < 1e12 ? rawTs * 1000 : rawTs) : Date.parse(rawTs);
          if (Number.isFinite(ms)) platformCreatedAt = new Date(ms);
        }

        // Resolve shortcode permalink via Graph API
        const mediaId = comment.media?.id;
        let postUrl = null;
        if (mediaId && dmReceiverConnection?.accessToken) {
          postUrl = await instagramService.fetchMediaPermalink(dmReceiverConnection.accessToken, mediaId, instagramService._connectionType(dmReceiverConnection));
        }

        let linkedProductCount = 0;
        let linkedProductNames = [];
        if (mediaId) {
          try {
            const Product = require('../../models/Product');
            const { buildPostLinkedProductQuery } = require('../commentToDmProductHelpers');
            const linked = await Product.find(buildPostLinkedProductQuery(organizationId, String(mediaId)))
              .select('name')
              .limit(20)
              .lean();
            linkedProductCount = linked.length;
            linkedProductNames = linked.map(p => p.name).filter(Boolean);
          } catch (linkErr) {
            logger.warn('[instagramWebhookService] linked product lookup failed', { error: linkErr.message });
          }
        }

        const updatePayload = {
          organization: organizationId,
          platform: 'instagram',
          type: 'comment',
          platformId: comment.id,
          content: comment.text,
          author,
          metadata: {
            postId: mediaId,
            postUrl,
            linkedProductCount,
            linkedProductNames
          },
          platformCreatedAt
        };
        if (platformConnectionId) updatePayload.platformConnection = platformConnectionId;
        if (isReply && parentCommentId) updatePayload.parentId = parentCommentId;

        const _igCommentChatRef = await generateChatRef(organizationId).catch(() => ({ chatNumber: null, chatRef: null }));
        const interaction = await Interaction.findOneAndUpdate(
          { platformId: comment.id, organization: organizationId },
          {
            $set: updatePayload,
            $setOnInsert: {
              status: 'unread',
              isRead: false,
              source: 'webhook',
              chatNumber: _igCommentChatRef.chatNumber,
              chatRef: _igCommentChatRef.chatRef
            }
          },
          { upsert: true, new: true }
        );

        if (interaction && organizationId) {
          if (isReply && parentCommentId) {
            const parent = await Interaction.findOne({ platformId: parentCommentId, organization: organizationId }).lean();
            if (parent) {
              emitToOrg(organizationId.toString(), 'new_interaction', { interaction: parent });
            }
          } else {
            emitToOrg(organizationId.toString(), 'new_interaction', { interaction: interaction.toObject() });
          }
        }

        return interaction;
      }

      if (change.field === 'mentions') {
        const mention = change.value || {};
        const mentionId =
          mention.id ||
          mention.comment_id ||
          mention.media_id ||
          `${entry.id}_${mention.timestamp || entry.time || Date.now()}`;

        const authorId = mention.from?.id || mention.user_id || mention.username;
        const avatarUrl = authorId ? await fetchInstagramAuthorAvatar(organizationId, authorId) : null;
        const author = {
          platformId: authorId,
          username: mention.from?.username || mention.username || 'Instagram User',
          name: mention.from?.username || mention.username || 'Instagram User'
        };
        if (avatarUrl) author.avatarUrl = avatarUrl;

        const mentionText =
          mention.text ||
          mention.caption ||
          mention.message ||
          (mention.media_id ? 'You were mentioned on Instagram media.' : 'You were mentioned on Instagram.');

        const rawTs = mention.timestamp ?? mention.created_time ?? entry.time;
        let mentionCreatedAt = new Date();
        if (rawTs != null) {
          const ms = typeof rawTs === 'number' ? (rawTs < 1e12 ? rawTs * 1000 : rawTs) : Date.parse(rawTs);
          if (Number.isFinite(ms)) mentionCreatedAt = new Date(ms);
        }

        const _igMentionChatRef = await generateChatRef(organizationId).catch(() => ({ chatNumber: null, chatRef: null }));
        const interaction = await Interaction.findOneAndUpdate(
          { platformId: String(mentionId), organization: organizationId },
          {
            $set: {
              organization: organizationId,
              platform: 'instagram',
              type: 'mention',
              platformId: String(mentionId),
              content: mentionText,
              author,
              platformCreatedAt: mentionCreatedAt,
              metadata: {
                mentionId: mention.id || null,
                mediaId: mention.media_id || null,
                commentId: mention.comment_id || null,
                postId: mention.media_id || null,
                postUrl: mention.media_id && dmReceiverConnection?.accessToken
                  ? await instagramService.fetchMediaPermalink(dmReceiverConnection.accessToken, mention.media_id, instagramService._connectionType(dmReceiverConnection))
                  : null,
                rawMention: mention
              }
            },
            $setOnInsert: {
              status: 'unread',
              isRead: false,
              source: 'webhook',
              chatNumber: _igMentionChatRef.chatNumber,
              chatRef: _igMentionChatRef.chatRef
            }
          },
          { upsert: true, new: true }
        );

        if (interaction && organizationId) {
          emitToOrg(organizationId.toString(), 'new_interaction', { interaction: interaction.toObject() });
        }

        return interaction;
      }

      if (change.field === 'messages') {
        // Legacy Graph API DM format
        const message = change.value;
        const authorId = message.from?.id;
        const avatarUrl = await fetchInstagramAuthorAvatar(organizationId, authorId);
        const author = {
          platformId: authorId,
          username: message.from?.username,
          name: message.from?.name || message.from?.username
        };
        if (avatarUrl) author.avatarUrl = avatarUrl;

        const rawTs = message.timestamp ?? entry.time;
        let msgPlatformCreatedAt = new Date();
        if (rawTs != null) {
          const ms = typeof rawTs === 'number' ? (rawTs < 1e12 ? rawTs * 1000 : rawTs) : Date.parse(rawTs);
          if (Number.isFinite(ms)) msgPlatformCreatedAt = new Date(ms);
        }

        const _igLegacyDmChatRef = await generateChatRef(organizationId).catch(() => ({ chatNumber: null, chatRef: null }));
        const interaction = await Interaction.findOneAndUpdate(
          { platformId: message.id, organization: organizationId },
          {
            $set: {
              organization: organizationId,
              platform: 'instagram',
              type: 'dm',
              platformId: message.id,
              content: message.message?.text || message.text,
              author,
              threadId: message.conversation_id,
              platformCreatedAt: msgPlatformCreatedAt
            },
            $setOnInsert: {
              status: 'unread',
              isRead: false,
              source: 'webhook',
              chatNumber: _igLegacyDmChatRef.chatNumber,
              chatRef: _igLegacyDmChatRef.chatRef
            }
          },
          { upsert: true, new: true }
        );

        return interaction;
      }
    }

    logger.warn('[instagramWebhookService] No interaction created (no matching messaging or changes)', {
      entryId: entry.id,
      messagingCount: allMessageEvents.length,
      changesCount: (entry.changes || []).length
    });
    return null;
  } catch (error) {
    logger.error('[instagramWebhookService] handleInstagramMessage error', { error: error.message });
    throw error;
  }
}

module.exports = {
  handleInstagramMessage,
  fetchInstagramAuthorProfile,
  extractStoryContext,
  buildInstagramDmAttachmentFields,
  buildInstagramDmPlaceholderText
};
