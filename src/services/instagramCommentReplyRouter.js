'use strict';

/**
 * Instagram Comment Reply Router
 *
 * Decides whether an outgoing AI (or human-approved) reply to an Instagram
 * comment should be sent as:
 *   - a Private Reply DM  (recipient.comment_id → POST /{pageId}/messages)
 *   - a Public comment reply (POST /{commentId}/replies)
 *
 * Rule: any comment on a post that is linked to at least one product must be
 * answered via Private Reply so that price, checkout links, and product-specific
 * copy never appear publicly in the comments thread.
 *
 * Design:
 *   - Fast path: trust `interaction.metadata.linkedProductCount` if it is a number
 *     (set at webhook-ingestion time by instagramWebhookService).
 *   - Fallback: live DB look-up via `buildPostLinkedProductQuery` for older
 *     interactions that were ingested before the metadata field existed.
 *   - pageId resolution mirrors the patterns used by flowMessageService and
 *     commentToDmService so all three callers are consistent.
 */

const logger = require('../config/logger');

const svcLogger = logger.createChild({ module: 'instagramCommentReplyRouter' });

/**
 * Returns true when the comment's parent post is linked to one or more active
 * products in this organisation.
 *
 * @param {object}   interaction    Mongoose Interaction document (or lean object)
 * @param {string}   organizationId
 * @param {object}  [opts]
 * @param {boolean} [opts.forcePrivateReply=true] - org-level override; when false
 *   the function always returns false (public reply), skipping all checks.
 * @returns {Promise<boolean>}
 */
async function isCommentOnProductLinkedPost(interaction, organizationId, opts = {}) {
  const { forcePrivateReply = true } = opts;
  if (!forcePrivateReply) return false;

  if (!interaction || interaction.platform !== 'instagram' || interaction.type !== 'comment') {
    return false;
  }

  // ── Fast path: trust the snapshot set at webhook ingestion ───────────────
  const cached = interaction.metadata?.linkedProductCount;
  if (typeof cached === 'number') {
    svcLogger.debug('[commentReplyRouter] using cached linkedProductCount', {
      interactionId: interaction._id?.toString(),
      linkedProductCount: cached
    });
    return cached > 0;
  }

  // ── Fallback: live DB check (legacy interactions / race-condition safety) ─
  const postId = interaction.metadata?.postId;
  if (!postId) {
    svcLogger.debug('[commentReplyRouter] no metadata.postId — defaulting to public reply', {
      interactionId: interaction._id?.toString()
    });
    return false;
  }

  try {
    const Product = require('../models/Product');
    const { buildPostLinkedProductQuery } = require('./commentToDmProductHelpers');
    const exists = await Product.exists(buildPostLinkedProductQuery(organizationId, String(postId)));
    svcLogger.debug('[commentReplyRouter] live product-linkage check result', {
      interactionId: interaction._id?.toString(),
      postId,
      linked: !!exists
    });
    return !!exists;
  } catch (err) {
    svcLogger.warn('[commentReplyRouter] live product-linkage check failed — defaulting to public reply', {
      interactionId: interaction._id?.toString(),
      error: err.message
    });
    return false;
  }
}

/**
 * Resolve the Instagram page/user ID required by sendPrivateReply.
 *
 * Mirrors the pattern used by flowMessageService (lines 37-40) and
 * commentToDmService — the two other callers of sendPrivateReply — so all
 * three paths behave identically.
 *
 * @param {object}      connection  Lean PlatformConnection document
 * @param {string|null} connType    'instagram_login' | null
 * @returns {string|null}
 */
function resolveInstagramPrivateReplyPageId(connection, connType) {
  if (!connection) return null;

  if (connType === 'instagram_login') {
    return connection.metadata?.igLoginScopedId
      || connection.platformUserId
      || null;
  }

  // Facebook-Login path
  return connection.platformPageId
    || connection.platformData?.pageId
    || connection.metadata?.facebookPageId
    || connection.platformUserId
    || null;
}

module.exports = {
  isCommentOnProductLinkedPost,
  resolveInstagramPrivateReplyPageId
};
