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
 * @param {object} [params.whatsappTemplate] - Sanitized `{ name, languageCode, components }` for template send
 *
 * @returns {Promise<{ platformResponseId: string|null, status: 'sent'|'failed', errorMessage: string|null }>}
 */
async function sendReplyToPlatform({
  interaction,
  connection,
  replyContent,
  attachmentUrl,
  attachmentType,
  attachmentLocalPath,
  whatsappTemplate
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
          const commentText =
            replyContent == null || replyContent === undefined
              ? ''
              : String(replyContent).trim();
          if (!commentText) {
            const hasAttachment = !!(attachmentUrl && attachmentType);
            return {
              platformResponseId: null,
              status: 'failed',
              errorMessage: hasAttachment
                ? 'Instagram public comment replies need text. File or media attachments are not supported on comment replies through this API—add a message, or use DM if messaging is available.'
                : 'Instagram comment replies cannot be empty. Enter a message and try again.'
            };
          }

          // Route replies to product-linked-post comments through Private Reply
          // (DM) so price, checkout links, and product-specific copy never appear
          // publicly in the comments thread.
          const {
            isCommentOnProductLinkedPost,
            resolveInstagramPrivateReplyPageId
          } = require('./instagramCommentReplyRouter');

          const Organization = require('../models/Organization');
          const orgId = interaction.organization?.toString?.() || interaction.organization;
          const orgSettings = await Organization.findById(orgId)
            .select('commentToDmSettings.forcePrivateReplyForLinkedProducts')
            .lean();
          const forcePrivate =
            orgSettings?.commentToDmSettings?.forcePrivateReplyForLinkedProducts !== false;

          const usePrivateReply =
            forcePrivate &&
            await isCommentOnProductLinkedPost(interaction, orgId, { forcePrivateReply: forcePrivate });

          if (usePrivateReply) {
            const pageId = resolveInstagramPrivateReplyPageId(connection, connType);
            if (!pageId) {
              return {
                platformResponseId: null,
                status: 'failed',
                errorMessage: 'Could not resolve Instagram Page ID for private reply. Reconnect this account in Settings → Platforms.'
              };
            }
            try {
              result = await instagramService.sendPrivateReply(
                interaction.platformId, commentText, connection.accessToken, pageId, connType
              );
            } catch (privateErr) {
              // Do NOT silently fall back to public comment: the reply may contain
              // price or checkout links. Surface the error so the agent can act.
              const errMsg = privateErr.message || 'Private reply failed';
              logger.warn('[replyService] Instagram private reply failed — not falling back to public comment', {
                interactionId: interaction._id?.toString(),
                error: errMsg,
                platformError: privateErr.platformError
              });
              return {
                platformResponseId: null,
                status: 'failed',
                errorMessage: `Could not send as private DM — the Instagram 7-day reply window may have expired, or the account needs reconnecting. (${errMsg})`
              };
            }
          } else {
            result = await instagramService.replyToComment(
              interaction.platformId, commentText, connection.accessToken, connType
            );
          }
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
        const fs = require('fs');
        const path = require('path');
        const os = require('os');
        const to = interaction.author.platformId;

        if (whatsappTemplate?.name) {
          let result;
          try {
            result = await whatsappService.sendTemplateMessage(
              connection,
              to,
              whatsappTemplate.name,
              whatsappTemplate.languageCode || 'en_US',
              whatsappTemplate.components || []
            );
          } catch (templateErr) {
            const msg =
              templateErr?.response?.data?.error?.message ||
              templateErr?.response?.data?.error?.error_user_msg ||
              templateErr?.message ||
              'Failed to send WhatsApp template';
            return {
              platformResponseId: null,
              status: 'failed',
              errorMessage: typeof msg === 'string' ? msg : 'Failed to send WhatsApp template'
            };
          }
          if (result.success && result.messageId) {
            return { platformResponseId: result.messageId, status: 'sent', errorMessage: null };
          }
          return { platformResponseId: null, status: 'failed', errorMessage: 'Failed to send WhatsApp template' };
        }

        const hasMedia =
          attachmentType &&
          ['image', 'video', 'audio', 'file'].includes(attachmentType) &&
          !!(attachmentLocalPath || attachmentUrl);

        if (hasMedia) {
          const waCaptionRequired = ['image', 'video', 'file'].includes(attachmentType);
          const captionRaw = replyContent == null || replyContent === undefined ? '' : String(replyContent).trim();
          const looksLikePlaceholder = /^\[(image|video|audio|file|attachment)\]$/i.test(captionRaw);
          if (waCaptionRequired && (!captionRaw || looksLikePlaceholder)) {
            return {
              platformResponseId: null,
              status: 'failed',
              errorMessage:
                'WhatsApp requires a message to send with images, videos, or files. Enter text in the message field and try again.'
            };
          }

          const waUploadType = attachmentType === 'file' ? 'document' : attachmentType;
          let localPath = attachmentLocalPath && fs.existsSync(attachmentLocalPath) ? attachmentLocalPath : null;
          let tempDownloadPath = null;

          try {
            if (!localPath && attachmentUrl && /^https?:\/\//i.test(String(attachmentUrl))) {
              const axios = require('axios');
              let pathname = 'file';
              try {
                pathname = path.basename(new URL(String(attachmentUrl)).pathname) || 'file';
              } catch (_e) {
                pathname = path.basename(String(attachmentUrl).split('?')[0]) || 'file';
              }
              tempDownloadPath = path.join(
                os.tmpdir(),
                `wa-up-${Date.now()}-${pathname.replace(/[^a-zA-Z0-9._-]/g, '_')}`
              );
              const res = await axios.get(String(attachmentUrl), {
                responseType: 'arraybuffer',
                timeout: 120000,
                maxContentLength: 100 * 1024 * 1024
              });
              fs.writeFileSync(tempDownloadPath, Buffer.from(res.data));
              localPath = tempDownloadPath;
            }

            if (!localPath || !fs.existsSync(localPath)) {
              return {
                platformResponseId: null,
                status: 'failed',
                errorMessage:
                  'Could not read the attachment for WhatsApp. Ensure the file uploaded correctly and try again.'
              };
            }

            const mediaId = await whatsappService.uploadMedia(connection, localPath, waUploadType);
            const captionForSend = ['image', 'video', 'document'].includes(waUploadType) ? captionRaw : '';
            const docFilename =
              waUploadType === 'document' ? path.basename(localPath) || 'document' : null;

            const mediaResult = await whatsappService.sendMediaMessage(
              connection,
              to,
              waUploadType,
              mediaId,
              captionForSend,
              docFilename
            );
            if (mediaResult.success && mediaResult.messageId) {
              return { platformResponseId: mediaResult.messageId, status: 'sent', errorMessage: null };
            }
            return { platformResponseId: null, status: 'failed', errorMessage: 'Failed to send WhatsApp media' };
          } finally {
            if (tempDownloadPath && fs.existsSync(tempDownloadPath)) {
              try {
                fs.unlinkSync(tempDownloadPath);
              } catch (_u) {
                /* ignore */
              }
            }
          }
        }

        const body = replyContent == null || replyContent === undefined ? '' : String(replyContent).trim();
        if (!body) {
          return {
            platformResponseId: null,
            status: 'failed',
            errorMessage: 'Message text cannot be empty for WhatsApp.'
          };
        }

        const textResult = await whatsappService.sendTextMessage(connection, to, body);
        if (textResult.success && textResult.messageId) {
          return { platformResponseId: textResult.messageId, status: 'sent', errorMessage: null };
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
        if (!connection.platformData?.accountId) {
          return {
            platformResponseId: null,
            status: 'failed',
            errorMessage: 'Google connection is missing Business Profile account. Open Settings and click Refresh Locations, or reconnect Google.'
          };
        }
        await googleService.ensureValidToken(connection);
        const googleResult = await googleService.replyToReview(
          connection,
          locationId,
          reviewId,
          replyContent
        );
        return {
          platformResponseId: googleResult.platformResponseId || `google-review-${reviewId}`,
          status: 'sent',
          errorMessage: null
        };
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
    const metaUserMsg =
      metaError?.message ||
      metaError?.error_user_msg ||
      platformError.message;

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
