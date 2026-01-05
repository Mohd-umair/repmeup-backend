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
      
      default:
        console.log(`Unknown platform: ${platform}`);
    }

    if (interaction) {
      // Trigger AI processing
      await aiQueue.add({
        interactionId: interaction._id
      }, {
        attempts: 3,
        backoff: 2000
      });

      console.log(`Interaction created and queued for AI processing: ${interaction._id}`);
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

