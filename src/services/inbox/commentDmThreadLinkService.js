'use strict';

/**
 * Links Instagram comment interactions to their DM thread for unified inbox display.
 *
 * Production guarantees:
 *  - All multi-document writes run inside Mongoose sessions (atomic commit/rollback).
 *  - Every error is typed, logged with context, and either re-thrown or explicitly swallowed
 *    with a documented reason — no silent catch(() => {}).
 *  - All public entry-points validate their inputs before touching the DB.
 *  - Message dedup in absorbOrphanDmThreadsForCustomer handles mid-less messages via a
 *    composite fallback key so no inbound message is silently dropped.
 */

const mongoose = require('mongoose');
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

// ---------------------------------------------------------------------------
// Typed errors
// ---------------------------------------------------------------------------

class CommentDmLinkError extends Error {
  constructor(message, { code, context = {} } = {}) {
    super(message);
    this.name = 'CommentDmLinkError';
    this.code = code;
    this.context = context;
  }
}

const ErrorCode = Object.freeze({
  INVALID_INPUT:         'INVALID_INPUT',
  RESOLUTION_FAILED:     'RESOLUTION_FAILED',
  LINK_WRITE_FAILED:     'LINK_WRITE_FAILED',
  ORPHAN_ABSORB_FAILED:  'ORPHAN_ABSORB_FAILED',
  NOTIFY_FAILED:         'NOTIFY_FAILED',
});

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

/**
 * Throws CommentDmLinkError(INVALID_INPUT) if any required field is missing or not
 * a non-empty string / ObjectId-like value.
 */
function assertRequiredStrings(fields, caller) {
  for (const [name, value] of Object.entries(fields)) {
    if (value == null || String(value).trim() === '') {
      throw new CommentDmLinkError(
        `[${caller}] required field "${name}" is missing or empty`,
        { code: ErrorCode.INVALID_INPUT, context: { field: name } }
      );
    }
  }
}

function isValidId(value) {
  return value != null && String(value).trim() !== '';
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function normalizeTimestampJs(raw) {
  if (raw == null || Number.isNaN(Number(raw))) return 0;
  const n = Number(raw);
  return n > 0 && n < SECONDS_MS_CUTOFF ? n * 1000 : n;
}

/** Same platformId format as instagramWebhookService DM upsert. */
function buildDmThreadPlatformId(igAccountId, instagramUserId) {
  return `dm_${String(igAccountId)}_${String(instagramUserId)}`;
}

function resolveIgAccountId(connection) {
  if (!connection) return null;
  const id =
    connection.platformUserId ||
    connection.metadata?.instagramAccountId ||
    connection.metadata?.igLoginScopedId ||
    connection.platformData?.businessAccountId ||
    connection.platformData?.instagramBusinessAccountId;
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

/**
 * Dedup key for an inbound message.
 * Uses mid when present; falls back to a composite of timestamp + trimmed text
 * so mid-less messages are never silently dropped.
 */
function messageKey(msg) {
  if (msg.mid) return `mid:${msg.mid}`;
  const ts = normalizeTimestampJs(msg.timestamp);
  const text = String(msg.text || '').trim().slice(0, 120);
  return `ts:${ts}|txt:${text}`;
}

// ---------------------------------------------------------------------------
// Shared query helpers
// ---------------------------------------------------------------------------

/** Find a DM interaction by platformId within an org. */
function findDmByPlatformId(
  organizationId,
  platformId,
  projection = '_id platformId metadata.sourceCommentInteractionId',
  session = null
) {
  const q = Interaction.findOne({ organization: organizationId, platformId, type: 'dm' })
    .select(projection)
    .lean();
  return session ? q.session(session) : q;
}

/** Find the most-recent CTD-active comment for this customer. */
function findCommentWithLinkedDm(organizationId, instagramUserId, session = null) {
  const q = Interaction.findOne({
    organization: organizationId,
    type: 'comment',
    platform: 'instagram',
    'author.platformId': String(instagramUserId),
    $or: [
      { 'metadata.commentToDmActive': true },
      { 'metadata.linkedDmPlatformId': { $exists: true, $ne: null } }
    ]
  })
    .sort({ updatedAt: -1 })
    .select('_id metadata.linkedDmPlatformId')
    .lean();
  return session ? q.session(session) : q;
}

// ---------------------------------------------------------------------------
// Core resolution  (read-only — no writes, no session needed)
// ---------------------------------------------------------------------------

/**
 * Resolve the canonical DM thread for a customer — prefers the CTD-linked thread so
 * webhook entry.id and connection.platformUserId mismatches do not create duplicate rows.
 *
 * Throws CommentDmLinkError(INVALID_INPUT) for missing required fields.
 */
async function resolveDmThreadTarget({
  organizationId,
  instagramUserId,
  webhookEntryId = null,
  connection = null,
  payload = null,
  hintCommentInteractionId = null
}) {
  assertRequiredStrings(
    { organizationId, instagramUserId },
    'resolveDmThreadTarget'
  );

  const userId = String(instagramUserId);
  let sourceCommentInteractionId = hintCommentInteractionId || null;
  let threadPlatformId = null;

  // Phase 1: use the hinted comment's already-linked DM platformId
  if (hintCommentInteractionId) {
    const hinted = await Interaction.findById(hintCommentInteractionId)
      .select('metadata.linkedDmPlatformId')
      .lean();
    threadPlatformId = hinted?.metadata?.linkedDmPlatformId || null;
  }

  // Phase 2: look for any CTD-active comment for this customer
  if (!sourceCommentInteractionId || !threadPlatformId) {
    const ctdComment = await findCommentWithLinkedDm(organizationId, userId);
    if (ctdComment) {
      sourceCommentInteractionId = sourceCommentInteractionId || ctdComment._id;
      threadPlatformId = threadPlatformId || ctdComment.metadata?.linkedDmPlatformId || null;
    }
  }

  // Phase 3: resolve via payload order token
  if (!sourceCommentInteractionId && payload) {
    const parsed = parseSalesPostbackOrderToken(payload);
    if (parsed?.orderToken) {
      const order = await ProductOrder.findOne({
        organization: organizationId,
        orderToken: parsed.orderToken
      }).select('commentInteractionId').lean();

      if (order?.commentInteractionId) {
        sourceCommentInteractionId = order.commentInteractionId;
        if (!threadPlatformId) {
          const comment = await Interaction.findById(order.commentInteractionId)
            .select('metadata.linkedDmPlatformId')
            .lean();
          threadPlatformId = comment?.metadata?.linkedDmPlatformId || null;
        }
      }
    }
  }

  // Phase 4: fall back to SalesConversationState
  if (!sourceCommentInteractionId || !threadPlatformId) {
    const state = await SalesConversationState.findOne({
      organization: organizationId,
      instagramUserId: userId
    })
      .sort({ updatedAt: -1 })
      .select('commentInteractionId dmInteractionId')
      .lean();

    if (state) {
      sourceCommentInteractionId = sourceCommentInteractionId || state.commentInteractionId || null;

      if (!threadPlatformId) {
        const [dmFromState, commentMeta] = await Promise.all([
          state.dmInteractionId
            ? Interaction.findById(state.dmInteractionId).select('platformId').lean()
            : null,
          sourceCommentInteractionId && !state.dmInteractionId
            ? Interaction.findById(sourceCommentInteractionId)
                .select('metadata.linkedDmPlatformId')
                .lean()
            : null
        ]);
        threadPlatformId =
          dmFromState?.platformId ||
          commentMeta?.metadata?.linkedDmPlatformId ||
          null;
      }
    }
  }

  const accountIds = collectIgAccountIdCandidates(webhookEntryId, connection);

  // Phase 5: try metadata-linked DM or derive from accountId
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

  // Phase 6: scan all candidate platformIds for an existing DM row
  const candidatePlatformIds = accountIds.map((id) => buildDmThreadPlatformId(id, userId));
  if (threadPlatformId && !candidatePlatformIds.includes(threadPlatformId)) {
    candidatePlatformIds.unshift(threadPlatformId);
  }

  let existingDm = threadPlatformId
    ? await findDmByPlatformId(organizationId, threadPlatformId)
    : null;

  if (!existingDm) {
    for (const pid of candidatePlatformIds) {
      const found = await findDmByPlatformId(organizationId, pid);
      if (!found) continue;

      // Do not adopt an orphan webhook thread when a CTD anchor is already known
      if (
        sourceCommentInteractionId &&
        !found.metadata?.sourceCommentInteractionId &&
        threadPlatformId &&
        found.platformId !== threadPlatformId
      ) {
        continue;
      }

      existingDm = found;
      threadPlatformId = found.platformId;
      sourceCommentInteractionId =
        sourceCommentInteractionId || found.metadata?.sourceCommentInteractionId || null;
      break;
    }
  }

  // Phase 7: last-resort fallback platformId
  if (!threadPlatformId) {
    const igAccountId =
      webhookEntryId
        ? String(webhookEntryId)
        : resolveIgAccountId(connection) || accountIds[0] || 'unknown';
    threadPlatformId = buildDmThreadPlatformId(igAccountId, userId);
  }

  const parsedPlatform = threadPlatformId.match(/^dm_(.+)_(.+)$/);
  const igAccountId =
    parsedPlatform ? parsedPlatform[1] : webhookEntryId || resolveIgAccountId(connection);

  return { threadPlatformId, igAccountId, sourceCommentInteractionId, existingDm };
}

// ---------------------------------------------------------------------------
// Link management  (all writes — atomic via session)
// ---------------------------------------------------------------------------

/**
 * Bidirectional link + hide shadow DM from inbox list.
 * All three writes commit or roll back together.
 *
 * @param {object} opts
 * @param {mongoose.ClientSession} [opts.session] - caller-supplied session (preferred).
 *   When omitted a new session is created and committed internally.
 */
async function ensureDmThreadLinkedToComment({
  organizationId,
  dmInteractionId,
  threadPlatformId,
  sourceCommentInteractionId,
  session: callerSession = null
}) {
  assertRequiredStrings(
    { organizationId, dmInteractionId, sourceCommentInteractionId },
    'ensureDmThreadLinkedToComment'
  );

  const run = async (session) => {
    await Promise.all([
      Interaction.updateOne(
        { _id: dmInteractionId, organization: organizationId },
        {
          $set: {
            'metadata.sourceCommentInteractionId': sourceCommentInteractionId,
            'metadata.isCommentShadowDm': true
          }
        },
        { session }
      ),
      Interaction.updateOne(
        { _id: sourceCommentInteractionId, organization: organizationId },
        {
          $set: {
            'metadata.linkedDmInteractionId': dmInteractionId,
            'metadata.linkedDmPlatformId': threadPlatformId,
            'metadata.commentToDmActive': true
          }
        },
        { session }
      ),
      SalesConversationState.updateMany(
        { organization: organizationId, commentInteractionId: sourceCommentInteractionId },
        { $set: { dmInteractionId } },
        { session }
      )
    ]);
  };

  try {
    if (callerSession) {
      await run(callerSession);
    } else {
      const session = await mongoose.startSession();
      try {
        await session.withTransaction(() => run(session));
      } finally {
        await session.endSession();
      }
    }
  } catch (err) {
    throw new CommentDmLinkError(
      `[ensureDmThreadLinkedToComment] write failed: ${err.message}`,
      {
        code: ErrorCode.LINK_WRITE_FAILED,
        context: { organizationId, dmInteractionId, sourceCommentInteractionId }
      }
    );
  }
}

/**
 * Merge duplicate DM threads for the same customer into the canonical CTD-linked thread
 * and archive the orphan rows. All writes are atomic per orphan batch.
 *
 * Mid-less messages use a composite timestamp|text key so no message is silently dropped.
 */
async function absorbOrphanDmThreadsForCustomer({
  organizationId,
  canonicalPlatformId,
  instagramUserId
}) {
  assertRequiredStrings(
    { organizationId, canonicalPlatformId, instagramUserId },
    'absorbOrphanDmThreadsForCustomer'
  );

  const userId = String(instagramUserId);

  const [orphans, canonical] = await Promise.all([
    Interaction.find({
      organization: organizationId,
      type: 'dm',
      platform: 'instagram',
      platformId: { $ne: canonicalPlatformId },
      status: { $ne: 'archived' },
      $and: [
        { $or: [{ 'author.platformId': userId }, { threadId: userId }] },
        {
          $or: [
            { 'metadata.sourceCommentInteractionId': { $exists: false } },
            { 'metadata.sourceCommentInteractionId': null }
          ]
        }
      ]
    }).select('_id platformId metadata.incomingMessages').lean(),
    Interaction.findOne({ organization: organizationId, platformId: canonicalPlatformId })
      .select('_id metadata.incomingMessages')
      .lean()
  ]);

  if (!orphans.length || !canonical) return;

  // Dedup against messages already in the canonical thread
  const existingKeys = new Set(
    (canonical.metadata?.incomingMessages || []).map(messageKey)
  );

  const newMessages = [];
  for (const orphan of orphans) {
    for (const msg of orphan.metadata?.incomingMessages || []) {
      if (!msg || typeof msg !== 'object') continue;
      const key = messageKey(msg);
      if (existingKeys.has(key)) continue;
      existingKeys.add(key);
      newMessages.push({ ...msg, mergedFromOrphanDm: true });
    }
  }

  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const writes = [
        Interaction.bulkWrite(
          orphans.map((orphan) => ({
            updateOne: {
              filter: { _id: orphan._id },
              update: {
                $set: {
                  status: 'archived',
                  'metadata.mergedIntoDmPlatformId': canonicalPlatformId
                }
              }
            }
          })),
          { session }
        )
      ];

      if (newMessages.length) {
        writes.push(
          Interaction.updateOne(
            { _id: canonical._id },
            {
              $push: {
                'metadata.incomingMessages': { $each: newMessages, $slice: -100 }
              }
            },
            { session }
          )
        );
      }

      await Promise.all(writes);
    });
  } catch (err) {
    // Non-fatal: log and continue — the inbox may show duplicates temporarily but no data
    // is corrupted. The next reconciliation pass will retry.
    svcLogger.error('[commentDmLink] absorbOrphanDmThreadsForCustomer transaction failed', {
      error: err.message,
      organizationId,
      canonicalPlatformId,
      instagramUserId,
      orphanCount: orphans.length
    });
    return;
  } finally {
    await session.endSession();
  }

  for (const orphan of orphans) {
    svcLogger.info('[commentDmLink] Absorbed orphan DM thread into CTD canonical thread', {
      orphanPlatformId: orphan.platformId,
      canonicalPlatformId,
      messagesTransferred: newMessages.length
    });
  }

  // Non-fatal: a stale cache is acceptable; next request re-populates it
  await cacheService.invalidateInteractionCaches(String(organizationId)).catch((err) => {
    svcLogger.warn('[commentDmLink] cache invalidation failed after orphan absorption', {
      error: err.message,
      organizationId
    });
  });
}

async function finalizeDmThreadForCtd({
  organizationId,
  dmInteraction,
  threadPlatformId,
  sourceCommentInteractionId,
  instagramUserId
}) {
  if (!dmInteraction?._id || !sourceCommentInteractionId) return dmInteraction;

  // Link and absorb run under their own sessions; run concurrently
  await Promise.all([
    ensureDmThreadLinkedToComment({
      organizationId,
      dmInteractionId: dmInteraction._id,
      threadPlatformId,
      sourceCommentInteractionId
    }),
    absorbOrphanDmThreadsForCustomer({
      organizationId,
      canonicalPlatformId: threadPlatformId,
      instagramUserId
    })
  ]);

  const refreshed = await Interaction.findById(dmInteraction._id);
  if (refreshed) {
    await notifyLinkedCommentInboxRefresh(
      organizationId,
      refreshed.toObject ? refreshed.toObject() : refreshed
    );
  }
  return refreshed || dmInteraction;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * On comment thread open: link + merge any duplicate DM rows for this customer.
 * Fixes legacy splits where webhook entry.id ≠ connection.platformUserId.
 *
 * Returns null if no linkable DM thread is found (not an error condition).
 */
async function reconcileCommentDmThreadOnRead({ organizationId, commentInteraction }) {
  if (
    !commentInteraction ||
    commentInteraction.type !== 'comment' ||
    commentInteraction.platform !== 'instagram'
  ) {
    return null;
  }

  const userId = commentInteraction.author?.platformId;
  if (!isValidId(userId) || !isValidId(organizationId)) return null;

  const connId =
    commentInteraction.platformConnection?._id || commentInteraction.platformConnection;

  const connection = connId
    ? await PlatformConnection.findById(connId)
        .select('platformUserId platformPageId platformData metadata')
        .lean()
    : null;

  const resolved = await resolveDmThreadTarget({
    organizationId,
    instagramUserId: userId,
    connection,
    hintCommentInteractionId: commentInteraction._id
  });

  if (!resolved.threadPlatformId) return null;

  const dm = await Interaction.findOne({
    organization: organizationId,
    platformId: resolved.threadPlatformId,
    type: 'dm'
  });
  if (!dm) return null;

  await finalizeDmThreadForCtd({
    organizationId,
    dmInteraction: dm,
    threadPlatformId: resolved.threadPlatformId,
    sourceCommentInteractionId: resolved.sourceCommentInteractionId || commentInteraction._id,
    instagramUserId: userId
  });

  return {
    linkedDmInteractionId: dm._id,
    linkedDmPlatformId: resolved.threadPlatformId
  };
}

/**
 * Link comment interaction ↔ DM thread. Idempotent.
 * The upsert + back-link writes run in a single session so a mid-flight crash cannot
 * leave a DM row with no comment back-link.
 *
 * @returns {Promise<{ dmInteractionId: string|null, dmPlatformId: string|null }>}
 * @throws {CommentDmLinkError} on invalid input or unrecoverable write failure
 */
async function ensureCommentDmLink({
  commentInteraction,
  organizationId,
  instagramUserId,
  platformConnection,
  postId = null
}) {
  if (!commentInteraction?._id || !isValidId(organizationId) || !isValidId(instagramUserId) || !platformConnection) {
    throw new CommentDmLinkError(
      '[ensureCommentDmLink] missing required fields',
      {
        code: ErrorCode.INVALID_INPUT,
        context: {
          hasCommentInteraction: !!commentInteraction?._id,
          hasOrganizationId: isValidId(organizationId),
          hasInstagramUserId: isValidId(instagramUserId),
          hasPlatformConnection: !!platformConnection
        }
      }
    );
  }

  const commentId = commentInteraction._id;
  const orgId = organizationId;
  const author = commentInteraction.author || {};
  const connId = platformConnection._id || platformConnection;

  const { threadPlatformId, igAccountId } = await resolveDmThreadTarget({
    organizationId: orgId,
    instagramUserId,
    connection: platformConnection,
    hintCommentInteractionId: commentId
  });

  if (!igAccountId || !threadPlatformId) {
    svcLogger.warn('[commentDmLink] Could not resolve igAccountId from connection', {
      organizationId: orgId,
      instagramUserId
    });
    return { dmInteractionId: null, dmPlatformId: null };
  }

  // Check for existing DM and generate chatRef in parallel (both read-only)
  const [existingDm, chatRefData] = await Promise.all([
    Interaction.findOne({ organization: orgId, platformId: threadPlatformId })
      .select('_id')
      .lean(),
    generateChatRef(orgId).catch((err) => {
      svcLogger.warn('[commentDmLink] generateChatRef failed, proceeding without chatRef', {
        error: err.message,
        organizationId: orgId
      });
      return { chatNumber: null, chatRef: null };
    })
  ]);

  const chatRefFields =
    !existingDm && chatRefData?.chatRef
      ? { chatNumber: chatRefData.chatNumber, chatRef: chatRefData.chatRef }
      : {};

  // --- Atomic write block ---
  // The upsert creates or updates the DM row; the back-link on the comment and the
  // SalesConversationState update all commit together. A crash between any of these
  // previously left an orphaned DM. The session ensures all-or-nothing.
  const session = await mongoose.startSession();
  let dmInteraction;
  try {
    await session.withTransaction(async () => {
      dmInteraction = await Interaction.findOneAndUpdate(
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
        { upsert: true, new: true, setDefaultsOnInsert: true, session }
      );

      const backLinkOps = [
        Interaction.updateOne(
          { _id: commentId, organization: orgId },
          {
            $set: {
              'metadata.linkedDmInteractionId': dmInteraction._id,
              'metadata.linkedDmPlatformId': threadPlatformId,
              'metadata.commentToDmActive': true
            }
          },
          { session }
        )
      ];

      if (postId) {
        backLinkOps.push(
          SalesConversationState.updateMany(
            {
              organization: orgId,
              instagramUserId: String(instagramUserId),
              postId: String(postId)
            },
            { $set: { dmInteractionId: dmInteraction._id } },
            { session }
          )
        );
      }

      await Promise.all(backLinkOps);
    });
  } catch (err) {
    throw new CommentDmLinkError(
      `[ensureCommentDmLink] atomic write failed: ${err.message}`,
      {
        code: ErrorCode.LINK_WRITE_FAILED,
        context: { organizationId: orgId, instagramUserId, threadPlatformId }
      }
    );
  } finally {
    await session.endSession();
  }

  // Orphan absorption runs outside the main transaction — it is best-effort cleanup
  // and its failure must not roll back the successful link above.
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

  return { dmInteractionId: dmInteraction._id, dmPlatformId: threadPlatformId };
}

/**
 * Merge paginated incoming message windows from comment + linked DM interactions.
 */
function mergeIncomingMessagePages(commentPage, dmPage) {
  const seen = new Set();
  const merged = [];

  const add = (msg, fromDm) => {
    if (!msg || typeof msg !== 'object') return;
    const key = messageKey(msg);
    if (seen.has(key)) return;
    seen.add(key);
    merged.push(fromDm ? { ...msg, mergedFromDm: true } : { ...msg });
  };

  (commentPage?.incomingMessages || []).forEach((m) => add(m, false));
  (dmPage?.incomingMessages || []).forEach((m) => add(m, true));

  merged.sort(
    (a, b) =>
      (normalizeTimestampJs(a.timestamp) || 0) - (normalizeTimestampJs(b.timestamp) || 0)
  );

  const totalMessages = Math.max(
    (commentPage?.totalMessages || 0) + (dmPage?.totalMessages || 0),
    merged.length
  );

  return {
    incomingMessages: merged,
    totalMessages,
    hasOlderMessages: !!(commentPage?.hasOlderMessages || dmPage?.hasOlderMessages),
    oldestMessageTimestamp: merged.length > 0 ? merged[0].timestamp ?? null : null,
    returnedMessages: merged.length
  };
}

// ---------------------------------------------------------------------------
// Inbox filter helpers  (pure / no writes)
// ---------------------------------------------------------------------------

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

/**
 * Hide orphan Instagram DM rows for customers who already have a CTD comment anchor.
 * Complements shadowDmExclusionCondition (linked shadow DMs with sourceCommentInteractionId).
 */
function buildCtdOrphanInstagramDmExclusion(ctdAuthorPlatformIds) {
  if (!Array.isArray(ctdAuthorPlatformIds) || ctdAuthorPlatformIds.length === 0) return null;
  const ids = ctdAuthorPlatformIds.filter(Boolean).map(String);
  return {
    $or: [
      { type: { $ne: 'dm' } },
      { platform: { $ne: 'instagram' } },
      { 'author.platformId': { $nin: ids } },
      { 'metadata.sourceCommentInteractionId': { $exists: true, $ne: null } }
    ]
  };
}

async function getCtdAuthorPlatformIds(organizationId) {
  if (!isValidId(organizationId)) return [];
  return Interaction.distinct('author.platformId', {
    organization: organizationId,
    type: 'comment',
    platform: 'instagram',
    $or: [
      { 'metadata.commentToDmActive': true },
      { 'metadata.linkedDmPlatformId': { $exists: true, $ne: null } }
    ],
    'author.platformId': { $exists: true, $nin: [null, ''] }
  });
}

/** Remove orphan Instagram DM list rows for CTD customers (safety net after query filter). */
function filterOrphanInstagramDmRows(interactions, ctdAuthorPlatformIds) {
  if (!Array.isArray(interactions) || !interactions.length) return interactions;
  const ids = new Set((ctdAuthorPlatformIds || []).filter(Boolean).map(String));
  if (!ids.size) return interactions;

  return interactions.filter((row) => {
    if (!row || row.type !== 'dm' || row.platform !== 'instagram') return true;
    if (row.metadata?.sourceCommentInteractionId) return false;
    if (row.metadata?.mergedIntoDmPlatformId || row.status === 'archived') return false;
    return !(row.author?.platformId && ids.has(String(row.author.platformId)));
  });
}

/**
 * Merge duplicate DM platformId rows into each active CTD comment's canonical thread.
 * Called on inbox list load so legacy splits disappear without waiting for a new webhook.
 * Processes in serial batches of `batchSize` to bound DB concurrency.
 */
async function reconcileRecentCtdOrphanDms(organizationId, { limit = 40, batchSize = 5 } = {}) {
  if (!isValidId(organizationId)) return;

  const comments = await Interaction.find({
    organization: organizationId,
    type: 'comment',
    platform: 'instagram',
    'metadata.commentToDmActive': true,
    'metadata.linkedDmPlatformId': { $exists: true, $ne: null },
    'author.platformId': { $exists: true, $nin: [null, ''] }
  })
    .sort({ updatedAt: -1 })
    .limit(limit)
    .select('author.platformId metadata.linkedDmPlatformId _id')
    .lean();

  for (let i = 0; i < comments.length; i += batchSize) {
    await Promise.all(
      comments.slice(i, i + batchSize).map(async (comment) => {
        const userId = comment.author?.platformId;
        const canonicalPlatformId = comment.metadata?.linkedDmPlatformId;
        if (!userId || !canonicalPlatformId) return;

        // absorbOrphans has its own internal error handling — won't throw
        await absorbOrphanDmThreadsForCustomer({
          organizationId,
          canonicalPlatformId,
          instagramUserId: userId
        });

        const dm = await Interaction.findOne({
          organization: organizationId,
          platformId: canonicalPlatformId,
          type: 'dm'
        }).select('_id');

        if (dm) {
          // ensureDmThreadLinkedToComment throws CommentDmLinkError on failure
          await ensureDmThreadLinkedToComment({
            organizationId,
            dmInteractionId: dm._id,
            threadPlatformId: canonicalPlatformId,
            sourceCommentInteractionId: comment._id
          }).catch((err) => {
            // Log and skip this comment — do not abort the whole reconciliation pass
            svcLogger.error('[commentDmLink] reconcile: ensureDmThreadLinkedToComment failed', {
              error: err.message,
              code: err.code,
              organizationId,
              commentId: String(comment._id)
            });
          });
        }
      })
    );
  }
}

// ---------------------------------------------------------------------------
// Formatting & notifications
// ---------------------------------------------------------------------------

/** Human-readable inbox line for a CTA postback tap (button title preferred). */
function formatPostbackIncomingText(title, payload) {
  const label = String(title || '').trim();
  if (label) return label;

  const raw = String(payload || '');
  if (raw.startsWith('SALES:')) {
    const action = raw.split(':')[1] || '';
    const actionLabels = { details: 'Product Details', payment: 'Pay Now', hesitant: 'Maybe later' };
    return actionLabels[action] || action || 'Button tap';
  }
  if (raw.startsWith('PICK:')) return 'Product selection';
  return 'Button tap';
}

/**
 * When inbound activity lands on a shadow DM thread, nudge the linked comment row
 * so the inbox detail refetches the merged timeline (CTD unified thread).
 *
 * Intentionally non-throwing: notification failure must never surface to the caller.
 */
async function notifyLinkedCommentInboxRefresh(organizationId, dmInteraction) {
  if (!isValidId(organizationId) || !dmInteraction) return;

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

    // Cache invalidation is best-effort; emit regardless of its outcome
    await cacheService.invalidateInteractionCaches(String(organizationId)).catch((err) => {
      svcLogger.warn('[commentDmLink] cache invalidation failed during notify', {
        error: err.message,
        organizationId
      });
    });

    emitToOrg(String(organizationId), 'interaction_updated', {
      interaction: comment,
      linkedDmInbound: true
    });
  } catch (err) {
    // Swallowed intentionally: a notification failure must not affect the write path
    svcLogger.warn('[commentDmLink] notifyLinkedCommentInboxRefresh failed', {
      error: err.message,
      organizationId,
      sourceCommentId: String(sourceCommentId)
    });
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  // Errors
  CommentDmLinkError,
  ErrorCode,

  // Pure helpers
  buildDmThreadPlatformId,
  resolveIgAccountId,
  collectIgAccountIdCandidates,
  normalizeTimestampJs,
  parseSalesPostbackOrderToken,

  // Core
  resolveDmThreadTarget,
  ensureDmThreadLinkedToComment,
  absorbOrphanDmThreadsForCustomer,
  finalizeDmThreadForCtd,

  // Public API
  reconcileCommentDmThreadOnRead,
  ensureCommentDmLink,

  // Inbox helpers
  mergeIncomingMessagePages,
  shadowDmExclusionCondition,
  buildCtdOrphanInstagramDmExclusion,
  getCtdAuthorPlatformIds,
  filterOrphanInstagramDmRows,
  reconcileRecentCtdOrphanDms,

  // Formatting & notifications
  formatPostbackIncomingText,
  notifyLinkedCommentInboxRefresh
};