const Interaction = require('../models/Interaction');
const PlatformConnection = require('../models/PlatformConnection');
const { aiQueue } = require('../config/queue');
const logger = require('../config/logger');
const instagramService = require('../integrations/meta/instagramService');

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
      
      // IMPORTANT: Check if interaction already has replies
      // If it does, skip auto-reply queueing (it's already been replied to)
      const hasReplies = interaction.replies && interaction.replies.length > 0;
      const isAlreadyReplied = interaction.status === 'replied' || interaction.status === 'resolved';
      
      if (hasReplies || isAlreadyReplied) {
        console.log(`⏭️  [Webhook] Skipping AI and auto-reply queue - interaction already replied to (status: ${interaction.status}, replies: ${interaction.replies?.length || 0})`);
      } else {
        // Trigger AI processing (only for new, unreplied interactions)
        await aiQueue.add({
          interactionId: interaction._id
        }, {
          attempts: 3,
          backoff: 2000,
          jobId: `ai-${interaction._id}` // Use unique job ID to prevent duplicates
        });

        console.log(`📝 [Webhook] Queued for AI processing: ${interaction._id}`);

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
      const text = message.text || (message.attachments && message.attachments[0] ? `[${message.attachments[0].type || 'attachment'}]` : '');
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
      const existing = await Interaction.findOne({ platformId: threadPlatformId }).select('_id metadata.lastMid').lean();
      if (existing && existing.metadata?.lastMid === mid) {
        return await Interaction.findById(existing._id);
      }

      const updateFields = {
        organization: organizationId,
        platform: 'instagram',
        type: 'dm',
        platformId: threadPlatformId,
        content: text,
        author,
        threadId: senderId,
        platformCreatedAt: new Date(event.timestamp),
        'metadata.lastMid': mid,
        'metadata.instagramAccountId': igAccountId
      };
      if (platformConnectionId) updateFields.platformConnection = platformConnectionId;

      const interaction = await Interaction.findOneAndUpdate(
        { platformId: threadPlatformId },
        {
          $set: updateFields,
          $setOnInsert: { status: 'unread', isRead: false },
          $push: {
            'metadata.incomingMessages': {
              $each: [{ mid, text, timestamp: event.timestamp }],
              $slice: -100
            }
          }
        },
        { upsert: true, new: true }
      );
      return interaction;
    }

    // --- Graph API format: entry.changes[] (comments, or legacy "messages") ---
    const changes = entry.changes || [];
    for (const change of changes) {
      if (change.field === 'comments') {
        // New comment: fetch commenter profile for inbox avatar
        const comment = change.value;
        const authorId = comment.from?.id;
        const avatarUrl = await fetchInstagramAuthorAvatar(organizationId, authorId);
        const author = {
          platformId: authorId,
          username: comment.from?.username,
          name: comment.from?.username
        };
        if (avatarUrl) author.avatarUrl = avatarUrl;

        const interaction = await Interaction.findOneAndUpdate(
          { platformId: comment.id },
          {
            $set: {
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
              platformCreatedAt: new Date(comment.timestamp)
            },
            $setOnInsert: { status: 'unread', isRead: false }
          },
          { upsert: true, new: true }
        );

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
              platformCreatedAt: new Date(message.timestamp)
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
      const text = message.text || (message.attachments && message.attachments[0] ? `[${message.attachments[0].type || 'attachment'}]` : '');
      if (!mid || !senderId) continue;

      const profile = await fetchFacebookSenderProfile(organizationId, pageId, senderId, pageConnection?.accessToken);
      const author = {
        platformId: senderId,
        username: profile.name || 'Messenger User',
        name: profile.name || 'Messenger User'
      };
      if (profile.profilePic) author.avatarUrl = profile.profilePic;

      const threadPlatformId = `dm_${String(pageId)}_${String(senderId)}`;
      const existing = await Interaction.findOne({ platformId: threadPlatformId }).select('_id metadata.lastMid').lean();
      if (existing && existing.metadata?.lastMid === mid) {
        return await Interaction.findById(existing._id);
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
        'metadata.facebookPageId': pageId
      };
      if (platformConnectionId) updateFields.platformConnection = platformConnectionId;

      const interaction = await Interaction.findOneAndUpdate(
        { platformId: threadPlatformId },
        {
          $set: updateFields,
          $setOnInsert: { status: 'unread', isRead: false },
          $push: {
            'metadata.incomingMessages': {
              $each: [{ mid, text, timestamp: event.timestamp }],
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
        // New comment on post
        const comment = change.value;

        const interaction = await Interaction.findOneAndUpdate(
          { platformId: comment.comment_id },
          {
            $set: {
              organization: organizationId,
              platform: 'facebook',
              type: 'comment',
              platformId: comment.comment_id,
              content: comment.message,
              author: {
                platformId: comment.from.id,
                name: comment.from.name
              },
              metadata: {
                postId: comment.post_id,
                postUrl: `https://www.facebook.com/${comment.post_id}`
              },
              platformCreatedAt: new Date(comment.created_time)
            },
            $setOnInsert: { status: 'unread', isRead: false }
          },
          { upsert: true, new: true }
        );

        return interaction;
      }

      if (change.field === 'conversations') {
        // Legacy format: New message
        const message = change.value;

        const interaction = await Interaction.findOneAndUpdate(
          { platformId: message.id },
          {
            $set: {
              organization: organizationId,
              platform: 'facebook',
              type: 'dm',
              platformId: message.id,
              content: message.message,
              author: {
                platformId: message.from.id,
                name: message.from.name
              },
              threadId: message.thread_id,
              platformCreatedAt: new Date(message.created_time)
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
 * Fetch Facebook Messenger sender profile (name, profile_pic) for PSID.
 * Uses Graph API GET /{psid}?fields=name,profile_pic with Page access token.
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
    const baseUrl = `https://graph.facebook.com/v18.0`;
    const res = await axios.get(`${baseUrl}/${psid}`, {
      params: { fields: 'name,first_name,last_name,profile_pic', access_token: token },
      timeout: 5000
    });
    const data = res.data || {};
    const name = data.name || (data.first_name && data.last_name ? `${data.first_name} ${data.last_name}`.trim() : data.first_name || data.last_name);
    return {
      name: name || undefined,
      profilePic: data.profile_pic || undefined
    };
  } catch (err) {
    console.warn('[processWebhook] fetchFacebookSenderProfile failed for psid=', psid, err.response?.data?.error?.message || err.message);
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

