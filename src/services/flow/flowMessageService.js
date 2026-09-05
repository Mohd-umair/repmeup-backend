'use strict';

const PlatformConnection = require('../../models/PlatformConnection');
const instagramService = require('../../integrations/meta/instagramService');
const whatsappService = require('../../integrations/whatsapp/whatsappService');
const { recordAutomationReply } = require('../inbox/inboxAutomationReplyService');
const logger = require('../../config/logger');

async function getConnection(organizationId, platform) {
  return PlatformConnection.findOne({
    organization: organizationId,
    platform,
    isActive: true,
    status: 'connected'
  }).lean();
}

/** Resolve the platform-specific recipient id for an interaction. */
function recipientFor(interaction) {
  return interaction.author?.platformId
    || interaction.author?.id
    || interaction.platformUserId
    || '';
}

/** Dispatch a plain text message on the interaction's platform. */
async function dispatchText(platform, conn, interaction, text) {
  const recipientId = recipientFor(interaction);
  // A comment private reply is keyed by comment_id, not a recipient id, so it can
  // proceed without one; every other path needs a resolved recipient.
  if (!recipientId && interaction.type !== 'comment') return { sent: false, reason: 'no_recipient' };

  if (platform === 'instagram') {
    const connType = instagramService._connectionType(conn);
    // pageId resolution mirrors commentToDmService: IG-Login uses the scoped IG id,
    // Facebook-Login uses the linked page id.
    const pageId = connType === 'instagram_login'
      ? (conn.metadata?.igLoginScopedId || conn.platformUserId)
      : (conn.platformData?.pageId || conn.platformPageId || conn.platformUserId
         || conn.platformData?.instagramBusinessAccountId);

    // A public comment can't be DM'd with a normal message (the commenter never
    // messaged us). Instagram requires a private reply keyed by comment_id
    // (allowed once per comment, within a 7-day window).
    if (interaction.type === 'comment') {
      await instagramService.sendPrivateReply(
        interaction.platformId, text, conn.accessToken, pageId, connType
      );
    } else {
      await instagramService.sendMessage(
        recipientId, text, conn.accessToken, pageId, false, connType
      );
    }
    return { sent: true };
  }

  if (platform === 'whatsapp') {
    await whatsappService.sendTextMessage(conn, recipientId, text);
    return { sent: true };
  }

  if (platform === 'facebook') {
    const pageId = conn.platformData?.pageId;
    await instagramService.sendMessage(
      recipientId, text, conn.accessToken, pageId, false, conn.platformData?.connectionType
    );
    return { sent: true };
  }

  return { sent: false, reason: `unsupported_platform:${platform}` };
}

/**
 * Send text for a flow step and record in inbox when possible.
 */
async function sendTextForInteraction(interaction, organizationId, text) {
  if (!interaction || !text?.trim()) return { sent: false };

  const platform = interaction.platform;
  const conn = await getConnection(organizationId, platform);
  if (!conn) {
    logger.warn('[flowMessageService] no connection', { platform, organizationId });
    return { sent: false, reason: 'no_connection' };
  }

  try {
    const result = await dispatchText(platform, conn, interaction, text);
    if (!result.sent) {
      logger.warn('[flowMessageService] not sent', { platform, reason: result.reason });
      return result;
    }

    await recordAutomationReply({
      interactionId: interaction._id,
      organizationId,
      content: text,
      messageType: 'text'
    });
    return { sent: true };
  } catch (err) {
    // Surface token expiry and permission errors as fatal so the enrollment fails visibly.
    const msg = String(err.message || '');
    const isTokenExpired = /invalid oauth|token has expired|OAuthException|Error code 190/i.test(msg);
    const isPermissionError = /permission/i.test(msg) && /Error code (10|200|230|299)/i.test(msg);
    if (isTokenExpired) {
      logger.error('[flowMessageService] expired token — fatal', { platform, error: msg });
      return { sent: false, reason: 'expired_token', fatal: true, message: `${platform} access token has expired. Reconnect in Settings → Platforms.` };
    }
    if (isPermissionError) {
      logger.error('[flowMessageService] permission error — fatal', { platform, error: msg });
      return { sent: false, reason: 'permission_error', fatal: true, message: `${platform} permission denied. Reconnect in Settings → Platforms.` };
    }
    logger.warn('[flowMessageService] send failed', { error: msg });
    return { sent: false, reason: msg };
  }
}

/**
 * Resolve the WhatsApp connection + recipient for a flow step in one call.
 * Returns { conn, recipient } — either may be null when unavailable.
 */
async function resolveWhatsAppTarget(organizationId, interaction, enrollment) {
  const conn = await getConnection(organizationId, 'whatsapp');
  const recipient = (interaction ? recipientFor(interaction) : '') || enrollment?.platformUserId || '';
  return { conn, recipient };
}

module.exports = {
  sendTextForInteraction,
  getConnection,
  recipientFor,
  resolveWhatsAppTarget
};
