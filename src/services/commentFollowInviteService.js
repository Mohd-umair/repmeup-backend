/**
 * Instagram: top-level comment → private DM with Follow button (generic template + text fallback).
 * Runs after comment-to-DM product flow so ProductOrder exists when skipIfProductDmSent runs.
 */

const Organization = require('../models/Organization');
const PlatformConnection = require('../models/PlatformConnection');
const ProductOrder = require('../models/ProductOrder');
const CommentFollowInviteLog = require('../models/CommentFollowInviteLog');
const instagramService = require('../integrations/meta/instagramService');
const logger = require('../config/logger');
const { buildFollowInviteGenericElement, normalizeHttpsProfileUrl } = require('../utils/instagramFollowInviteTemplate');
const { buildTemplate } = require('./commentToDmService');

const svcLogger = logger.createChild({ module: 'commentFollowInviteService' });

const DEFAULT_SETTINGS = {
  enabled: false,
  title: 'Thanks for your comment!',
  subtitle: 'Tap below to follow us for more updates.',
  imageUrl: '',
  buttonTitle: 'Follow us',
  buttonUrl: '',
  publicReplyTemplate: '',
  postPublicReply: false,
  deduplicateDms: true,
  maxDmsPerDay: 50,
  skipIfProductDmSent: true
};

/**
 * @param {object} interaction
 * @param {string} organizationId
 */
async function processCommentFollowInvite(interaction, organizationId) {
  try {
    if (!interaction || interaction.platform !== 'instagram' || interaction.type !== 'comment') {
      return;
    }

    const interactionId = interaction._id?.toString?.() || 'unknown';

    if (interaction.parentId) {
      svcLogger.debug('[commentFollowInvite] Skipping — reply-to-comment, not top-level', { interactionId });
      return;
    }

    const org = await Organization.findById(organizationId)
      .select('commentFollowInviteSettings')
      .lean();

    const settings = { ...DEFAULT_SETTINGS, ...(org?.commentFollowInviteSettings || {}) };

    if (!settings.enabled) {
      return;
    }

    const idempotent = await CommentFollowInviteLog.exists({
      organization: organizationId,
      commentInteractionId: interaction._id
    });
    if (idempotent) {
      svcLogger.debug('[commentFollowInvite] Skipping — already logged for this interaction', { interactionId });
      return;
    }

    if (settings.skipIfProductDmSent) {
      const productSent = await ProductOrder.exists({
        organization: organizationId,
        commentInteractionId: interaction._id
      });
      if (productSent) {
        svcLogger.info('[commentFollowInvite] Skipping — product Comment-to-DM sent for this comment', {
          interactionId
        });
        return;
      }
    }

    const postId = interaction.metadata?.postId;
    if (!postId) {
      svcLogger.warn('[commentFollowInvite] Skipping — no metadata.postId', { interactionId });
      return;
    }

    const commenterId = interaction.author?.platformId;
    if (!commenterId) {
      svcLogger.warn('[commentFollowInvite] Skipping — no author.platformId', { interactionId });
      return;
    }

    if (settings.deduplicateDms) {
      const dup = await CommentFollowInviteLog.exists({
        organization: organizationId,
        instagramUserId: String(commenterId),
        instagramPostId: String(postId)
      });
      if (dup) {
        svcLogger.info('[commentFollowInvite] Skipping — dedupe: invite already sent for user+post', {
          commenterId,
          postId
        });
        return;
      }
    }

    const orgDoc = await Organization.findById(organizationId).select('commentFollowInviteSettings');
    if (!orgDoc) return;

    const today = new Date().toDateString();
    const fi = orgDoc.commentFollowInviteSettings || {};
    const resetDate = fi.dmsSentResetDate ? new Date(fi.dmsSentResetDate).toDateString() : null;
    if (resetDate !== today) {
      orgDoc.commentFollowInviteSettings = orgDoc.commentFollowInviteSettings || {};
      orgDoc.commentFollowInviteSettings.dmsSentToday = 0;
      orgDoc.commentFollowInviteSettings.dmsSentResetDate = new Date();
    }

    const maxDms = fi.maxDmsPerDay ?? DEFAULT_SETTINGS.maxDmsPerDay;
    if ((orgDoc.commentFollowInviteSettings.dmsSentToday || 0) >= maxDms) {
      svcLogger.warn('[commentFollowInvite] Skipping — daily limit reached', {
        dmsSentToday: orgDoc.commentFollowInviteSettings.dmsSentToday,
        maxDms
      });
      return;
    }

    const connection = interaction.platformConnection
      ? await PlatformConnection.findById(interaction.platformConnection)
          .select('accessToken platformData platformPageId platformUserId platformUsername metadata')
          .lean()
      : await PlatformConnection.findOne({
          organization: organizationId,
          platform: 'instagram',
          isActive: true
        })
          .select('accessToken platformData platformPageId platformUserId platformUsername metadata')
          .lean();

    if (!connection?.accessToken) {
      svcLogger.warn('[commentFollowInvite] Skipping — no Instagram connection', { organizationId });
      return;
    }

    const accessToken = connection.accessToken;
    const connType =
      connection.metadata?.connectionType ||
      (typeof accessToken === 'string' && accessToken.startsWith('IGAA') ? 'instagram_login' : null);
    const pageId =
      connType === 'instagram_login'
        ? connection.metadata?.igLoginScopedId || connection.platformUserId
        : connection.platformData?.pageId ||
          connection.platformPageId ||
          connection.platformUserId;

    let buttonUrl = (settings.buttonUrl && String(settings.buttonUrl).trim()) || '';
    if (!buttonUrl) {
      buttonUrl = normalizeHttpsProfileUrl(connection.platformUsername) || '';
    }
    if (!buttonUrl) {
      svcLogger.warn('[commentFollowInvite] Skipping — no buttonUrl and no platformUsername on connection', {
        organizationId
      });
      return;
    }

    const commenterUsername = interaction.author?.username || '';

    if (settings.postPublicReply && (settings.publicReplyTemplate || '').trim()) {
      const safePublic = String(settings.publicReplyTemplate)
        .replace(/\{\{payment_url\}\}/gi, '')
        .replace(/\{\{paymentUrl\}\}/gi, '');
      const publicStub = buildTemplate(safePublic, {
        username: commenterUsername ? `@${commenterUsername}` : 'there'
      });
      try {
        const stubResult = await instagramService.replyToComment(
          interaction.platformId,
          publicStub,
          accessToken,
          connType
        );
        if (!stubResult?.success) {
          svcLogger.warn('[commentFollowInvite] Public comment reply failed', {
            error: stubResult?.error || 'unknown'
          });
        }
      } catch (e) {
        svcLogger.warn('[commentFollowInvite] Public comment reply error', { error: e.message });
      }
    }

    const element = buildFollowInviteGenericElement({
      title: settings.title,
      subtitle: settings.subtitle,
      imageUrl: settings.imageUrl,
      buttonTitle: settings.buttonTitle,
      buttonUrl
    });

    let dmMethod = 'generic_template';
    try {
      await instagramService.sendPrivateReplyGenericTemplate(
        interaction.platformId,
        element,
        accessToken,
        pageId,
        connType
      );
    } catch (templateErr) {
      svcLogger.warn('[commentFollowInvite] Generic template failed — text fallback', {
        error: templateErr.message,
        interactionId
      });
      dmMethod = 'text_fallback';
      const textBody = [
        String(settings.title || '').trim(),
        String(settings.subtitle || '').trim(),
        `${String(settings.buttonTitle || 'Follow').trim()}: ${buttonUrl}`
      ]
        .filter(Boolean)
        .join('\n\n');
      await instagramService.sendPrivateReply(
        interaction.platformId,
        textBody,
        accessToken,
        pageId,
        connType
      );
    }

    try {
      await CommentFollowInviteLog.create({
        organization: organizationId,
        instagramUserId: String(commenterId),
        instagramPostId: String(postId),
        commentInteractionId: interaction._id,
        dmMethod
      });
    } catch (logErr) {
      if (logErr?.code === 11000) {
        svcLogger.debug('[commentFollowInvite] Duplicate log (race) — ignoring', { interactionId });
        return;
      }
      throw logErr;
    }

    orgDoc.commentFollowInviteSettings.dmsSentToday =
      (orgDoc.commentFollowInviteSettings.dmsSentToday || 0) + 1;
    await orgDoc.save();

    svcLogger.info('[commentFollowInvite] Sent DM', {
      interactionId,
      commenterId,
      postId,
      dmMethod
    });
  } catch (err) {
    svcLogger.error('[commentFollowInvite] Error', { error: err.message, stack: err.stack });
  }
}

module.exports = { processCommentFollowInvite, DEFAULT_SETTINGS };
