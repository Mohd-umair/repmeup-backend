const Interaction = require('../models/Interaction');
const PlatformConnection = require('../models/PlatformConnection');
const { aiQueue } = require('../config/queue');
const logger = require('../config/logger');
const instagramService = require('../integrations/meta/instagramService');
const { emitToOrg } = require('../utils/socketEmitter');
const cacheService = require('../services/cacheService');
const { isThreadStyleDm, resetAutoReplyCountersForNewInbound } = require('../utils/interactionThreadDm');
const { generateChatRef } = require('../utils/chatRefHelper');
const { resolveContact, normalizeAuthorForPlatform } = require('../services/contactService');
const instagramWebhookService = require('../services/webhook/instagramWebhookService');
const whatsappWebhookService = require('../services/webhook/whatsappWebhookService');

/**
 * Process webhook events from social media platforms
 * This job handles incoming webhook payloads and creates interactions
 */
module.exports = async function processWebhook(job) {
  const jobLogger = logger.createChild({ 
    module: 'processWebhook', 
    jobId: job.id,
    orgId: job.data.organizationId 
  });
  
  try {
    const { platform, payload, organizationId } = job.data;

    jobLogger.info('Processing webhook', { platform });

    let interaction = null;

    switch (platform) {
      case 'instagram':
        interaction = await instagramWebhookService.handleInstagramMessage(payload, organizationId);
        break;

      case 'facebook':
        interaction = await handleFacebookWebhook(payload, organizationId);
        break;

      case 'whatsapp':
        interaction = await whatsappWebhookService.handleWhatsAppMessage(payload, organizationId);
        break;

      case 'whatsapp_webhook':
        await whatsappWebhookService.processWhatsAppWebhook(payload);
        break;
      
      case 'google':
        interaction = await handleGoogleWebhook(payload, organizationId);
        break;
      
      case 'youtube':
        interaction = await handleYouTubeWebhook(payload, organizationId);
        break;
      
      case 'linkedin':
        interaction = await handleLinkedInWebhook(payload, organizationId);
        break;
      
      default:
        jobLogger.warn('Unknown platform', { platform });
    }

    if (interaction) {
      jobLogger.info('Interaction created', {
        interactionId: interaction._id.toString(),
        platform: interaction.platform,
        type: interaction.type,
        contentPreview: interaction.content?.substring(0, 100)
      });

      // ─── Contact Identity Resolution (fire-and-forget) ──────────────────
      // Resolve (or create) the unified Contact for this customer.
      // Runs in background — never blocks message delivery or AI queuing.
      if (interaction.author?.platformId) {
        (async () => {
          try {
            const contactPayload = normalizeAuthorForPlatform(
              interaction.platform,
              interaction.author,
              {} // rawData kept minimal to avoid storing large webhook payloads
            );
            const contact = await resolveContact(contactPayload, organizationId);
            if (contact) {
              await Interaction.findByIdAndUpdate(interaction._id, { contact: contact._id });
              // Keep in-memory reference so downstream in this job can access it
              interaction.contact = contact._id;
            }
          } catch (contactErr) {
            jobLogger.warn('Contact resolution failed (non-fatal)', { error: contactErr.message });
          }
        })();
      }

      // Invalidate inbox + analytics cache (dashboard counts / charts use Redis analytics:* keys)
      if (organizationId) {
        cacheService.invalidateInteractionCaches(organizationId).catch(err => {
          jobLogger.warn('Failed to invalidate interaction caches', { err: err?.message });
        });
      }

      // Unified Flow Builder routing (workflow-first; AI is the fallback)
      let flowHandledComment = false;
      let flowHandledStory = false;
      let flowHandled = false;
      if (organizationId) {
        try {
          const flowTriggerRouter = require('../services/flow/flowTriggerRouter');
          let eventType = `${interaction.platform}.${interaction.type}`;
          if (interaction.platform === 'instagram' && interaction.type === 'comment') {
            eventType = 'instagram.comment';
          } else if (
            interaction.platform === 'instagram' &&
            interaction.type === 'dm' &&
            interaction.metadata?.isStoryEngagement
          ) {
            eventType =
              interaction.metadata.storyTriggerType === 'story_mention'
                ? 'instagram.story_mention'
                : 'instagram.story_reply';
          } else if (interaction.platform === 'instagram' && interaction.type === 'dm') {
            eventType = 'instagram.dm';
          } else if (interaction.platform === 'whatsapp') {
            eventType = 'whatsapp.message';
          }

          const flowResult = await flowTriggerRouter.route({
            organizationId,
            platform: interaction.platform,
            eventType,
            interaction,
            payload: {
              content: interaction.content,
              text: interaction.content,
              postback: interaction.metadata?.postback || interaction.metadata?.buttonPayload
            }
          });

          if (flowResult.handled) {
            flowHandled = true;
            if (interaction.platform === 'instagram' && interaction.type === 'comment') {
              flowHandledComment = true;
            }
            if (
              interaction.platform === 'instagram' &&
              interaction.type === 'dm' &&
              interaction.metadata?.isStoryEngagement
            ) {
              flowHandledStory = true;
            }
            jobLogger.info('Automation flow handled event', {
              eventType,
              enrollments: flowResult.enrollments.length
            });
          }
        } catch (flowErr) {
          jobLogger.warn('Automation flow routing error (non-fatal)', { error: flowErr.message });
        }
      }

      // Comment-to-DM selling flow only (follow-invite moved to processAI.js so sentiment is available)
      if (
        !flowHandledComment &&
        interaction.platform === 'instagram' &&
        interaction.type === 'comment'
      ) {
        const commentToDmService = require('../services/commentToDmService');
        (async () => {
          try {
            await commentToDmService.processCommentForProduct(interaction, organizationId);
          } catch (err) {
            jobLogger.warn('comment automation chain error', { err: err?.message });
          }
        })();
      }

      // Story-to-DM: story reply / @mention → product DM (before AI queue)
      let storyToDmSent = false;
      if (
        !flowHandledStory &&
        interaction.platform === 'instagram' &&
        interaction.type === 'dm' &&
        interaction.metadata?.isStoryEngagement
      ) {
        try {
          const storyToDmService = require('../services/storyToDmService');
          const result = await storyToDmService.processStoryEngagement(interaction, organizationId);
          storyToDmSent = !!result?.sent;
          if (storyToDmSent) {
            jobLogger.info('Story-to-DM automation sent', { interactionId: interaction._id.toString() });
          }
        } catch (err) {
          jobLogger.warn('story-to-dm automation error', { err: err?.message });
        }
      }

      // Per-comment / per-message interactions: skip if we already answered that item.
      // DM threads (platformId dm_*_*): one doc per conversation — replies[] is thread history; still queue AI for each new message.
      const hasReplies = interaction.replies && interaction.replies.length > 0;
      const isAlreadyReplied = interaction.status === 'replied' || interaction.status === 'resolved';
      const threadDm = isThreadStyleDm(interaction);

      // Workflow-first gate: AI runs only as a fallback per the channel automation mode.
      let runAiFallback = true;
      if (organizationId) {
        try {
          const Organization = require('../models/Organization');
          const replyEngineService = require('../services/replyEngineService');
          const orgDoc = await Organization.findById(organizationId)
            .select('automationModeByChannel automationFlowMode')
            .lean();
          ({ runAiFallback } = replyEngineService.decide({
            organization: orgDoc,
            platform: interaction.platform,
            flowHandled
          }));
        } catch (modeErr) {
          jobLogger.warn('Reply-engine mode resolve failed (defaulting to AI fallback on)', { error: modeErr.message });
        }
      }

      if (!runAiFallback) {
        logger.info(`⏭️  [Webhook] Skipping AI — channel mode/flow ownership (flowHandled: ${flowHandled}): ${interaction._id}`);
      } else if (!threadDm && (hasReplies || isAlreadyReplied)) {
        logger.info(`⏭️  [Webhook] Skipping AI and auto-reply queue - interaction already replied to (status: ${interaction.status}, replies: ${interaction.replies?.length || 0})`);
      } else if (storyToDmSent) {
        logger.info(`⏭️  [Webhook] Skipping AI — Story-to-DM handled this message: ${interaction._id}`);
      } else {
        // Thread DMs reuse one interaction id per conversation — jobId must include message id or each new message would be deduped by Bull
        const mid = interaction.metadata?.lastMid;
        const aiJobId =
          threadDm && mid
            ? `ai-${interaction._id}-${mid}`
            : `ai-${interaction._id}`;

        await aiQueue.add(
          {
            interactionId: interaction._id
          },
          {
            attempts: 3,
            backoff: 2000,
            jobId: aiJobId
          }
        );

        logger.info(`📝 [Webhook] Queued for AI processing: ${interaction._id}${threadDm && mid ? ` (mid ${mid})` : ''}`);

        // Queue auto-reply if webhook mode is enabled
        const autoReplyScheduler = require('../services/autoReplyScheduler');
        const queued = await autoReplyScheduler.queueImmediateAutoReply(
          interaction._id,
          organizationId
        );

        if (queued) {
          logger.info(`🤖 [Webhook] Auto-reply queued for interaction: ${interaction._id}`);
        } else {
          logger.info(`⚠️  [Webhook] Auto-reply NOT queued (check trigger mode settings)`);
        }
      }
    } else {
      jobLogger.info('No interaction created (read/reaction/duplicate or no message events)', { platform });
    }

    return {
      success: true,
      interactionId: interaction?._id,
      platform
    };

  } catch (error) {
    logger.error('Webhook processing error', { error: error.message, stack: error.stack });
    throw error;
  }
};

/**
 * @deprecated Logic has been moved to src/services/webhook/instagramWebhookService.js
 * This file-local copy is no longer called and will be removed in a future cleanup.
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
      }).select('accessToken');
      token = connection?.accessToken;
    } catch (e) {
      logger.warn('[processWebhook] fetchInstagramAuthorProfile: connection lookup failed', { error: e.message });
      return {};
    }
  }
  if (!token) return {};
  try {
    const profile = await instagramService._fetchInstagramUserProfile(token, igUserId);
    if (!profile) return {};
    const avatarUrl = profile.profile_pic || profile.profile_picture_url || undefined;
    return {
      username: profile.username || undefined,
      name: profile.name || profile.username || undefined,
      avatarUrl
    };
  } catch (e) {
    logger.warn('[processWebhook] fetchInstagramAuthorProfile failed for igUserId=', { igUserId, error: e.message });
    return {};
  }
}

/**
 * Fetch Instagram commenter/DM author profile picture (for inbox avatar).
 * Returns avatarUrl or undefined. Logs for debug.
 * @deprecated Prefer fetchInstagramAuthorProfile when you need username/name too.
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

/** @deprecated Prefer instagramWebhookService — kept in sync for legacy callers */
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
 * Meta sometimes delivers user-shared IG post/reel/story in DM with is_echo:true, sender=IG business id.
 * @deprecated Prefer instagramWebhookService
 */
function isInstagramSharePostEcho(event, message, igAccountId) {
  if (!message?.is_echo || !igAccountId) return false;
  if (String(event.sender?.id) !== String(igAccountId) || !event.recipient?.id) return false;
  const atts = message.attachments || [];
  return atts.some(isInstagramUserSharedMediaEchoAttachment);
}

/** @deprecated Prefer instagramWebhookService */
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
    p.ig_post_media_id || p.reel_media_id || p.media_id || null;
  return {
    attachmentType: primary?.type || 'file',
    attachmentUrl: p.url || p.attachment_url || null,
    igPostMediaId,
    shareTitle: typeof p.title === 'string' ? p.title : null
  };
}

/** @deprecated Prefer instagramWebhookService */
function buildInstagramDmPlaceholderText(attachmentType, igPostMediaId) {
  const t = String(attachmentType || '').toLowerCase();
  if (igPostMediaId) return '[Shared Instagram post]';
  if (t === 'ig_reel' || t === 'reel') return '[Shared Instagram reel]';
  if (t === 'story' || t === 'ig_story') return '[Shared Instagram story]';
  if (attachmentType) return `[${attachmentType}]`;
  return '';
}

/**
 * @deprecated Logic has been moved to src/services/webhook/instagramWebhookService.js
 * This file-local copy is no longer called and will be removed in a future cleanup.
 */
async function handleInstagramWebhook(payload, organizationId) {
  try {
    const entry = payload.entry?.[0];
    if (!entry) {
      logger.warn('[processWebhook] Instagram: no entry in payload');
      return null;
    }

    // Resolve Instagram connection so we can set platformConnection on new DMs (needed for reply)
    const igAccountId = entry.id;
    let platformConnectionId = null;
    let dmReceiverConnection = null;
    if (igAccountId) {
      // Primary: match by platformUserId
      let conn = await PlatformConnection.findOne({
        organization: organizationId,
        platform: 'instagram',
        platformUserId: { $in: [String(igAccountId), igAccountId].filter(Boolean) },
        status: { $in: ['connected', 'available'] },
        isActive: true
      }).select('_id accessToken platformUserId platformPageId platformData metadata platformUsername').lean();

      // Fallback: search by platformPageId or businessAccountId
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
        }).select('_id accessToken platformUserId platformPageId platformData metadata platformUsername').lean();
      }

      if (conn) {
        platformConnectionId = conn._id;
        dmReceiverConnection = conn;
      } else {
        logger.warn('[processWebhook] Instagram: no connection found', { igAccountId, organizationId });
      }
    }

    // --- Instagram Messaging (DMs): entry.messaging[] and entry.standby[] ---
    // standby = customer sent message (or edit/reaction) but app wasn't "in control". Process items with .message as incoming DMs; skip .message_edit, .reaction, .read.
    const messaging = entry.messaging || [];
    const standby = entry.standby || [];
    const allMessageEvents = [...messaging, ...standby];

    if (allMessageEvents.length === 0) {
      const hasComments = !!(entry.changes?.some(c => c.field === 'comments'));
      const hasMentions = !!(entry.changes?.some(c => c.field === 'mentions'));
      logger.info('[processWebhook] Instagram: no DM/standby events — checking changes', {
        entryId: entry.id,
        hasComments,
        hasMentions
      });
    }

    // One conversation thread per customer: platformId = dm_igAccountId_<userId> (not per-message mid)
    for (const event of allMessageEvents) {
      const message = event.message;
      if (!message) {
        // message_edit, reaction, read, etc. — skip (or could update thread in future)
        continue;
      }
      if (message.is_deleted || message.is_unsupported) {
        logger.info('[processWebhook] Instagram: skipping message', {
          is_deleted: !!message.is_deleted,
          is_unsupported: !!message.is_unsupported
        });
        continue;
      }

      const sharePostEcho = isInstagramSharePostEcho(event, message, igAccountId);
      if (message.is_echo && !sharePostEcho) {
        logger.info('[processWebhook] Instagram: skipping message', {
          is_echo: true,
          reason: 'echo (not user-shared post)'
        });
        continue;
      }

      // Normal DM: partner is sender. Share-post echo: sender is IG account, partner is recipient (the user).
      const partnerId = sharePostEcho ? event.recipient?.id : event.sender?.id;
      const mid = message.mid;
      const { attachmentType, attachmentUrl, igPostMediaId, shareTitle } = buildInstagramDmAttachmentFields(message);
      const text =
        message.text ||
        shareTitle ||
        buildInstagramDmPlaceholderText(attachmentType, igPostMediaId);
      if (!mid || !partnerId) {
        logger.warn('[processWebhook] Instagram: message missing mid or partnerId', {
          mid: !!mid,
          partnerId: !!partnerId,
          sharePostEcho
        });
        continue;
      }

      if (sharePostEcho) {
        logger.info('[processWebhook] Instagram: processing share/ig_post echo as incoming DM', {
          partnerId: String(partnerId),
          igPostMediaId: igPostMediaId || undefined
        });
      }

      // Webhook only sends ids; fetch username/name/profile_pic from Instagram User Profile API.
      // Must use the token of the IG account that *received* the DM (Meta requirement).
      const profile = await fetchInstagramAuthorProfile(
        organizationId,
        String(partnerId),
        dmReceiverConnection?.accessToken || null
      );
      if (!profile.username && !profile.name && !profile.avatarUrl) {
        // Expected when app lacks Advanced Access; interaction is still created with platformId
        logger.debug('[processWebhook] Instagram DM: no profile for partnerId', {
          partnerId: String(partnerId),
          hasReceiverToken: !!dmReceiverConnection?.accessToken
        });
      }
      const author = {
        platformId: String(partnerId),
        username: profile.username,
        name: profile.name || profile.username || 'Instagram User'
      };
      if (profile.avatarUrl) author.avatarUrl = profile.avatarUrl;

      // One thread per conversation (IG account + customer), not per message
      const threadPlatformId = `dm_${String(igAccountId)}_${String(partnerId)}`;
      const existing = await Interaction.findOne({ platformId: threadPlatformId }).select('_id metadata.lastMid author chatRef').lean();
      if (existing && existing.metadata?.lastMid === mid) {
        // Meta webhook retry — do not re-queue AI / auto-reply
        logger.debug('[processWebhook] Instagram DM duplicate mid (webhook retry)', { threadPlatformId, mid });
        return null;
      }

      // Always update author so profile pic / username show up once the API returns them.
      // If the profile fetch returned richer data than what's stored, overwrite.
      const existingAuthor = existing?.author || {};
      const mergedAuthor = {
        platformId: String(partnerId),
        username: profile.username || existingAuthor.username || undefined,
        name: profile.name || existingAuthor.name || profile.username || existingAuthor.username || 'Instagram User'
      };
      if (profile.avatarUrl) mergedAuthor.avatarUrl = profile.avatarUrl;
      else if (existingAuthor.avatarUrl) mergedAuthor.avatarUrl = existingAuthor.avatarUrl;

      // Generate chatRef for new interactions or backfill existing ones that don't have it
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
        'metadata.instagramAccountId': igAccountId,
        status: 'unread',
        isRead: false
      };
      if (platformConnectionId) updateFields.platformConnection = platformConnectionId;

      // Backfill chatRef into $set for existing interactions that don't have it
      if (existing && !existing.chatRef && _igDmChatRef?.chatRef) {
        updateFields.chatNumber = _igDmChatRef.chatNumber;
        updateFields.chatRef = _igDmChatRef.chatRef;
      }

      // Step 1: Upsert the thread (create or update non-message fields)
      // For NEW interactions: chatRef goes into $setOnInsert (avoids $set/$setOnInsert field conflict)
      // For EXISTING without chatRef: already added to updateFields ($set) above
      const setOnInsertFields = (!existing && _igDmChatRef?.chatRef)
        ? { chatNumber: _igDmChatRef.chatNumber, chatRef: _igDmChatRef.chatRef, source: 'webhook' }
        : { source: 'webhook' };
      await Interaction.findOneAndUpdate(
        { platformId: threadPlatformId },
        { $set: updateFields, $setOnInsert: setOnInsertFields },
        { upsert: true }
      );

      // Step 2: Only append message if this mid is not already in the array.
      // This prevents duplicates when Meta retries the same webhook event.
      const incomingMsg = { mid, text, timestamp: event.timestamp };
      if (attachmentUrl) incomingMsg.attachmentUrl = attachmentUrl;
      if (attachmentType) incomingMsg.attachmentType = attachmentType;
      if (igPostMediaId) incomingMsg.igPostMediaId = igPostMediaId;
      const _igDmPush = await Interaction.updateOne(
        { platformId: threadPlatformId, 'metadata.incomingMessages.mid': { $ne: mid } },
        {
          $push: {
            'metadata.incomingMessages': {
              $each: [incomingMsg],
              $slice: -100
            }
          }
        }
      );

      // New inbound DM (not a webhook retry) → reset auto-reply hard-stop counters.
      if (_igDmPush.modifiedCount > 0) {
        await resetAutoReplyCountersForNewInbound(Interaction, { platformId: threadPlatformId });
      }

      const interaction = await Interaction.findOne({ platformId: threadPlatformId });

      // Emit real-time socket event so the frontend inbox updates instantly
      if (interaction && organizationId) {
        emitToOrg(organizationId.toString(), 'new_interaction', {
          interaction: interaction.toObject()
        });
      }

      return interaction;
    }

    // --- Graph API format: entry.changes[] (comments, or legacy "messages") ---
    const changes = entry.changes || [];
    for (const change of changes) {
      if (change.field === 'comments') {
        const comment = change.value;
        // Skip own comments: when the connected IG account owner posts a comment,
        // from.id equals the account's global IG ID (= entry.id = igAccountId).
        // Business owner comments must not appear as inbox interactions.
        if (comment.from && String(comment.from.id) === String(igAccountId)) {
          logger.info('[processWebhook] Instagram: skipping own comment from connected account', {
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

        // Instagram may send timestamp as seconds, ms, or under different key; ensure valid Date
        const rawTs = comment.timestamp ?? comment.created_time ?? entry.time;
        let platformCreatedAt = new Date();
        if (rawTs != null) {
          const ms = typeof rawTs === 'number' ? (rawTs < 1e12 ? rawTs * 1000 : rawTs) : Date.parse(rawTs);
          if (Number.isFinite(ms)) platformCreatedAt = new Date(ms);
        }

        // Resolve the proper shortcode permalink (e.g. /p/DWfGl70lIGM/) via Graph API
        const mediaId = comment.media?.id;
        let postUrl = null;
        if (mediaId && dmReceiverConnection?.accessToken) {
          postUrl = await instagramService.fetchMediaPermalink(dmReceiverConnection.accessToken, mediaId);
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
            postUrl
          },
          platformCreatedAt
        };
        // Link to the platform connection so the inbox reply path can resolve
        // the correct access token and account, same as DMs do at line 428.
        if (platformConnectionId) updatePayload.platformConnection = platformConnectionId;
        if (isReply && parentCommentId) {
          updatePayload.parentId = parentCommentId; // So this reply shows in the parent thread, not as new conversation
        }

        const _igCommentChatRef = await generateChatRef(organizationId).catch(() => ({ chatNumber: null, chatRef: null }));
        const interaction = await Interaction.findOneAndUpdate(
          { platformId: comment.id },
          {
            $set: updatePayload,
            $setOnInsert: { status: 'unread', isRead: false, source: 'webhook', chatNumber: _igCommentChatRef.chatNumber, chatRef: _igCommentChatRef.chatRef }
          },
          { upsert: true, new: true }
        );

        if (interaction && organizationId) {
          if (isReply && parentCommentId) {
            // Reply: bump parent to top; do not emit this reply as a new conversation
            const parent = await Interaction.findOne({
              platformId: parentCommentId,
              organization: organizationId
            }).lean();
            if (parent) {
              emitToOrg(organizationId.toString(), 'new_interaction', {
                interaction: parent
              });
            }
          } else {
            // Top-level comment: emit so it appears in the list
            emitToOrg(organizationId.toString(), 'new_interaction', {
              interaction: interaction.toObject()
            });
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
          { platformId: String(mentionId) },
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
                  ? await instagramService.fetchMediaPermalink(dmReceiverConnection.accessToken, mention.media_id)
                  : null,
                rawMention: mention
              }
            },
            $setOnInsert: { status: 'unread', isRead: false, source: 'webhook', chatNumber: _igMentionChatRef.chatNumber, chatRef: _igMentionChatRef.chatRef }
          },
          { upsert: true, new: true }
        );

        if (interaction && organizationId) {
          emitToOrg(organizationId.toString(), 'new_interaction', {
            interaction: interaction.toObject()
          });
        }

        return interaction;
      }

      if (change.field === 'messages') {
        // New DM (legacy Graph API format): fetch sender profile for inbox avatar
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
          { platformId: message.id },
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
            $setOnInsert: { status: 'unread', isRead: false, source: 'webhook', chatNumber: _igLegacyDmChatRef.chatNumber, chatRef: _igLegacyDmChatRef.chatRef }
          },
          { upsert: true, new: true }
        );

        return interaction;
      }
    }

    logger.warn('[processWebhook] Instagram: no interaction created (no matching messaging or changes)', {
      entryId: entry.id,
      messagingCount: allMessageEvents.length,
      changesCount: (entry.changes || []).length
    });
    return null;
  } catch (error) {
    logger.error('Instagram webhook handler error', { error: error.message, stack: error.stack });
    throw error;
  }
}

/**
 * Parse timestamp from Meta webhooks. Facebook often sends Unix seconds; convert to Date.
 * @param {number|string} value - Unix seconds, ms, or ISO string
 * @returns {Date}
 */
function parseMetaTimestamp(value) {
  if (value == null) return new Date();
  if (typeof value === 'number') {
    const ms = value < 1e12 ? value * 1000 : value;
    return new Date(ms);
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed) : new Date();
}

/**
 * Handle Facebook webhook
 * Supports:
 * 1. Messenger (Page DMs): entry.messaging[] - sender.id (PSID), message.mid, message.text
 * 2. Feed comments: entry.changes[] with field "feed", item "comment"
 * 3. Legacy conversations: entry.changes[] with field "conversations"
 */
async function handleFacebookWebhook(payload, organizationId) {
  try {
    const entry = payload.entry?.[0];
    if (!entry) return null;

    const pageId = entry.id;

    // Resolve Page connection (for DMs we need token and connection for reply)
    let platformConnectionId = null;
    let pageConnection = null;
    if (pageId) {
      const conn = await PlatformConnection.findOne({
        organization: organizationId,
        platform: 'facebook',
        platformPageId: { $in: [String(pageId), pageId].filter(Boolean) },
        status: 'connected',
        isActive: true
      }).select('_id accessToken').lean();
      if (conn) {
        platformConnectionId = conn._id;
        pageConnection = conn;
      }
    }

    // --- Messenger (Page DMs) format: entry.messaging[] ---
    const messaging = entry.messaging || [];
    for (const event of messaging) {
      const message = event.message;
      if (!message) continue;
      if (message.is_echo || message.is_deleted) continue;

      const senderId = event.sender?.id;
      const mid = message.mid;
      const attachment = message.attachments && message.attachments[0] ? message.attachments[0] : null;
      const attachmentType = attachment ? (attachment.type || 'file') : null;
      const attachmentUrl = attachment && attachment.payload && attachment.payload.url ? attachment.payload.url : null;
      const text = message.text || (attachment ? `[${attachmentType}]` : '');
      if (!mid || !senderId) continue;

      const profile = await fetchFacebookSenderProfile(organizationId, pageId, senderId, pageConnection?.accessToken);
      const author = {
        platformId: senderId,
        username: profile.name || 'Messenger User',
        name: profile.name || 'Messenger User'
      };
      if (profile.avatarUrl) author.avatarUrl = profile.avatarUrl;

      const threadPlatformId = `dm_${String(pageId)}_${String(senderId)}`;
      const existing = await Interaction.findOne({ platformId: threadPlatformId }).select('_id metadata.lastMid chatRef').lean();
      if (existing && existing.metadata?.lastMid === mid) {
        logger.debug('[processWebhook] Facebook DM duplicate mid (webhook retry)', { threadPlatformId, mid });
        return null;
      }

      const incomingMsg = { mid, text, timestamp: event.timestamp };
      if (attachmentUrl) incomingMsg.attachmentUrl = attachmentUrl;
      if (attachmentType) incomingMsg.attachmentType = attachmentType;

      // Generate chatRef for new interactions or backfill existing ones that don't have it
      let _fbDmChatRef = null;
      if (!existing || !existing.chatRef) {
        _fbDmChatRef = await generateChatRef(organizationId).catch(() => ({ chatNumber: null, chatRef: null }));
      }

      const updateFields = {
        organization: organizationId,
        platform: 'facebook',
        type: 'dm',
        platformId: threadPlatformId,
        content: text,
        author,
        threadId: senderId,
        platformCreatedAt: new Date(event.timestamp),
        'metadata.lastMid': mid,
        'metadata.facebookPageId': pageId,
        status: 'unread',
        isRead: false
      };
      if (platformConnectionId) updateFields.platformConnection = platformConnectionId;

      // Backfill chatRef into $set for existing interactions that don't have it
      if (existing && !existing.chatRef && _fbDmChatRef?.chatRef) {
        updateFields.chatNumber = _fbDmChatRef.chatNumber;
        updateFields.chatRef = _fbDmChatRef.chatRef;
      }

      const updateOps = {
        $set: updateFields,
        $push: {
          'metadata.incomingMessages': {
            $each: [incomingMsg],
            $slice: -100
          }
        }
      };
      // For NEW interactions: chatRef + source via $setOnInsert
      if (!existing) {
        updateOps.$setOnInsert = {
          source: 'webhook',
          ...(_fbDmChatRef?.chatRef ? { chatNumber: _fbDmChatRef.chatNumber, chatRef: _fbDmChatRef.chatRef } : {})
        };
      }

      const interaction = await Interaction.findOneAndUpdate(
        { platformId: threadPlatformId },
        updateOps,
        { upsert: true, new: true }
      );

      // New inbound DM → reset the auto-reply hard-stop counters so a long-lived
      // conversation isn't permanently locked out of auto-reply once it crosses
      // maxAutoReplies. (Bot loops never reach here — no inbound between replies.)
      await resetAutoReplyCountersForNewInbound(Interaction, { platformId: threadPlatformId });

      return interaction;
    }

    // --- Feed comments and legacy conversations: entry.changes[] ---
    const changes = entry.changes || [];
    for (const change of changes) {
      if (change.field === 'feed' && change.value.item === 'comment') {
        const comment = change.value;
        // Skip our own replies: when the Page replies to a comment, Facebook sends a webhook with
        // comment.from.id = pageId. Do not create a new conversation for those — they already
        // exist in the thread as interaction.replies.
        if (comment.from && String(comment.from.id) === String(pageId)) {
          return null;
        }

        // New comment on post (from a user) — fetch commenter profile for avatar
        const commenterProfile = await fetchFacebookSenderProfile(organizationId, pageId, comment.from?.id, pageConnection?.accessToken);
        const author = {
          platformId: comment.from.id,
          username: commenterProfile.name || comment.from.name || 'Facebook User',
          name: commenterProfile.name || comment.from.name || 'Facebook User'
        };
        if (commenterProfile.avatarUrl) author.avatarUrl = commenterProfile.avatarUrl;

        // Facebook sends created_time in Unix seconds; parse so SLA/Overdue is correct
        const platformCreatedAt = parseMetaTimestamp(comment.created_time);

        const updateFields = {
          organization: organizationId,
          platform: 'facebook',
          type: 'comment',
          platformId: comment.comment_id,
          content: comment.message,
          author,
          metadata: {
            postId: comment.post_id,
            postUrl: `https://www.facebook.com/${comment.post_id}`,
            facebookPageId: pageId
          },
          platformCreatedAt
        };
        if (platformConnectionId) updateFields.platformConnection = platformConnectionId;

        const _fbCommentChatRef = await generateChatRef(organizationId).catch(() => ({ chatNumber: null, chatRef: null }));
        const interaction = await Interaction.findOneAndUpdate(
          { platformId: comment.comment_id },
          {
            $set: updateFields,
            $setOnInsert: { status: 'unread', isRead: false, source: 'webhook', chatNumber: _fbCommentChatRef.chatNumber, chatRef: _fbCommentChatRef.chatRef }
          },
          { upsert: true, new: true }
        );

        // Emit so inbox list updates immediately without sync/poll
        if (interaction && organizationId) {
          emitToOrg(organizationId.toString(), 'new_interaction', {
            interaction: interaction.toObject ? interaction.toObject() : interaction
          });
        }

        return interaction;
      }

      if (change.field === 'conversations') {
        // Legacy format: New message — fetch sender profile for avatar
        const message = change.value;
        const senderProfile = await fetchFacebookSenderProfile(organizationId, pageId, message.from?.id, pageConnection?.accessToken);
        const author = {
          platformId: message.from.id,
          username: senderProfile.name || message.from.name || 'Facebook User',
          name: senderProfile.name || message.from.name || 'Facebook User'
        };
        if (senderProfile.avatarUrl) author.avatarUrl = senderProfile.avatarUrl;

        const _fbDmChatRef = await generateChatRef(organizationId).catch(() => ({ chatNumber: null, chatRef: null }));
        const interaction = await Interaction.findOneAndUpdate(
          { platformId: message.id },
          {
            $set: {
              organization: organizationId,
              platform: 'facebook',
              type: 'dm',
              platformId: message.id,
              content: message.message,
              author,
              threadId: message.thread_id,
              platformCreatedAt: parseMetaTimestamp(message.created_time)
            },
            $setOnInsert: { status: 'unread', isRead: false, source: 'webhook', chatNumber: _fbDmChatRef.chatNumber, chatRef: _fbDmChatRef.chatRef }
          },
          { upsert: true, new: true }
        );

        return interaction;
      }
    }

    return null;
  } catch (error) {
    logger.error('Facebook webhook handler error', { error: error.message, stack: error.stack });
    throw error;
  }
}

/**
 * Fetch Facebook user profile (name + CDN avatar URL) for a PSID or commenter user ID.
 *
 * Uses  GET /{id}?fields=name,first_name,last_name,picture{url}
 * `picture{url}` asks Graph to return the actual CDN URL (fbsbx.com / lookaside) rather than
 * the redirect endpoint, so we can store and display it in the browser without any auth.
 *
 * Returns { name, avatarUrl } — both may be undefined when the API call fails or the user
 * has restricted their profile visibility.
 */
async function fetchFacebookSenderProfile(organizationId, pageId, psid, accessTokenFromConnection = null) {
  if (!psid) return {};
  let token = accessTokenFromConnection;
  if (!token && pageId) {
    const conn = await PlatformConnection.findOne({
      organization: organizationId,
      platform: 'facebook',
      platformPageId: { $in: [String(pageId), pageId] },
      status: 'connected',
      isActive: true
    }).select('accessToken').lean();
    token = conn?.accessToken;
  }
  if (!token) return {};
  try {
    const axios = require('axios');
    const baseUrl = 'https://graph.facebook.com/v18.0';
    const res = await axios.get(`${baseUrl}/${psid}`, {
      // picture{url} returns the resolved CDN URL directly.
      // picture.data.is_silhouette === true means no real photo (privacy / no photo set).
      params: { fields: 'name,first_name,last_name,picture{url}', access_token: token },
      timeout: 5000
    });
    const data = res.data || {};
    const name = data.name || (data.first_name && data.last_name
      ? `${data.first_name} ${data.last_name}`.trim()
      : data.first_name || data.last_name);
    // picture.data[0].url when using {url} sub-selection, or picture.data.url for plain picture
    const picData = Array.isArray(data.picture?.data) ? data.picture.data[0] : data.picture?.data;
    const avatarUrl = picData?.url || data.picture?.url || undefined;
    return { name: name || undefined, avatarUrl };
  } catch (err) {
    // Suppress the warning for 403 (privacy / no permission) — expected for many users.
    if (err.response?.status !== 403) {
      logger.warn('[processWebhook] fetchFacebookSenderProfile failed for psid=', { psid, error: err.response?.data?.error?.message || err.message });
    }
    return {};
  }
}

/**
 * @deprecated Logic has been moved to src/services/webhook/whatsappWebhookService.js
 * This file-local copy is no longer called and will be removed in a future cleanup.
 */
async function handleWhatsAppWebhook(payload, organizationId) {
  try {
    const entry = payload.entry?.[0];
    if (!entry) return null;

    const changes = entry.changes || [];

    for (const change of changes) {
      const value = change.value || {};
      if (!value.messages || value.messages.length === 0) continue;

      const message = value.messages[0];
      const phoneNumberId = value.metadata?.phone_number_id;
      const senderId = String(message.from);
      const mid = message.id;

      // One Interaction per (connected phone number, customer)
      const threadPlatformId = `dm_${String(phoneNumberId)}_${senderId}`;

      const existing = await Interaction
        .findOne({ platformId: threadPlatformId })
        .select('_id metadata.lastMid author chatRef')
        .lean();

      // Idempotency: skip if we've already recorded this exact message id
      if (existing && existing.metadata?.lastMid === mid) {
        return null;
      }

      const prevAuthor = existing?.author || {};
      const mergedAuthor = {
        platformId: senderId,
        name: value.contacts?.[0]?.profile?.name || prevAuthor.name || senderId,
        username: value.contacts?.[0]?.wa_id || prevAuthor.username || senderId
      };

      let chatRefData = null;
      if (!existing || !existing.chatRef) {
        chatRefData = await generateChatRef(organizationId).catch(() => ({ chatNumber: null, chatRef: null }));
      }

      const textContent = message.text?.body || message.body || '';

      const set = {
        organization: organizationId,
        platform: 'whatsapp',
        type: 'dm',
        platformId: threadPlatformId,
        threadId: senderId,
        content: textContent,
        author: mergedAuthor,
        platformCreatedAt: new Date(parseInt(message.timestamp) * 1000),
        status: 'unread',
        isRead: false,
        'metadata.lastMid': mid,
        'metadata.phoneNumberId': String(phoneNumberId)
      };

      const setOnInsert = { source: 'webhook' };
      if (existing && !existing.chatRef && chatRefData?.chatRef) {
        set.chatNumber = chatRefData.chatNumber;
        set.chatRef = chatRefData.chatRef;
      } else if (!existing && chatRefData?.chatRef) {
        setOnInsert.chatNumber = chatRefData.chatNumber;
        setOnInsert.chatRef = chatRefData.chatRef;
      }

      await Interaction.findOneAndUpdate(
        { platformId: threadPlatformId },
        { $set: set, $setOnInsert: setOnInsert },
        { upsert: true }
      );

      // Append this message to the thread's message list; guard against duplicate mids
      const _liDmPush = await Interaction.updateOne(
        { platformId: threadPlatformId, 'metadata.incomingMessages.mid': { $ne: mid } },
        {
          $push: {
            'metadata.incomingMessages': {
              $each: [{ mid, text: textContent, timestamp: Date.now(), type: message.type }],
              $slice: -100
            }
          }
        }
      );

      // New inbound DM (not a webhook retry) → reset auto-reply hard-stop counters.
      if (_liDmPush.modifiedCount > 0) {
        await resetAutoReplyCountersForNewInbound(Interaction, { platformId: threadPlatformId });
      }

      const interaction = await Interaction.findOne({ platformId: threadPlatformId });
      return interaction;
    }

    return null;
  } catch (error) {
    logger.error('WhatsApp webhook handler error', { error: error.message, stack: error.stack });
    throw error;
  }
}

/**
 * Handle Google Business Profile webhook
 */
async function handleGoogleWebhook(payload, organizationId) {
  try {
    // Google webhooks are already processed in webhookController
    // This is for additional processing if needed
    const { reviewId, locationId, eventType } = payload;

    if (eventType === 'NEW_REVIEW' || eventType === 'UPDATE_REVIEW') {
      // Find the interaction that was just created
      const interaction = await Interaction.findOne({
        platformId: reviewId,
        organization: organizationId,
        platform: 'google'
      });

      return interaction;
    }

    return null;
  } catch (error) {
    logger.error('Google webhook handler error', { error: error.message, stack: error.stack });
    throw error;
  }
}

/**
 * Handle YouTube webhook
 */
async function handleYouTubeWebhook(payload, organizationId) {
  try {
    // YouTube webhooks are already processed in webhookController
    // This is for additional processing if needed
    const { commentId, videoId, eventType } = payload;

    if (eventType === 'NEW_COMMENT' || eventType === 'UPDATE_COMMENT') {
      // Find the interaction that was just created
      const interaction = await Interaction.findOne({
        platformId: commentId,
        organization: organizationId,
        platform: 'youtube'
      });

      return interaction;
    }

    return null;
  } catch (error) {
    logger.error('YouTube webhook handler error', { error: error.message, stack: error.stack });
    throw error;
  }
}

/**
 * Handle LinkedIn webhook
 * 
 * LinkedIn webhook event types:
 * - SHARE_COMMENT_CREATED: New comment on organization post
 * - SHARE_COMMENT_UPDATED: Comment edited
 * - SHARE_CREATED: New post created
 * - SHARE_LIKE_CREATED: Post liked
 */
async function handleLinkedInWebhook(payload, organizationId) {
  try {
    logger.info('💼 [LinkedIn Webhook] Processing payload', { payload });
    
    const { eventType, data } = payload;

    if (!eventType || !data) {
      logger.info('⚠️  [LinkedIn Webhook] Missing eventType or data');
      return null;
    }

    // Handle different LinkedIn event types
    switch (eventType) {
      case 'SHARE_COMMENT_CREATED':
      case 'SHARE_COMMENT_UPDATED':
        return await handleLinkedInComment(data, organizationId);
      
      case 'SHARE_CREATED':
        logger.info('💼 [LinkedIn Webhook] New share created (informational only)');
        return null; // We don't create interactions for our own posts
      
      case 'SHARE_LIKE_CREATED':
        logger.info('💼 [LinkedIn Webhook] Post liked (informational only)');
        return null; // We might want to track likes in the future
      
      default:
        logger.info(`⚠️  [LinkedIn Webhook] Unknown event type: ${eventType}`);
        return null;
    }

  } catch (error) {
    logger.error('❌ [LinkedIn Webhook] Handler error', { error: error.message, stack: error.stack });
    throw error;
  }
}

/**
 * Handle LinkedIn comment webhook data
 */
async function handleLinkedInComment(data, organizationId) {
  try {
    const {
      commentUrn,        // URN of the comment (e.g., urn:li:comment:12345)
      commentText,       // Text content of the comment
      authorUrn,         // URN of the comment author
      authorName,        // Display name of the author
      shareUrn,          // URN of the post being commented on
      shareUrl,          // URL to the LinkedIn post
      createdAt,         // Timestamp
      parentCommentUrn   // If it's a reply to another comment
    } = data;

    // Extract comment ID from URN
    const commentId = commentUrn?.split(':').pop();
    const shareId = shareUrn?.split(':').pop();
    const authorId = authorUrn?.split(':').pop();

    if (!commentId || !commentText) {
      logger.info('⚠️  [LinkedIn Webhook] Missing required comment data');
      return null;
    }

    logger.info(`💼 [LinkedIn Webhook] Processing comment: ${commentId}`);

    // Find the platform connection
    const connection = await PlatformConnection.findOne({
      platform: 'linkedin',
      organization: organizationId,
      isActive: true
    });

    if (!connection) {
      logger.info('⚠️  [LinkedIn Webhook] No active LinkedIn connection found');
      return null;
    }

    // Create or update the interaction
    const _liChatRef = await generateChatRef(organizationId).catch(() => ({ chatNumber: null, chatRef: null }));
    const interaction = await Interaction.findOneAndUpdate(
      { platformId: commentId },
      {
        $set: {
          organization: organizationId,
          platform: 'linkedin',
          platformConnection: connection._id,
          type: 'comment',
          platformId: commentId,
          content: commentText,
          author: {
            platformId: authorId,
            name: authorName || 'LinkedIn User',
            username: authorName
          },
          metadata: {
            postId: shareId,
            postUrl: shareUrl || `https://www.linkedin.com/feed/update/${shareUrn}`,
            shareUrn,
            commentUrn,
            parentCommentUrn,
            isReply: !!parentCommentUrn
          },
          threadId: parentCommentUrn || shareUrn,
          platformCreatedAt: createdAt ? new Date(createdAt) : new Date()
        },
        $setOnInsert: { status: 'unread', isRead: false, source: 'webhook', chatNumber: _liChatRef.chatNumber, chatRef: _liChatRef.chatRef }
      },
      { upsert: true, new: true }
    );

    logger.info(`✅ [LinkedIn Webhook] Interaction created/updated: ${interaction._id}`);

    return interaction;
  } catch (error) {
    logger.error('❌ [LinkedIn Comment] Processing error', { error: error.message, stack: error.stack });
    throw error;
  }
}

