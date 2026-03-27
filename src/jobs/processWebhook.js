const Interaction = require('../models/Interaction');
const PlatformConnection = require('../models/PlatformConnection');
const { aiQueue } = require('../config/queue');
const logger = require('../config/logger');
const instagramService = require('../integrations/meta/instagramService');
const { emitToOrg } = require('../utils/socketEmitter');
const cacheService = require('../services/cacheService');
const { isThreadStyleDm } = require('../utils/interactionThreadDm');

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
        interaction = await handleInstagramWebhook(payload, organizationId);
        break;
      
      case 'facebook':
        interaction = await handleFacebookWebhook(payload, organizationId);
        break;
      
      case 'whatsapp':
        interaction = await handleWhatsAppWebhook(payload, organizationId);
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

      // Invalidate inbox list cache so next GET /api/inbox returns this interaction (fixes DMs not showing until refresh/sync)
      if (organizationId) {
        cacheService.delPattern(`interactions:${organizationId}*`).catch(err => {
          jobLogger.warn('Failed to invalidate inbox cache', { err: err?.message });
        });
      }

      // Per-comment / per-message interactions: skip if we already answered that item.
      // DM threads (platformId dm_*_*): one doc per conversation — replies[] is thread history; still queue AI for each new message.
      const hasReplies = interaction.replies && interaction.replies.length > 0;
      const isAlreadyReplied = interaction.status === 'replied' || interaction.status === 'resolved';
      const threadDm = isThreadStyleDm(interaction);

      if (!threadDm && (hasReplies || isAlreadyReplied)) {
        console.log(`⏭️  [Webhook] Skipping AI and auto-reply queue - interaction already replied to (status: ${interaction.status}, replies: ${interaction.replies?.length || 0})`);
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

        console.log(`📝 [Webhook] Queued for AI processing: ${interaction._id}${threadDm && mid ? ` (mid ${mid})` : ''}`);

        // Queue auto-reply if webhook mode is enabled
        const autoReplyScheduler = require('../services/autoReplyScheduler');
        const queued = await autoReplyScheduler.queueImmediateAutoReply(
          interaction._id,
          organizationId
        );

        if (queued) {
          console.log(`🤖 [Webhook] Auto-reply queued for interaction: ${interaction._id}`);
        } else {
          console.log(`⚠️  [Webhook] Auto-reply NOT queued (check trigger mode settings)`);
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
    console.error('Webhook processing error:', error);
    throw error;
  }
};

/**
 * Fetch Instagram commenter/DM author profile (username, name, avatar) for inbox display.
 * Uses Instagram User Profile API; webhook only sends sender.id, not username/name.
 * For DMs, pass accessToken of the Instagram connection that *received* the message (required by Meta).
 * Returns { username, name, avatarUrl } or partial; missing fields left undefined.
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
      console.warn('[processWebhook] fetchInstagramAuthorProfile: connection lookup failed', e.message);
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
    console.warn('[processWebhook] fetchInstagramAuthorProfile failed for igUserId=', igUserId, e.message);
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

/**
 * Handle Instagram webhook
 * Supports two payload formats:
 * 1. Graph API (comments): entry[].changes[] with field "comments" or "messages"
 * 2. Instagram Messaging (DMs): entry[].messaging[] - used by Meta for DM webhooks
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
      const conn = await PlatformConnection.findOne({
        organization: organizationId,
        platform: 'instagram',
        platformUserId: { $in: [String(igAccountId), igAccountId].filter(Boolean) },
        status: { $in: ['connected', 'available'] },
        isActive: true
      }).select('_id accessToken').lean();
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
      logger.info('[processWebhook] Instagram: no messaging or standby events', {
        entryId: entry.id,
        hasChanges: !!(entry.changes && entry.changes.length)
      });
    }

    // One conversation thread per sender: platformId = dm_igAccountId_senderId (not per-message mid)
    for (const event of allMessageEvents) {
      const message = event.message;
      if (!message) {
        // message_edit, reaction, read, etc. — skip (or could update thread in future)
        continue;
      }
      if (message.is_echo || message.is_deleted || message.is_unsupported) {
        logger.info('[processWebhook] Instagram: skipping message', {
          is_echo: !!message.is_echo,
          is_deleted: !!message.is_deleted,
          is_unsupported: !!message.is_unsupported
        });
        continue;
      }

      const senderId = event.sender?.id;
      const mid = message.mid;
      const attachment = message.attachments && message.attachments[0] ? message.attachments[0] : null;
      const attachmentType = attachment ? (attachment.type || 'file') : null;
      const attachmentUrl = attachment && attachment.payload && attachment.payload.url ? attachment.payload.url : null;
      const text = message.text || (attachment ? `[${attachmentType}]` : '');
      if (!mid || !senderId) {
        logger.warn('[processWebhook] Instagram: message missing mid or senderId', { mid: !!mid, senderId: !!senderId });
        continue;
      }

      // Webhook only sends sender.id; fetch username/name/profile_pic from Instagram User Profile API.
      // Must use the token of the IG account that *received* the DM (Meta requirement).
      const profile = await fetchInstagramAuthorProfile(
        organizationId,
        senderId,
        dmReceiverConnection?.accessToken || null
      );
      if (!profile.username && !profile.name && !profile.avatarUrl) {
        // Expected when app lacks Advanced Access; interaction is still created with platformId
        logger.debug('[processWebhook] Instagram DM: no profile for senderId', { senderId, hasReceiverToken: !!dmReceiverConnection?.accessToken });
      }
      const author = {
        platformId: senderId,
        username: profile.username,
        name: profile.name || profile.username || 'Instagram User'
      };
      if (profile.avatarUrl) author.avatarUrl = profile.avatarUrl;

      // One thread per conversation (IG account + sender), not per message
      const threadPlatformId = `dm_${String(igAccountId)}_${String(senderId)}`;
      const existing = await Interaction.findOne({ platformId: threadPlatformId }).select('_id metadata.lastMid author').lean();
      if (existing && existing.metadata?.lastMid === mid) {
        // Meta webhook retry — do not re-queue AI / auto-reply
        logger.debug('[processWebhook] Instagram DM duplicate mid (webhook retry)', { threadPlatformId, mid });
        return null;
      }

      // Always update author so profile pic / username show up once the API returns them.
      // If the profile fetch returned richer data than what's stored, overwrite.
      const existingAuthor = existing?.author || {};
      const mergedAuthor = {
        platformId: senderId,
        username: profile.username || existingAuthor.username || undefined,
        name: profile.name || existingAuthor.name || profile.username || existingAuthor.username || 'Instagram User'
      };
      if (profile.avatarUrl) mergedAuthor.avatarUrl = profile.avatarUrl;
      else if (existingAuthor.avatarUrl) mergedAuthor.avatarUrl = existingAuthor.avatarUrl;

      const updateFields = {
        organization: organizationId,
        platform: 'instagram',
        type: 'dm',
        platformId: threadPlatformId,
        content: text,
        author: mergedAuthor,
        threadId: senderId,
        platformCreatedAt: new Date(event.timestamp),
        'metadata.lastMid': mid,
        'metadata.instagramAccountId': igAccountId,
        status: 'unread',
        isRead: false
      };
      if (platformConnectionId) updateFields.platformConnection = platformConnectionId;

      // Step 1: Upsert the thread (create or update non-message fields)
      // Do not put status/isRead in $setOnInsert — they are already in $set (MongoDB conflicts same path in both operators)
      await Interaction.findOneAndUpdate(
        { platformId: threadPlatformId },
        { $set: updateFields },
        { upsert: true }
      );

      // Step 2: Only append message if this mid is not already in the array.
      // This prevents duplicates when Meta retries the same webhook event.
      const incomingMsg = { mid, text, timestamp: event.timestamp };
      if (attachmentUrl) incomingMsg.attachmentUrl = attachmentUrl;
      if (attachmentType) incomingMsg.attachmentType = attachmentType;
      await Interaction.updateOne(
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
        // Skip our own replies: when the connected IG account replies, from.id equals the account id.
        if (comment.from && String(comment.from.id) === String(igAccountId)) {
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

        const updatePayload = {
          organization: organizationId,
          platform: 'instagram',
          type: 'comment',
          platformId: comment.id,
          content: comment.text,
          author,
          metadata: {
            postId: comment.media?.id,
            postUrl: `https://www.instagram.com/p/${comment.media?.id}`
          },
          platformCreatedAt
        };
        if (isReply && parentCommentId) {
          updatePayload.parentId = parentCommentId; // So this reply shows in the parent thread, not as new conversation
        }

        const interaction = await Interaction.findOneAndUpdate(
          { platformId: comment.id },
          {
            $set: updatePayload,
            $setOnInsert: { status: 'unread', isRead: false }
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
        logger.info('[processWebhook] Instagram mention received', { mention, entryId: igAccountId });

        const mentionId =
          mention.comment_id ||
          mention.id ||
          mention.media_id ||
          `${igAccountId}_${mention.timestamp || entry.time || Date.now()}`;

        // ----------------------------------------------------------------
        // Enrich mention with actual text and author via Instagram Graph API.
        // The webhook only delivers media_id + comment_id — the actual comment
        // text lives on someone else's media so it is NOT readable via
        // GET /{comment_id}. The correct endpoints are:
        //   comment mention → GET /{ig-user-id}/mentioned_comment
        //   caption mention → GET /{ig-user-id}/mentioned_media
        // ----------------------------------------------------------------
        let enrichedText = null;
        let enrichedUsername = null;
        let enrichedTimestamp = null;
        let mediaUrl = null;
        let permalinkUrl = null;

        const accessToken = dmReceiverConnection?.accessToken;
        if (accessToken && igAccountId) {
          const axios = require('axios');
          const graphBase = 'https://graph.facebook.com/v18.0';

          // Case 1: mentioned in a comment (comment_id present)
          if (mention.comment_id && mention.media_id) {
            try {
              const resp = await axios.get(`${graphBase}/${igAccountId}/mentioned_comment`, {
                params: {
                  fields: 'text,timestamp,username',
                  commented_media_id: mention.media_id,
                  comment_id: mention.comment_id,
                  access_token: accessToken
                }
              });
              enrichedText = resp.data.text || null;
              enrichedTimestamp = resp.data.timestamp || null;
              enrichedUsername = resp.data.username || null;
              logger.info('[processWebhook] Mention comment fetched', { text: enrichedText, username: enrichedUsername });
            } catch (e) {
              logger.warn('[processWebhook] mentioned_comment fetch failed', {
                commentId: mention.comment_id,
                mediaId: mention.media_id,
                err: e.response?.data?.error?.message || e.message
              });
            }
          }

          // Case 2: mentioned in media caption (only media_id, no comment_id)
          if (mention.media_id && !enrichedText) {
            try {
              const resp = await axios.get(`${graphBase}/${igAccountId}/mentioned_media`, {
                params: {
                  fields: 'caption,media_url,permalink,timestamp,username',
                  media_id: mention.media_id,
                  access_token: accessToken
                }
              });
              enrichedText = resp.data.caption || null;
              enrichedTimestamp = enrichedTimestamp || resp.data.timestamp || null;
              enrichedUsername = enrichedUsername || resp.data.username || null;
              mediaUrl = resp.data.media_url || null;
              permalinkUrl = resp.data.permalink || null;
              logger.info('[processWebhook] Mention media fetched', { caption: enrichedText, permalink: permalinkUrl });
            } catch (e) {
              logger.warn('[processWebhook] mentioned_media fetch failed', {
                mediaId: mention.media_id,
                err: e.response?.data?.error?.message || e.message
              });
            }
          }
        }

        // Build author from enriched data or fall back to webhook payload
        const authorUsername = enrichedUsername || mention.from?.username || mention.username || 'Instagram User';
        const authorId = mention.from?.id || mention.user_id || null;
        const avatarUrl = authorId ? await fetchInstagramAuthorAvatar(organizationId, authorId) : null;
        const author = {
          platformId: authorId,
          username: authorUsername,
          name: authorUsername
        };
        if (avatarUrl) author.avatarUrl = avatarUrl;

        const mentionText =
          enrichedText ||
          mention.text ||
          mention.caption ||
          mention.message ||
          (mention.media_id ? `You were mentioned on Instagram by @${authorUsername}.` : 'You were mentioned on Instagram.');

        const rawTs = enrichedTimestamp ?? mention.timestamp ?? mention.created_time ?? entry.time;
        let mentionCreatedAt = new Date();
        if (rawTs != null) {
          const ms = typeof rawTs === 'number' ? (rawTs < 1e12 ? rawTs * 1000 : rawTs) : Date.parse(rawTs);
          if (Number.isFinite(ms)) mentionCreatedAt = new Date(ms);
        }

        const metadataSet = {
          mentionId: mention.id || null,
          mediaId: mention.media_id || null,
          commentId: mention.comment_id || null,
          postId: mention.media_id || null,
          postUrl: permalinkUrl || (mention.media_id ? `https://www.instagram.com/p/${mention.media_id}` : null),
          rawMention: mention
        };
        if (mediaUrl) metadataSet.mediaUrl = mediaUrl;

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
              metadata: metadataSet
            },
            $setOnInsert: { status: 'unread', isRead: false }
          },
          { upsert: true, new: true }
        );

        if (interaction && organizationId) {
          emitToOrg(organizationId.toString(), 'new_interaction', {
            interaction: interaction.toObject()
          });
        }

        logger.info('[processWebhook] Instagram mention saved', { interactionId: interaction?._id, text: mentionText, author: authorUsername });
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
            $setOnInsert: { status: 'unread', isRead: false }
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
    console.error('Instagram webhook handler error:', error);
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
      const existing = await Interaction.findOne({ platformId: threadPlatformId }).select('_id metadata.lastMid').lean();
      if (existing && existing.metadata?.lastMid === mid) {
        logger.debug('[processWebhook] Facebook DM duplicate mid (webhook retry)', { threadPlatformId, mid });
        return null;
      }

      const incomingMsg = { mid, text, timestamp: event.timestamp };
      if (attachmentUrl) incomingMsg.attachmentUrl = attachmentUrl;
      if (attachmentType) incomingMsg.attachmentType = attachmentType;

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

      const interaction = await Interaction.findOneAndUpdate(
        { platformId: threadPlatformId },
        {
          $set: updateFields,
          $push: {
            'metadata.incomingMessages': {
              $each: [incomingMsg],
              $slice: -100
            }
          }
        },
        { upsert: true, new: true }
      );
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

        const interaction = await Interaction.findOneAndUpdate(
          { platformId: comment.comment_id },
          {
            $set: updateFields,
            $setOnInsert: { status: 'unread', isRead: false }
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
            $setOnInsert: { status: 'unread', isRead: false }
          },
          { upsert: true, new: true }
        );

        return interaction;
      }
    }

    return null;
  } catch (error) {
    console.error('Facebook webhook handler error:', error);
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
      console.warn('[processWebhook] fetchFacebookSenderProfile failed for psid=', psid,
        err.response?.data?.error?.message || err.message);
    }
    return {};
  }
}

/**
 * Handle WhatsApp webhook
 */
async function handleWhatsAppWebhook(payload, organizationId) {
  try {
    const entry = payload.entry?.[0];
    if (!entry) return null;

    const changes = entry.changes || [];

    for (const change of changes) {
      if (change.value.messages) {
        const message = change.value.messages[0];

        const interaction = await Interaction.findOneAndUpdate(
          { platformId: message.id },
          {
            $set: {
              organization: organizationId,
              platform: 'whatsapp',
              type: 'dm',
              platformId: message.id,
              content: message.text?.body || message.body,
              author: {
                platformId: message.from,
                name: change.value.contacts?.[0]?.profile?.name || message.from
              },
              platformCreatedAt: new Date(parseInt(message.timestamp) * 1000)
            },
            $setOnInsert: { status: 'unread', isRead: false }
          },
          { upsert: true, new: true }
        );

        return interaction;
      }
    }

    return null;
  } catch (error) {
    console.error('WhatsApp webhook handler error:', error);
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
    console.error('Google webhook handler error:', error);
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
    console.error('YouTube webhook handler error:', error);
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
    console.log('💼 [LinkedIn Webhook] Processing payload:', JSON.stringify(payload, null, 2));
    
    const { eventType, data } = payload;

    if (!eventType || !data) {
      console.log('⚠️  [LinkedIn Webhook] Missing eventType or data');
      return null;
    }

    // Handle different LinkedIn event types
    switch (eventType) {
      case 'SHARE_COMMENT_CREATED':
      case 'SHARE_COMMENT_UPDATED':
        return await handleLinkedInComment(data, organizationId);
      
      case 'SHARE_CREATED':
        console.log('💼 [LinkedIn Webhook] New share created (informational only)');
        return null; // We don't create interactions for our own posts
      
      case 'SHARE_LIKE_CREATED':
        console.log('💼 [LinkedIn Webhook] Post liked (informational only)');
        return null; // We might want to track likes in the future
      
      default:
        console.log(`⚠️  [LinkedIn Webhook] Unknown event type: ${eventType}`);
        return null;
    }

  } catch (error) {
    console.error('❌ [LinkedIn Webhook] Handler error:', error);
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
      console.log('⚠️  [LinkedIn Webhook] Missing required comment data');
      return null;
    }

    console.log(`💼 [LinkedIn Webhook] Processing comment: ${commentId}`);

    // Find the platform connection
    const connection = await PlatformConnection.findOne({
      platform: 'linkedin',
      organization: organizationId,
      isActive: true
    });

    if (!connection) {
      console.log('⚠️  [LinkedIn Webhook] No active LinkedIn connection found');
      return null;
    }

    // Create or update the interaction
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
        $setOnInsert: { status: 'unread', isRead: false }
      },
      { upsert: true, new: true }
    );

    console.log(`✅ [LinkedIn Webhook] Interaction created/updated: ${interaction._id}`);

    return interaction;
  } catch (error) {
    console.error('❌ [LinkedIn Comment] Processing error:', error);
    throw error;
  }
}

