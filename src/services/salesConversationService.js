'use strict';

/**
 * Instagram Sales Conversation Service
 *
 * Manages the multi-turn DM sales funnel triggered by a sales-intent comment.
 *
 * Stage flow:
 *   initial_cta_sent
 *     → (user replies, hesitancy detected) → whatsapp_requested
 *       → (user shares phone number) → whatsapp_captured
 *     → (user is interested / no hesitancy) → no state change (they click CTAs)
 */

const Organization = require('../models/Organization');
const SalesConversationState = require('../models/SalesConversationState');
const PlatformConnection = require('../models/PlatformConnection');
const instagramService = require('../integrations/meta/instagramService');
const logger = require('../config/logger');

const svcLogger = logger.createChild({ module: 'salesConversationService' });

// ── Defaults (used when org has no salesFlowSettings yet) ───────────────────
const DEFAULT_HESITANCY_KEYWORDS = [
  'no', 'nahi', 'not interested', 'later', 'abhi nahi',
  'nope', 'not now', 'maybe later'
];

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Returns true if the reply text contains any hesitancy keyword (case-insensitive).
 * @param {string} text
 * @param {string[]} keywords
 * @returns {boolean}
 */
function isHesitant(text, keywords) {
  const lower = String(text || '').toLowerCase();
  return (keywords || DEFAULT_HESITANCY_KEYWORDS).some(kw =>
    lower.includes(String(kw).toLowerCase().trim())
  );
}

/**
 * Extracts a phone number from user-supplied text using a liberal regex.
 * Returns the first match or null.
 * @param {string} text
 * @returns {string|null}
 */
function extractPhone(text) {
  const match = String(text || '').match(/[\+]?[0-9][\d\s\-().]{7,}/);
  if (!match) return null;
  const cleaned = match[0].replace(/\s+/g, ' ').trim();
  return cleaned.length >= 8 ? cleaned : null;
}

// ── Connection resolver ──────────────────────────────────────────────────────

async function resolveIgConnection(organizationId, interactionConnection) {
  const conn = interactionConnection
    ? await PlatformConnection.findById(interactionConnection)
        .select('accessToken platformData platformPageId platformUserId metadata').lean()
    : await PlatformConnection.findOne({
        organization: organizationId,
        platform: 'instagram',
        isActive: true
      }).select('accessToken platformData platformPageId platformUserId metadata').lean();

  if (!conn?.accessToken) return null;

  const connType = conn.metadata?.connectionType
    || (typeof conn.accessToken === 'string' && conn.accessToken.startsWith('IGAA')
        ? 'instagram_login'
        : null);

  const pageId = connType === 'instagram_login'
    ? (conn.metadata?.igLoginScopedId || conn.platformUserId)
    : (conn.platformData?.pageId || conn.platformPageId || conn.platformUserId);

  return { accessToken: conn.accessToken, pageId, connType };
}

// ── Main entry point ─────────────────────────────────────────────────────────

/**
 * Called from instagramWebhookService after a DM Interaction is saved.
 * Checks whether the sender has an active sales conversation state and advances
 * the funnel if applicable.
 *
 * @param {object} interaction - Saved Interaction document (or lean object)
 * @param {string} organizationId
 */
async function handleInboundDm(interaction, organizationId) {
  try {
    if (!interaction || interaction.type !== 'dm') return;

    const instagramUserId = String(interaction.author?.platformId || '');
    if (!instagramUserId) return;

    // ── 1. Load org settings ───────────────────────────────────────────
    const org = await Organization.findById(organizationId)
      .select('salesFlowSettings')
      .lean();

    if (!org?.salesFlowSettings?.enabled) {
      svcLogger.debug('[salesConversation] Skipping — salesFlowSettings.enabled is false', { organizationId });
      return;
    }

    const settings = org.salesFlowSettings;

    // ── 2. Load active sales state for this user ───────────────────────
    const state = await SalesConversationState.findOne({
      organization: organizationId,
      instagramUserId
    }).sort({ createdAt: -1 }); // most recent if multiple

    if (!state) {
      svcLogger.debug('[salesConversation] No active SalesConversationState found for user', {
        instagramUserId, organizationId
      });
      return;
    }

    if (['whatsapp_captured', 'dropped'].includes(state.stage)) {
      svcLogger.debug('[salesConversation] Conversation already concluded', {
        instagramUserId, stage: state.stage
      });
      return;
    }

    // Extract the latest inbound message text from the interaction
    const incomingMessages = interaction.metadata?.incomingMessages || [];
    const latestMsg = incomingMessages[incomingMessages.length - 1];
    const replyText = latestMsg?.text || interaction.content || '';

    svcLogger.info('[salesConversation] Handling inbound DM', {
      instagramUserId, stage: state.stage, replyPreview: replyText.substring(0, 80)
    });

    // ── 3. Resolve IG connection for sending ───────────────────────────
    const conn = await resolveIgConnection(organizationId, interaction.platformConnection);
    if (!conn) {
      svcLogger.warn('[salesConversation] No active Instagram connection — cannot send DM', { organizationId });
      return;
    }

    // ── 4. Stage-specific logic ────────────────────────────────────────

    if (state.stage === 'initial_cta_sent') {
      const hesitant = isHesitant(replyText, settings.hesitancyKeywords);

      if (hesitant) {
        // Send WhatsApp capture message
        const captureMsg = settings.whatsappCaptureMessage
          || 'No problem! Would you like us to reach you on WhatsApp? Just share your number and we\'ll be in touch. 😊';

        await instagramService.sendMessage(
          instagramUserId,
          captureMsg,
          conn.accessToken,
          conn.pageId,
          false,
          conn.connType
        );

        state.stage = 'whatsapp_requested';
        state.lastStageAt = new Date();
        await state.save();

        svcLogger.info('[salesConversation] Hesitancy detected — sent WhatsApp capture message', {
          instagramUserId, replyText: replyText.substring(0, 60)
        });
      } else {
        svcLogger.info('[salesConversation] No hesitancy detected — user may be exploring CTAs', {
          instagramUserId
        });
      }
      return;
    }

    if (state.stage === 'whatsapp_requested') {
      const phone = extractPhone(replyText);

      if (phone) {
        // Save the captured number and confirm
        const confirmMsg = settings.whatsappCaptureConfirmation
          || 'Thank you! We\'ll contact you on WhatsApp soon. 🙏';

        await instagramService.sendMessage(
          instagramUserId,
          confirmMsg,
          conn.accessToken,
          conn.pageId,
          false,
          conn.connType
        );

        state.stage = 'whatsapp_captured';
        state.whatsappNumber = phone;
        state.lastStageAt = new Date();
        await state.save();

        svcLogger.info('[salesConversation] WhatsApp number captured', {
          instagramUserId, phone
        });
      } else {
        // User replied but no phone number found — gently re-prompt once
        const reprompt = 'Please share your WhatsApp number (e.g. +91 98765 43210) so we can reach you. 😊';
        await instagramService.sendMessage(
          instagramUserId,
          reprompt,
          conn.accessToken,
          conn.pageId,
          false,
          conn.connType
        );

        svcLogger.info('[salesConversation] No phone number found — re-prompted user', { instagramUserId });
      }
    }
  } catch (err) {
    // Non-fatal: never break the webhook pipeline
    svcLogger.error('[salesConversation] Unhandled error', { error: err.message, stack: err.stack });
  }
}

module.exports = { handleInboundDm, isHesitant, extractPhone };
