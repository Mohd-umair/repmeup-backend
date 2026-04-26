/**
 * Reply Service
 *
 * Single authoritative location for sending a human reply to any supported platform.
 * Encapsulates all platform-specific dispatch logic so inboxController.js stays thin.
 *
 * Exports:
 *   resolveConnection(interaction, organizationId) → connection | null
 *   sendReplyToPlatform(params)                    → { platformResponseId, status, errorMessage }
 */

const PlatformConnection = require('../models/PlatformConnection');
const googleService = require('../integrations/google/googleService');
const logger = require('../config/logger');

// ── Connection Resolution ─────────────────────────────────────────────────────

/**
 * Find the correct PlatformConnection to use when sending a reply.
 *
 * Rules (in priority order):
 *  1. Instagram DM  → match by Instagram Business Account ID (from threadPlatformId or metadata)
 *  2. Facebook DM   → match by pageId
 *  3. Other         → use interaction.platformConnection if active, else fall back to any active conn
 *
 * @param {object} interaction - Mongoose Interaction document (populated platformConnection)
 * @returns {Promise<object|null>}
 */
async function resolveConnection(interaction) {
  const orgId = interaction.organization;
  const platform = interaction.platform;

  // ── Instagram DM ─────────────────────────────────────────────────────────
  if (platform === 'instagram' && interaction.type === 'dm') {
    let igAccountId = interaction.metadata?.instagramAccountId;
    if (!igAccountId && interaction.platformId?.startsWith('dm_')) {
      igAccountId = interaction.platformId.split('_')[1];
    }
    if (igAccountId) {
      const threadOwner = await PlatformConnection.findOne({
        organization: orgId,
        platform: 'instagram',
        platformUserId: { $in: [igAccountId, String(igAccountId)] },
        status: 'connected',
        isActive: true
      }).lean();
      if (threadOwner) return threadOwner;
    }
  }

  // ── Facebook DM ──────────────────────────────────────────────────────────
  if (platform === 'facebook' && interaction.type === 'dm') {
    let facebookPageId = interaction.metadata?.facebookPageId;
    if (!facebookPageId && interaction.platformId?.startsWith('dm_')) {
      facebookPageId = interaction.platformId.split('_')[1];
    }
    if (facebookPageId) {
      const pageConn = await PlatformConnection.findOne({
        organization: orgId,
        platform: 'facebook',
        platformPageId: { $in: [String(facebookPageId), facebookPageId] },
        status: 'connected',
        isActive: true
      }).lean();
      if (pageConn) return pageConn;
    }
  }

  // ── Use populated connection from the interaction if still active ─────────
  const populated = interaction.platformConnection;
  if (populated && populated.status === 'connected' && populated.isActive) {
    return populated;
  }

  // ── Fall back: first active connection for this platform ──────────────────
  if (platform) {
    const fallback = await PlatformConnection.findOne({
      organization: orgId,
      platform,
      status: 'connected',
      isActive: true
    }).lean();
    return fallback || null;
  }

  return null;
}

// ── Platform Dispatch ─────────────────────────────────────────────────────────

/**
 * Send a reply to the appropriate platform.
 *
 * @param {object} params
 * @param {object}  params.interaction        - Mongoose Interaction document
 * @param {object}  params.connection         - Resolved PlatformConnection (use resolveConnection first)
 * @param {string}  params.replyContent       - Text to send
 * @param {string}  [params.attachmentUrl]    - CDN / server URL of the attachment
 * @param {string}  [params.attachmentType]   - 'image' | 'video' | 'audio' | 'file'
 * @param {string}  [params.attachmentLocalPath] - Absolute disk path (preferred over URL for Meta APIs)
 *
 * @returns {Promise<{ platformResponseId: string|null, status: 'sent'|'failed', errorMessage: string|null }>}
 */
async function sendReplyToPlatform({
  interaction,
  connection,
  replyContent,
  attachmentUrl,
  attachmentType,
  attachmentLocalPath
}) {
  // Guard: connection missing or inactive
  if (!connection) {
    const igAccountId = interaction.metadata?.instagramAccountId
      || (interaction.platformId?.startsWith('dm_') ? interaction.platformId.split('_')[1] : null);
    const fbPageId = interaction.metadata?.facebookPageId
      || (interaction.platformId?.startsWith('dm_') && interaction.platform === 'facebook'
        ? interaction.platformId.split('_')[1] : null);

    let errorMessage = 'Platform connection not found. Please reconnect this account in Settings.';
    if (interaction.platform === 'instagram' && interaction.type === 'dm') {
      errorMessage = igAccountId
        ? 'Could not find the Instagram account for this conversation. Please reconnect it in Settings.'
        : 'This conversation is not linked to an Instagram account. Sync the Instagram that receives these DMs from Settings, then try again.';
    } else if (interaction.platform === 'facebook' && interaction.type === 'dm') {
      errorMessage = fbPageId
        ? 'Could not find the Facebook Page for this conversation. Please reconnect it in Settings.'
        : 'This conversation is not linked to a Facebook Page. Reconnect the Page that receives these messages in Settings.';
    }
    return { platformResponseId: null, status: 'failed', errorMessage };
  }

  if (!connection.isActive || connection.status !== 'connected') {
    return {
      platformResponseId: null,
      status: 'failed',
      errorMessage: 'Platform connection is not active. Please reconnect this account in Settings.'
    };
  }

  try {
    switch (interaction.platform) {

      // ── YouTube ──────────────────────────────────────────────────────────
      case 'youtube': {
        const youtubeService = require('../integrations/google/youtubeService');
        const result = await youtubeService.replyToComment(connection, interaction.platformId, replyContent);
        if (result.success && result.commentId) {
          return { platformResponseId: result.commentId, status: 'sent', errorMessage: null };
        }
        return { platformResponseId: null, status: 'failed', errorMessage: 'Failed to post reply to YouTube' };
      }

      // ── Instagram ────────────────────────────────────────────────────────
      case 'instagram': {
        const instagramService = require('../integrations/meta/instagramService');
        const connType = connection.metadata?.connectionType
          || (typeof connection.accessToken === 'string' && connection.accessToken.startsWith('IGAA')
            ? 'instagram_login' : null);

        let result;
        if (interaction.type === 'dm') {
          let pageId;
          if (connType === 'instagram_login') {
            pageId = connection.metadata?.igLoginScopedId || connection.platformUserId;
          } else {
            pageId = connection.platformPageId || connection.platformData?.pageId;
            const resolvedFromToken = await instagramService.getPageIdFromToken(connection.accessToken);
            if (resolvedFromToken) pageId = resolvedFromToken;
          }

          const recipientId = interaction.author?.platformId;
          logger.info('[replyService] Instagram DM send', { pageId, connType, hasRecipient: !!recipientId });

          if (!pageId || !recipientId) {
            return {
              platformResponseId: null,
              status: 'failed',
              errorMessage: 'Missing page or recipient for Instagram DM reply. Reconnect this Instagram account in Settings → Platforms.'
            };
          }

          if (attachmentUrl && attachmentType) {
            result = await instagramService.sendMessageWithAttachment(
              recipientId, attachmentType, attachmentUrl, replyContent || undefined,
              connection.accessToken, pageId, true, attachmentLocalPath, connType
            );
          } else {
            result = await instagramService.sendMessage(
              recipientId, replyContent, connection.accessToken, pageId, true, connType
            );
          }
        } else {
          result = await instagramService.replyToComment(
            interaction.platformId, replyContent, connection.accessToken, connType
          );
        }

        if (result?.success && result.platformResponseId) {
          return { platformResponseId: result.platformResponseId, status: 'sent', errorMessage: null };
        }
        return { platformResponseId: null, status: 'failed', errorMessage: result?.error || 'Failed to post reply to Instagram' };
      }

      // ── Facebook ─────────────────────────────────────────────────────────
      case 'facebook': {
        const facebookService = require('../integrations/meta/facebookService');
        let result;
        if (interaction.type === 'dm') {
          const pageId = connection.platformPageId || connection.platformData?.pageId;
          const recipientId = interaction.author?.platformId;
          if (!pageId || !recipientId) {
            return {
              platformResponseId: null,
              status: 'failed',
              errorMessage: 'Missing Page or recipient for Facebook Messenger reply. Reconnect the Page in Settings.'
            };
          }
          if (attachmentUrl && attachmentType) {
            result = await facebookService.sendMessageWithAttachment(
              recipientId, attachmentType, attachmentUrl, replyContent || undefined,
              connection.accessToken, pageId, true, attachmentLocalPath
            );
          } else {
            result = await facebookService.sendMessage(
              recipientId, replyContent, connection.accessToken, pageId, true
            );
          }
        } else {
          result = await facebookService.replyToComment(connection, interaction.platformId, replyContent);
        }
        if (result?.success && (result.platformResponseId || result.commentId)) {
          return { platformResponseId: result.platformResponseId || result.commentId, status: 'sent', errorMessage: null };
        }
        return { platformResponseId: null, status: 'failed', errorMessage: result?.error || 'Failed to post reply to Facebook' };
      }

      // ── LinkedIn ─────────────────────────────────────────────────────────
      case 'linkedin': {
        const linkedinService = require('../integrations/linkedin/linkedinService');
        const result = await linkedinService.replyToComment(connection, interaction._id, replyContent);
        if (result.status === 'sent' && result.platformResponseId) {
          return { platformResponseId: result.platformResponseId, status: 'sent', errorMessage: null };
        }
        return { platformResponseId: null, status: 'failed', errorMessage: result.error || 'Failed to post reply to LinkedIn' };
      }

      // ── WhatsApp ─────────────────────────────────────────────────────────
      case 'whatsapp': {
        const whatsappService = require('../integrations/whatsapp/whatsappService');
        const result = await whatsappService.sendTextMessage(
          connection, interaction.author.platformId, replyContent
        );
        if (result.success && result.messageId) {
          return { platformResponseId: result.messageId, status: 'sent', errorMessage: null };
        }
        return { platformResponseId: null, status: 'failed', errorMessage: 'Failed to send WhatsApp message' };
      }

      // ── Email (Gmail / Outlook / IMAP) ───────────────────────────────────
      case 'email': {
        const emailReplyService = require('./email/emailReplyService');
        return await emailReplyService.sendEmailReply(interaction, replyContent);
      }

      // ── Google Review ────────────────────────────────────────────────────
      case 'google': {
        if (interaction.type !== 'review') {
          return { platformResponseId: null, status: 'failed', errorMessage: `Replies for google ${interaction.type} are not yet implemented` };
        }
        const locationId = interaction.metadata?.locationId;
        const reviewId = interaction.metadata?.reviewId || interaction.platformId;
        if (!locationId || !reviewId) {
          return { platformResponseId: null, status: 'failed', errorMessage: 'Missing location or review ID for Google review reply.' };
        }
        await googleService.ensureValidToken(connection);
        await googleService.replyToReview(connection, locationId, reviewId, replyContent);
        return { platformResponseId: `google-review-${reviewId}`, status: 'sent', errorMessage: null };
      }

      default:
        return {
          platformResponseId: null,
          status: 'failed',
          errorMessage: `Replies for ${interaction.platform} are not yet implemented`
        };
    }
  } catch (platformError) {
    const metaError = platformError.response?.data?.error || platformError.platformError;
    const metaUserMsg = metaError?.error_user_msg || metaError?.message;

    logger.error('[replyService] Platform send error', {
      platform: interaction.platform,
      error: metaUserMsg || platformError.message
    });

    // Instagram "not the thread owner" — give a clear, actionable message
    if (metaError?.code === 100 && metaError?.error_subcode === 2534037) {
      return {
        platformResponseId: null,
        status: 'failed',
        errorMessage: 'This conversation belongs to a different Instagram account. Reconnect the Instagram account that receives these DMs in Settings → Platforms, then try again.'
      };
    }

    return {
      platformResponseId: null,
      status: 'failed',
      errorMessage: metaUserMsg || platformError.message || 'Failed to post reply to platform'
    };
  }
}

module.exports = { resolveConnection, sendReplyToPlatform };
