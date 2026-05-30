'use strict';

/**
 * Links Instagram comment interactions to their DM thread for unified inbox display.
 */

const Interaction = require('../../models/Interaction');
const SalesConversationState = require('../../models/SalesConversationState');
const ProductOrder = require('../../models/ProductOrder');
const PlatformConnection = require('../../models/PlatformConnection');
const cacheService = require('../cacheService');
const { generateChatRef } = require('../../utils/chatRefHelper');
const { emitToOrg } = require('../../utils/socketEmitter');
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

/** All IG account id variants that may appear in webhook entry.id vs connection fields. */
function collectIgAccountIdCandidates(webhookEntryId, connection) {
  const ids = [];
  const add = (value) => {
    if (value == null || value === '') return;
    const s = String(value);
    if (!ids.includes(s)) ids.push(s);
  };
  add(webhookEntryId);
  if (connection) {
    add(connection.platformUserId);
    add(connection.platformPageId);
    add(connection.metadata?.instagramAccountId);
    add(connection.metadata?.igLoginScopedId);
    add(connection.platformData?.businessAccountId);
    add(connection.platformData?.instagramBusinessAccountId);
  }
  return ids;
}

function parseSalesPostbackOrderToken(payload) {
  const raw = String(payload || '');
  if (!raw.startsWith('SALES:')) return null;
  const parts = raw.split(':');
  if (parts.length < 3) return null;
  return { action: parts[1], orderToken: parts.slice(2).join(':') };
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Resolve the canonical DM thread for a customer — prefers the CTD-linked thread so
 * webhook entry.id and connection.platformUserId mismatches do not create duplicate rows.
 */
async function resolveDmThreadTarget({
  organizationId,
  instagramUserId,
  webhookEntryId = null,
  connection = null,
  payload = null,
  hintCommentInteractionId = null
}) {
  const userId = String(instagramUserId);
  let sourceCommentInteractionId = hintCommentInteractionId || null;
  let threadPlatformId = null;

  if (hintCommentInteractionId) {
    const hinted = await Interaction.findById(hintCommentInteractionId)
      .select('metadata.linkedDmPlatformId')
      .lean();
    if (hinted?.metadata?.linkedDmPlatformId) {
      threadPlatformId = hinted.metadata.linkedDmPlatformId;
    }
  }

  if (!sourceCommentInteractionId || !threadPlatformId) {
    const ctdComment = await Interaction.findOne({
      organization: organizationId,
      type: 'comment',
      platform: 'instagram',
      'author.platformId': userId,
      'metadata.commentToDmActive': true
    })
      .sort({ updatedAt: -1 })
      .select('_id metadata.linkedDmPlatformId')
      .lean();

    if (ctdComment) {
      sourceCommentInteractionId = sourceCommentInteractionId || ctdComment._id;
      if (!threadPlatformId && ctdComment.metadata?.linkedDmPlatformId) {
        threadPlatformId = ctdComment.metadata.linkedDmPlatformId;
      }
    }
  }

  if (!sourceCommentInteractionId && payload) {
    const parsed = parseSalesPostbackOrderToken(payload);
    if (parsed?.orderToken) {
      const order = await ProductOrder.findOne({
        organization: organizationId,
        orderToken: parsed.orderToken
      }).select('commentInteractionId').lean();
      if (order?.commentInteractionId) {
        sourceCommentInteractionId = order.commentInteractionId;
        const comment = await Interaction.findById(order.commentInteractionId)
          .select('metadata.linkedDmPlatformId')
          .lean();
        if (!threadPlatformId && comment?.metadata?.linkedDmPlatformId) {
          threadPlatformId = comment.metadata.linkedDmPlatformId;
        }
      }
    }
  }

  if (!sourceCommentInteractionId || !threadPlatformId) {
    const state = await SalesConversationState.findOne({
      organization: organizationId,
      instagramUserId: userId
    })
      .sort({ updatedAt: -1 })
      .select('commentInteractionId dmInteractionId')
      .lean();

    if (state?.commentInteractionId && !sourceCommentInteractionId) {
      sourceCommentInteractionId = state.commentInteractionId;
    }
    if (!threadPlatformId && state?.dmInteractionId) {
      const dm = await Interaction.findById(state.dmInteractionId).select('platformId').lean();
      if (dm?.platformId) threadPlatformId = dm.platformId;
    }
    if (!threadPlatformId && sourceCommentInteractionId) {
      const comment = await Interaction.findById(sourceCommentInteractionId)
        .select('metadata.linkedDmPlatformId')
        .lean();
      if (comment?.metadata?.linkedDmPlatformId) {
        threadPlatformId = comment.metadata.linkedDmPlatformId;
      }
    }
  }

  const accountIds = collectIgAccountIdCandidates(webhookEntryId, connection);

  if (sourceCommentInteractionId && !threadPlatformId) {
    const linkedByMeta = await Interaction.findOne({
      organization: organizationId,
      type: 'dm',
      'metadata.sourceCommentInteractionId': sourceCommentInteractionId
    }).select('platformId').lean();
    if (linkedByMeta?.platformId) {
      threadPlatformId = linkedByMeta.platformId;
    } else {
      const preferredAccountId = resolveIgAccountId(connection) || accountIds[0];
      if (preferredAccountId) {
        threadPlatformId = buildDmThreadPlatformId(preferredAccountId, userId);
      }
    }
  }

  const candidatePlatformIds = accountIds.map((id) => buildDmThreadPlatformId(id, userId));
  if (threadPlatformId && !candidatePlatformIds.includes(threadPlatformId)) {
    candidatePlatformIds.unshift(threadPlatformId);
  }

  let existingDm = null;
  if (threadPlatformId) {
    existingDm = await Interaction.findOne({
      organization: organizationId,
      platformId: threadPlatformId,
      type: 'dm'
    }).select('_id platformId metadata.sourceCommentInteractionId').lean();
  }

  if (!existingDm) {
    for (const pid of candidatePlatformIds) {
      const found = await Interaction.findOne({
        organization: organizationId,
        platformId: pid,
        type: 'dm'
      }).select('_id platformId metadata.sourceCommentInteractionId').lean();
      if (!found) continue;

      // Orphan webhook thread (entry.id) — do not adopt when CTD comment anchor is known.
      if (
        sourceCommentInteractionId
        && !found.metadata?.sourceCommentInteractionId
        && threadPlatformId
        && found.platformId !== threadPlatformId
      ) {
        continue;
      }

      existingDm = found;
      threadPlatformId = found.platformId;
      if (found.metadata?.sourceCommentInteractionId && !sourceCommentInteractionId) {
        sourceCommentInteractionId = found.metadata.sourceCommentInteractionId;
      }
      break;
    }
  }

  if (!threadPlatformId) {
    const igAccountId = webhookEntryId
      ? String(webhookEntryId)
      : (resolveIgAccountId(connection) || accountIds[0] || 'unknown');
    threadPlatformId = buildDmThreadPlatformId(igAccountId, userId);
  }

  const parsedPlatform = threadPlatformId.match(/^dm_(.+)_(.+)$/);
  const igAccountId = parsedPlatform ? parsedPlatform[1] : (webhookEntryId || resolveIgAccountId(connection));

  return {
    threadPlatformId,
    igAccountId,
    sourceCommentInteractionId,
    existingDm
  };
}

/** Bidirectional link + hide shadow DM from inbox list. */
async function ensureDmThreadLinkedToComment({
  organizationId,
  dmInteractionId,
  threadPlatformId,
  sourceCommentInteractionId
}) {
  if (!organizationId || !dmInteractionId || !sourceCommentInteractionId) return;

  await Interaction.updateOne(
    { _id: dmInteractionId, organization: organizationId },
    {
      $set: {
        'metadata.sourceCommentInteractionId': sourceCommentInteractionId,
        'metadata.isCommentShadowDm': true
      }
    }
  );

  await Interaction.updateOne(
    { _id: sourceCommentInteractionId, organization: organizationId },
    {
      $set: {
        'metadata.linkedDmInteractionId': dmInteractionId,
        'metadata.linkedDmPlatformId': threadPlatformId,
        'metadata.commentToDmActive': true
      }
    }
  );

  await SalesConversationState.updateMany(
    {
      organization: organizationId,
      commentInteractionId: sourceCommentInteractionId
    },
    { $set: { dmInteractionId } }
  );
}

/**
 * Merge duplicate DM threads for the same customer (entry.id vs connection id mismatch)
 * into the canonical CTD-linked thread and archive the orphan list row.
 */
async function absorbOrphanDmThreadsForCustomer({
  organizationId,
  canonicalPlatformId,
  instagramUserId
}) {
  if (!organizationId || !canonicalPlatformId || !instagramUserId) return;

  const userId = String(instagramUserId);
  const orphans = await Interaction.find({
    organization: organizationId,
    type: 'dm',
    platform: 'instagram',
    platformId: {
      $ne: canonicalPlatformId,
      $regex: new RegExp(`^dm_.+_${escapeRegex(userId)}$`)
    },
    status: { $ne: 'archived' }
  }).select('_id platformId metadata.incomingMessages').lean();

  if (!orphans.length) return;

  const canonical = await Interaction.findOne({
    organization: organizationId,
    platformId: canonicalPlatformId
  });
  if (!canonical) return;

  for (const orphan of orphans) {
    const incoming = orphan.metadata?.incomingMessages || [];
    for (const msg of incoming) {
      if (!msg?.mid) continue;
      await Interaction.updateOne(
        {
          _id: canonical._id,
          'metadata.incomingMessages.mid': { $ne: msg.mid }
        },
        {
          $push: {
            'metadata.incomingMessages': {
              $each: [{ ...msg, mergedFromOrphanDm: true }],
              $slice: -100
            }
          }
        }
      );
    }

    await Interaction.updateOne(
      { _id: orphan._id },
      {
        $set: {
          status: 'archived',
          'metadata.mergedIntoDmPlatformId': canonicalPlatformId
        }
      }
    );

    svcLogger.info('[commentDmLink] Absorbed orphan DM thread into CTD canonical thread', {
      orphanPlatformId: orphan.platformId,
      canonicalPlatformId
    });
  }

  try {
    await cacheService.invalidateInteractionCaches(String(organizationId));
  } catch (_) { /* non-fatal */ }
}

async function finalizeDmThreadForCtd({
  organizationId,
  dmInteraction,
  threadPlatformId,
  sourceCommentInteractionId,
  instagramUserId
}) {
  if (!dmInteraction?._id) return dmInteraction;

  if (sourceCommentInteractionId) {
    await ensureDmThreadLinkedToComment({
      organizationId,
      dmInteractionId: dmInteraction._id,
      threadPlatformId,
      sourceCommentInteractionId
    });
    await absorbOrphanDmThreadsForCustomer({
      organizationId,
      canonicalPlatformId: threadPlatformId,
      instagramUserId
    });

    const refreshed = await Interaction.findById(dmInteraction._id);
    if (refreshed) {
      await notifyLinkedCommentInboxRefresh(
        organizationId,
        refreshed.toObject ? refreshed.toObject() : refreshed
      );
    }
    return refreshed || dmInteraction;
  }

  return dmInteraction;
}

/**
 * On comment thread open: link + merge any duplicate DM rows for this customer.
 * Fixes legacy splits where webhook entry.id ≠ connection.platformUserId.
 */
async function reconcileCommentDmThreadOnRead({ organizationId, commentInteraction }) {
  if (
    !commentInteraction
    || commentInteraction.type !== 'comment'
    || commentInteraction.platform !== 'instagram'
  ) {
    return null;
  }

  const userId = commentInteraction.author?.platformId;
  if (!userId) return null;

  const connId = commentInteraction.platformConnection?._id || commentInteraction.platformConnection;
  let connection = null;
  if (connId) {
    connection = await PlatformConnection.findById(connId).select(
      'platformUserId platformPageId platformData metadata'
    ).lean();
  }

  const target = await resolveDmThreadTarget({
    organizationId,
    instagramUserId: userId,
    connection,
    hintCommentInteractionId: commentInteraction._id
  });

  if (!target.threadPlatformId) return null;

  const dm = await Interaction.findOne({
    organization: organizationId,
    platformId: target.threadPlatformId,
    type: 'dm'
  });

  if (!dm) return null;

  const sourceCommentId = target.sourceCommentInteractionId || commentInteraction._id;
  await finalizeDmThreadForCtd({
    organizationId,
    dmInteraction: dm,
    threadPlatformId: target.threadPlatformId,
    sourceCommentInteractionId: sourceCommentId,
    instagramUserId: userId
  });

  return {
    linkedDmInteractionId: dm._id,
    linkedDmPlatformId: target.threadPlatformId
  };
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

  const commentId = commentInteraction._id;
  const orgId = organizationId;
  const author = commentInteraction.author || {};
  const connId = platformConnection._id || platformConnection;

  const { threadPlatformId, igAccountId, sourceCommentInteractionId } = await resolveDmThreadTarget({
    organizationId: orgId,
    instagramUserId,
    connection: platformConnection,
    hintCommentInteractionId: commentId
  });

  if (!igAccountId || !threadPlatformId) {
    svcLogger.warn('[commentDmLink] Could not resolve igAccountId from connection');
    return { dmInteractionId: null, dmPlatformId: null };
  }

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
        'metadata.isCommentShadowDm': true,
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

  await absorbOrphanDmThreadsForCustomer({
    organizationId: orgId,
    canonicalPlatformId: threadPlatformId,
    instagramUserId
  });

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

/** Human-readable inbox line for a CTA postback tap (button title preferred). */
function formatPostbackIncomingText(title, payload) {
  const label = String(title || '').trim();
  if (label) return label;

  const raw = String(payload || '');
  if (raw.startsWith('SALES:')) {
    const action = raw.split(':')[1] || '';
    const actionLabels = {
      details: 'Product Details',
      payment: 'Pay Now',
      hesitant: 'Maybe later'
    };
    return actionLabels[action] || action || 'Button tap';
  }
  if (raw.startsWith('PICK:')) return 'Product selection';
  return 'Button tap';
}

/**
 * When inbound activity lands on a shadow DM thread, nudge the linked comment row
 * so the inbox detail refetches the merged timeline (CTD unified thread).
 */
async function notifyLinkedCommentInboxRefresh(organizationId, dmInteraction) {
  if (!organizationId || !dmInteraction) return;

  const sourceCommentId = dmInteraction.metadata?.sourceCommentInteractionId;
  if (!sourceCommentId) return;

  try {
    const comment = await Interaction.findOne({
      _id: sourceCommentId,
      organization: organizationId
    })
      .populate('assignedTo', 'firstName lastName email avatar')
      .populate('labels', 'name color icon')
      .populate('replies.sentBy', 'firstName lastName avatar')
      .lean();

    if (!comment) return;

    try {
      await cacheService.invalidateInteractionCaches(String(organizationId));
    } catch (cacheErr) {
      svcLogger.warn('[commentDmLink] cache invalidation failed', { error: cacheErr.message });
    }

    emitToOrg(String(organizationId), 'interaction_updated', {
      interaction: comment,
      linkedDmInbound: true
    });
  } catch (err) {
    svcLogger.warn('[commentDmLink] linked comment refresh notify failed', { error: err.message });
  }
}

module.exports = {
  buildDmThreadPlatformId,
  resolveIgAccountId,
  collectIgAccountIdCandidates,
  resolveDmThreadTarget,
  ensureDmThreadLinkedToComment,
  absorbOrphanDmThreadsForCustomer,
  finalizeDmThreadForCtd,
  reconcileCommentDmThreadOnRead,
  ensureCommentDmLink,
  mergeIncomingMessagePages,
  shadowDmExclusionCondition,
  normalizeTimestampJs,
  formatPostbackIncomingText,
  notifyLinkedCommentInboxRefresh,
  parseSalesPostbackOrderToken
};
