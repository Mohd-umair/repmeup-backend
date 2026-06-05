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
  if (!recipientId) return { sent: false, reason: 'no_recipient' };

  if (platform === 'instagram') {
    const pageId = conn.platformData?.pageId || conn.platformData?.instagramBusinessAccountId;
    await instagramService.sendMessage(
      recipientId, text, conn.accessToken, pageId, false, conn.platformData?.connectionType
    );
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
    logger.warn('[flowMessageService] send failed', { error: err.message });
    return { sent: false, reason: err.message };
  }
}

module.exports = { sendTextForInteraction, getConnection };
