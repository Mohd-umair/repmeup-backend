'use strict';

/**
 * Links Instagram comment interactions to their DM thread for unified inbox display.
 */

const Interaction = require('../../models/Interaction');
const SalesConversationState = require('../../models/SalesConversationState');
const { generateChatRef } = require('../../utils/chatRefHelper');
const logger = require('../../config/logger');

const svcLogger = logger.createChild({ module: 'commentDmThreadLinkService' });

const SECONDS_MS_CUTOFF = 10_000_000_000;

function normalizeTimestampJs(raw) {
  if (raw == null || Number.isNaN(Number(raw))) return 0;
  const n = Number(raw);
  return n > 0 && n < SECONDS_MS_CUTOFF ? n * 1000 : n;
}

/**
 * Same platformId format as instagramWebhookService DM upsert.
 */
function buildDmThreadPlatformId(igAccountId, instagramUserId) {
  return `dm_${String(igAccountId)}_${String(instagramUserId)}`;
}

function resolveIgAccountId(connection) {
  if (!connection) return null;
  const id = connection.platformUserId
    || connection.metadata?.instagramAccountId
    || connection.metadata?.igLoginScopedId
    || connection.platformData?.businessAccountId
    || connection.platformData?.instagramBusinessAccountId;
  return id ? String(id) : null;
}

/**
 * Link comment interaction ↔ DM thread. Idempotent.
 *
 * @returns {Promise<{ dmInteractionId: string|null, dmPlatformId: string|null }>}
 */
async function ensureCommentDmLink({
  commentInteraction,
  organizationId,
  instagramUserId,
  platformConnection,
  postId = null
}) {
  if (!commentInteraction?._id || !organizationId || !instagramUserId || !platformConnection) {
    return { dmInteractionId: null, dmPlatformId: null };
  }

  const igAccountId = resolveIgAccountId(platformConnection);
  if (!igAccountId) {
    svcLogger.warn('[commentDmLink] Could not resolve igAccountId from connection');
    return { dmInteractionId: null, dmPlatformId: null };
  }

  const threadPlatformId = buildDmThreadPlatformId(igAccountId, instagramUserId);
  const commentId = commentInteraction._id;
  const orgId = organizationId;
  const author = commentInteraction.author || {};
  const connId = platformConnection._id || platformConnection;

  const existingDm = await Interaction.findOne({
    organization: orgId,
    platformId: threadPlatformId
  }).select('_id').lean();

  let chatRefFields = {};
  if (!existingDm) {
    const refData = await generateChatRef(orgId).catch(() => ({ chatNumber: null, chatRef: null }));
    if (refData?.chatRef) {
      chatRefFields = { chatNumber: refData.chatNumber, chatRef: refData.chatRef };
    }
  }

  const dmInteraction = await Interaction.findOneAndUpdate(
    { organization: orgId, platformId: threadPlatformId },
    {
      $set: {
        organization: orgId,
        platform: 'instagram',
        type: 'dm',
        platformId: threadPlatformId,
        content: commentInteraction.content || '(Comment-to-DM thread)',
        author: {
          platformId: String(instagramUserId),
          username: author.username,
          name: author.name || author.username || 'Instagram User',
          ...(author.avatarUrl ? { avatarUrl: author.avatarUrl } : {})
        },
        threadId: String(instagramUserId),
        'metadata.instagramAccountId': igAccountId,
        'metadata.sourceCommentInteractionId': commentId,
        ...(connId ? { platformConnection: connId } : {})
      },
      $setOnInsert: {
        status: 'unread',
        isRead: false,
        source: 'comment_to_dm_link',
        platformCreatedAt: commentInteraction.platformCreatedAt || new Date(),
        ...chatRefFields
      }
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  await Interaction.updateOne(
    { _id: commentId, organization: orgId },
    {
      $set: {
        'metadata.linkedDmInteractionId': dmInteraction._id,
        'metadata.linkedDmPlatformId': threadPlatformId,
        'metadata.commentToDmActive': true
      }
    }
  );

  if (postId) {
    await SalesConversationState.updateMany(
      {
        organization: orgId,
        instagramUserId: String(instagramUserId),
        postId: String(postId)
      },
      { $set: { dmInteractionId: dmInteraction._id } }
    );
  }

  svcLogger.info('[commentDmLink] Linked comment to DM thread', {
    commentInteractionId: String(commentId),
    dmInteractionId: String(dmInteraction._id),
    threadPlatformId
  });

  return {
    dmInteractionId: dmInteraction._id,
    dmPlatformId: threadPlatformId
  };
}

/**
 * Merge paginated incoming message windows from comment + linked DM interactions.
 */
function mergeIncomingMessagePages(commentPage, dmPage) {
  const seen = new Set();
  const merged = [];

  const add = (msg, fromDm) => {
    if (!msg || typeof msg !== 'object') return;
    const key = msg.mid
      ? String(msg.mid)
      : `${normalizeTimestampJs(msg.timestamp)}|${String(msg.text || '').slice(0, 120)}`;
    if (seen.has(key)) return;
    seen.add(key);
    merged.push(fromDm ? { ...msg, mergedFromDm: true } : { ...msg });
  };

  (commentPage?.incomingMessages || []).forEach((m) => add(m, false));
  (dmPage?.incomingMessages || []).forEach((m) => add(m, true));

  merged.sort(
    (a, b) => (normalizeTimestampJs(a.timestamp) || 0) - (normalizeTimestampJs(b.timestamp) || 0)
  );

  const commentTotal = commentPage?.totalMessages || 0;
  const dmTotal = dmPage?.totalMessages || 0;
  const totalMessages = Math.max(commentTotal + dmTotal, merged.length);

  return {
    incomingMessages: merged,
    totalMessages,
    hasOlderMessages: !!(commentPage?.hasOlderMessages || dmPage?.hasOlderMessages),
    oldestMessageTimestamp: merged.length > 0 ? merged[0].timestamp ?? null : null,
    returnedMessages: merged.length
  };
}

/** Mongo filter fragment: hide DM rows linked to a comment CTD flow. */
function shadowDmExclusionCondition() {
  return {
    $or: [
      { type: { $ne: 'dm' } },
      { 'metadata.sourceCommentInteractionId': { $exists: false } },
      { 'metadata.sourceCommentInteractionId': null }
    ]
  };
}

module.exports = {
  buildDmThreadPlatformId,
  resolveIgAccountId,
  ensureCommentDmLink,
  mergeIncomingMessagePages,
  shadowDmExclusionCondition,
  normalizeTimestampJs
};
