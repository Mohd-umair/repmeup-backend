'use strict';

/**
 * Persist automation outbound messages on Interaction.replies so Inbox can render them.
 */

const Interaction = require('../../models/Interaction');
const cacheService = require('../cacheService');
const { emitToOrg } = require('../../utils/socketEmitter');
const logger = require('../../config/logger');

const svcLogger = logger.createChild({ module: 'inboxAutomationReplyService' });

/**
 * @param {object} params
 * @param {string|import('mongoose').Types.ObjectId} params.interactionId
 * @param {string|import('mongoose').Types.ObjectId} params.organizationId
 * @param {string} [params.content]
 * @param {string|null} [params.platformResponseId]
 * @param {string|null} [params.messageType]
 * @param {string|null} [params.attachmentUrl]
 * @param {string|null} [params.attachmentType]
 * @returns {Promise<{ recorded: boolean, reason?: string, interaction?: object }>}
 */
async function recordAutomationReply({
  interactionId,
  organizationId,
  content,
  platformResponseId = null,
  messageType = null,
  attachmentUrl = null,
  attachmentType = null
}) {
  if (!interactionId || !organizationId) {
    return { recorded: false, reason: 'missing_ids' };
  }

  const trimmed = String(content || '').trim();
  if (!trimmed && !attachmentUrl) {
    return { recorded: false, reason: 'empty_content' };
  }

  try {
    const interaction = await Interaction.findOne({
      _id: interactionId,
      organization: organizationId
    });

    if (!interaction) {
      return { recorded: false, reason: 'not_found' };
    }

    if (platformResponseId) {
      const duplicate = (interaction.replies || []).some(
        (reply) => reply.platformResponseId === platformResponseId
      );
      if (duplicate) {
        return { recorded: false, reason: 'duplicate' };
      }
    }

    await interaction.addReply(
      trimmed || '(attachment)',
      null,
      platformResponseId,
      true,
      attachmentUrl || null,
      attachmentType || null,
      null,
      messageType,
      null,
      interaction.platform === 'whatsapp' && platformResponseId ? 'sent' : null
    );

    const orgIdStr = organizationId.toString();

    try {
      await cacheService.invalidateInteractionCaches(orgIdStr);
    } catch (cacheErr) {
      svcLogger.warn('[inboxAutomationReply] cache invalidation failed', { error: cacheErr.message });
    }

    try {
      const fresh = interaction.toObject ? interaction.toObject() : interaction;
      emitToOrg(orgIdStr, 'interaction_updated', { interaction: fresh });
    } catch (emitErr) {
      svcLogger.warn('[inboxAutomationReply] socket emit failed', { error: emitErr.message });
    }

    return { recorded: true, interaction };
  } catch (err) {
    svcLogger.warn('[inboxAutomationReply] record failed', { error: err.message });
    return { recorded: false, reason: 'error' };
  }
}

module.exports = {
  recordAutomationReply
};
