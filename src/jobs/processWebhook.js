const Interaction = require('../models/Interaction');
const PlatformConnection = require('../models/PlatformConnection');
const { aiQueue } = require('../config/queue');

/**
 * Process webhook events from social media platforms
 * This job handles incoming webhook payloads and creates interactions
 */
module.exports = async function processWebhook(job) {
  try {
    const { platform, payload, organizationId } = job.data;

    console.log(`Processing webhook from ${platform} for organization ${organizationId}`);

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
        console.log(`Unknown platform: ${platform}`);
    }

    if (interaction) {
      console.log(`\n✅ [Webhook] Interaction created: ${interaction._id}`);
      console.log(`   Platform: ${interaction.platform}`);
      console.log(`   Type: ${interaction.type}`);
      console.log(`   Content: "${interaction.content?.substring(0, 100)}..."`);
      
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
      console.log(`⚠️  [Webhook] No interaction created from ${platform} webhook`);
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
 * Handle Instagram webhook
 */
async function handleInstagramWebhook(payload, organizationId) {
  try {
    const entry = payload.entry?.[0];
    if (!entry) return null;

    const changes = entry.changes || [];

    for (const change of changes) {
      if (change.field === 'comments') {
        // New comment
        const comment = change.value;

        const interaction = await Interaction.findOneAndUpdate(
          { platformId: comment.id },
          {
            organization: organizationId,
            platform: 'instagram',
            type: 'comment',
            platformId: comment.id,
            content: comment.text,
            author: {
              platformId: comment.from?.id,
              username: comment.from?.username,
              name: comment.from?.username
            },
            metadata: {
              postId: comment.media?.id,
              postUrl: `https://www.instagram.com/p/${comment.media?.id}`
            },
            platformCreatedAt: new Date(comment.timestamp),
            status: 'unread'
          },
          { upsert: true, new: true }
        );

        return interaction;
      }
      
      if (change.field === 'messages') {
        // New DM
        const message = change.value;

        const interaction = await Interaction.findOneAndUpdate(
          { platformId: message.id },
          {
            organization: organizationId,
            platform: 'instagram',
            type: 'dm',
            platformId: message.id,
            content: message.message?.text || message.text,
            author: {
              platformId: message.from.id,
              username: message.from.username
            },
            threadId: message.conversation_id,
            platformCreatedAt: new Date(message.timestamp),
            status: 'unread'
          },
          { upsert: true, new: true }
        );

        return interaction;
      }
    }

    return null;
  } catch (error) {
    console.error('Instagram webhook handler error:', error);
    throw error;
  }
}

/**
 * Handle Facebook webhook
 */
async function handleFacebookWebhook(payload, organizationId) {
  try {
    const entry = payload.entry?.[0];
    if (!entry) return null;

    const changes = entry.changes || [];

    for (const change of changes) {
      if (change.field === 'feed' && change.value.item === 'comment') {
        // New comment on post
        const comment = change.value;

        const interaction = await Interaction.findOneAndUpdate(
          { platformId: comment.comment_id },
          {
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
            platformCreatedAt: new Date(comment.created_time),
            status: 'unread'
          },
          { upsert: true, new: true }
        );

        return interaction;
      }

      if (change.field === 'conversations') {
        // New message
        const message = change.value;

        const interaction = await Interaction.findOneAndUpdate(
          { platformId: message.id },
          {
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
            platformCreatedAt: new Date(message.created_time),
            status: 'unread'
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
            organization: organizationId,
            platform: 'whatsapp',
            type: 'dm',
            platformId: message.id,
            content: message.text?.body || message.body,
            author: {
              platformId: message.from,
              name: change.value.contacts?.[0]?.profile?.name || message.from
            },
            platformCreatedAt: new Date(parseInt(message.timestamp) * 1000),
            status: 'unread'
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
        threadId: parentCommentUrn || shareUrn, // Group comments by parent or post
        platformCreatedAt: createdAt ? new Date(createdAt) : new Date(),
        status: 'unread'
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

