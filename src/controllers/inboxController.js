const mongoose = require('mongoose');
const Interaction = require('../models/Interaction');
const Label = require('../models/Label');
const ResponseTemplate = require('../models/ResponseTemplate');
const cacheService = require('../services/cacheService');
const aiService = require('../services/aiService');
const { runWithAiContextAndUsageId } = require('../services/aiRequestContext');
const Organization = require('../models/Organization');
const escalationService = require('../services/escalationService');
const User = require('../models/User');
const PlatformConnection = require('../models/PlatformConnection');
const googleService = require('../integrations/google/googleService');
const axios = require('axios');
const logger = require('../config/logger');
const { generateChatRef } = require('../utils/chatRefHelper');
const replyService = require('../services/replyService');
const inboxBulkService = require('../services/inboxBulkService');
const inboxQueryService = require('../services/inbox/inboxQueryService');
const inboxAiAssistService = require('../services/inbox/inboxAiAssistService');
const { getIncomingMessagesPage } = require('../services/inbox/incomingMessagesPageService');
const { filterInboxReplies, isCampaignOnlyFailedThread } = require('../utils/campaignInboxFilter');

const {
  InboxQueryError,
  SLA_THRESHOLD_MS,
  parseQueryCsv,
  setQueryFieldInOrEquals,
  buildVisibilityFilter: buildPlatformConnectionVisibilityFilter
} = inboxQueryService;

const { InboxAiError, respondInboxAiError } = inboxAiAssistService;

// @desc    Get all interactions (inbox)
// @route   GET /api/inbox
exports.getInteractions = async (req, res, next) => {
  try {
    const orgId = req.user.organization._id;

    // Active platform connections scope what this org can see in the inbox.
    const activeConnections = await PlatformConnection.find({
      organization: orgId,
      isActive: true,
      status: 'connected'
    }).select('_id platform').lean();

    const {
      mongoQuery,
      effectiveSort,
      safePage,
      safeLimit,
      skip,
      searchTerm,
      cacheFilters
    } = inboxQueryService.buildListFilter({
      user: req.user,
      query: req.query,
      activeConnections
    });

    const cacheKey = cacheService.interactionsKey(orgId, cacheFilters);

    const cached = await cacheService.get(cacheKey);
    if (cached) {
      if (!cached.pagination) {
        cached.pagination = {
          page: safePage,
          limit: safeLimit,
          hasMore: Array.isArray(cached.interactions) ? cached.interactions.length >= safeLimit : false
        };
      }
      // Backward compat: older cached entries may lack pagination.total.
      if (typeof cached.pagination.total !== 'number') {
        cached.pagination.total = await Interaction.countDocuments(mongoQuery);
      }
      return res.status(200).json({ success: true, data: cached, cached: true });
    }

    // List projection: keeps only what the inbox list view needs.
    // - replies/$slice:-1  → only the most-recent reply (for last-message preview); avoids shipping entire reply threads
    // - metadata.incomingMessages/$slice:-1 → same for DM history
    // - heavy / detail-only fields excluded → internalNotes, assignmentHistory, sentimentHistory,
    //   raw email bodies, escalationMetadata; these are loaded on-demand in getInteraction()
    const LIST_PROJECTION = {
      replies: { $slice: -1 },
      'metadata.incomingMessages': { $slice: -1 },
      'metadata.email.htmlBody': 0,
      'metadata.email.textBody': 0,
      'metadata.email.rawHeaders': 0,
      'metadata.email.attachments': 0,
      internalNotes: 0,
      assignmentHistory: 0,
      sentimentHistory: 0,
      escalationMetadata: 0,
      topics: 0
    };

    // Run find + count concurrently — count was previously the tail latency (~hundreds of ms
    // on large orgs) and was issued only AFTER find resolved. Hint the same index via `.hint()`
    // would be even faster, but needs a named index; keep generic until we add one.
    const findPromise = Interaction.find(mongoQuery, LIST_PROJECTION)
      .populate('assignedTo', 'firstName lastName email avatar')
      .populate('assignedBy', 'firstName lastName email')
      .populate('labels', 'name color icon')
      .populate('replies.sentBy', 'firstName lastName')
      .populate('platformConnection', 'platform isActive status')
      .sort(effectiveSort)
      .limit(safeLimit + 1) // +1 to detect hasMore without relying solely on total
      .skip(skip)
      .lean();

    const countPromise = Interaction.countDocuments(mongoQuery);

    const [rawInteractions, total] = await Promise.all([findPromise, countPromise]);

    const hasMore = rawInteractions.length > safeLimit;
    let interactions = hasMore ? rawInteractions.slice(0, safeLimit) : rawInteractions;
    interactions = interactions.filter((row) => !isCampaignOnlyFailedThread(row));

    // Defer chatRef backfill — it's a best-effort legacy fixup, not something the
    // user is waiting for. Running it in-band made every list load pay for a write
    // round-trip per legacy row.
    const missingChatRef = interactions.filter((i) => !i.chatRef && i.organization);
    if (missingChatRef.length > 0) {
      setImmediate(() => {
        Promise.allSettled(
          missingChatRef.map(async (i) => {
            const refData = await generateChatRef(i.organization);
            if (refData?.chatRef) {
              await Interaction.updateOne(
                { _id: i._id, chatRef: null },
                { $set: { chatNumber: refData.chatNumber, chatRef: refData.chatRef } }
              );
            }
          })
        ).catch((err) => logger.warn('[inboxController] chatRef deferred backfill error', { error: err.message }));
      });
    }

    const result = {
      interactions,
      pagination: { page: safePage, limit: safeLimit, hasMore, total }
    };

    // Shorter TTL for search queries — they have high cardinality.
    const cacheTTL = searchTerm ? 120 : 300;
    await cacheService.set(cacheKey, result, cacheTTL);

    res.status(200).json({ success: true, data: result });
  } catch (error) {
    if (error instanceof InboxQueryError) {
      return res.status(error.statusCode).json({
        success: false,
        error: error.message,
        code: error.code
      });
    }
    next(error);
  }
};

// @desc    Get single interaction
// @route   GET /api/inbox/:id
// @access  Private
exports.getInteraction = async (req, res, next) => {
  try {
    const sortOrder = req.query.sortOrder === 'desc' ? 'desc' : 'asc';
    const sortDir = sortOrder === 'desc' ? -1 : 1;
    const orgId = req.user.organization._id;
    const interactionId = req.params.id;

    // Validate id early so we fail fast instead of throwing inside the aggregation match.
    if (!mongoose.Types.ObjectId.isValid(interactionId)) {
      return res.status(400).json({ success: false, error: 'Invalid interaction id' });
    }

    const rawLimit = parseInt(req.query.msgLimit, 10);
    const msgLimit = Math.min(
      Math.max(Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : 20, 1),
      300
    );
    const msgBeforeRaw = req.query.msgBefore;
    const msgBefore = msgBeforeRaw !== undefined && msgBeforeRaw !== null && msgBeforeRaw !== ''
      ? Number(msgBeforeRaw)
      : null;

    // ── PROJECTION ────────────────────────────────────────────────────────────
    // 1. Exclude heavy fields never rendered in the chat UI (analytics/escalation only).
    // 2. For the initial page (no msgBefore) we apply **query-level $slice** on
    //    metadata.incomingMessages. MongoDB applies $slice at BSON read time, so only the
    //    last N messages are ever sent over the wire — the full (potentially 10k+) array
    //    never leaves storage. This is dramatically faster than aggregation pipelines that
    //    project the array first and slice later.
    // 3. For older-page loads (msgBefore present) we EXCLUDE the array entirely on the
    //    main read and fetch the slice via a bounded aggregation in parallel.
    const baseProjection = {
      sentimentHistory: 0,
      escalationMetadata: 0
    };
    // Main document read: never pull `metadata.incomingMessages` over the wire here — that array is
    // sliced + globally sorted in getIncomingMessagesPage() so we always return the **latest** N
    // inbound messages first (append-only webhooks are ascending, but Graph sync may be newest-first).
    const detailProjection = { ...baseProjection, 'metadata.incomingMessages': 0 };

    // ── PARALLEL BATCH ────────────────────────────────────────────────────────
    // - Main doc (no embedded DM array)
    // - Message page: sort asc by canonical ms → tail slice (latest page) or older window via msgBefore
    const objectId = new mongoose.Types.ObjectId(interactionId);
    const mainQuery = Interaction.findOne({ _id: objectId, organization: orgId }, detailProjection)
      .populate('assignedTo', 'firstName lastName email avatar')
      .populate('labels', 'name color icon')
      .populate('replies.sentBy', 'firstName lastName avatar')
      .populate('platformConnection', 'platform platformUsername platformDisplayName platformProfilePicture')
      .lean();

    const messagesPagePromise = getIncomingMessagesPage(Interaction, interactionId, { msgLimit, msgBefore });

    const [interaction, messagesPage] = await Promise.all([mainQuery, messagesPagePromise]);

    if (!interaction) {
      return res.status(404).json({ success: false, error: 'Interaction not found' });
    }

    // Agents can only view interactions assigned to them or previously assigned to them.
    if (req.user.role === 'agent') {
      const assignedToId = interaction.assignedTo?._id || interaction.assignedTo;
      const isAssigned = assignedToId && String(assignedToId) === String(req.user._id);
      const wasPreviouslyAssigned = (interaction.assignmentHistory || []).some((h) => {
        const hid = h.assignedTo?._id || h.assignedTo;
        return hid && String(hid) === String(req.user._id);
      });
      if (!isAssigned && !wasPreviouslyAssigned) {
        return res.status(403).json({ success: false, error: 'Access denied' });
      }
    }

    // Fire-and-forget markRead so the response isn't blocked on a write + cache flush.
    if (req.query.markRead === 'true' && (!interaction.isRead || interaction.status === 'unread')) {
      const now = new Date();
      const wasUnread = interaction.status === 'unread';
      interaction.isRead = true;
      interaction.readAt = now;
      interaction.readBy = req.user._id;
      if (wasUnread) interaction.status = 'read';

      setImmediate(() => {
        Interaction.updateOne(
          { _id: interaction._id },
          {
            $set: {
              isRead: true,
              readAt: now,
              readBy: req.user._id,
              ...(wasUnread ? { status: 'read' } : {})
            }
          }
        )
          .then(() => cacheService.invalidateInteractionListCaches(orgId))
          .catch((err) => logger.warn('[inboxController] markRead deferred error', { error: err.message }));
      });
    }

    // ── ASSIGNMENT HISTORY: dedupe FIRST, then batch-populate users ────────────
    // The old code populated every assignmentHistory entry (sometimes hundreds of dupes
    // from a legacy processAI bug), then deduped. That forced Mongoose to resolve N User
    // refs per doc. Dedupe first → collect unique user ids → one User.find → patch.
    const rawHistory = interaction.assignmentHistory || [];
    const seenKeys = new Set();
    const dedupedHistory = rawHistory.filter((h) => {
      const key = `${String(h.assignedTo || '')}_${String(h.assignedAt ? new Date(h.assignedAt).getTime() : '')}`;
      if (seenKeys.has(key)) return false;
      seenKeys.add(key);
      return true;
    });

    const userIdsToLoad = new Set();
    dedupedHistory.forEach((h) => {
      if (h.assignedTo) userIdsToLoad.add(String(h.assignedTo));
      if (h.assignedBy) userIdsToLoad.add(String(h.assignedBy));
    });
    (interaction.internalNotes || []).forEach((n) => {
      if (n.addedBy) userIdsToLoad.add(String(n.addedBy));
    });
    if (interaction.assignedBy) userIdsToLoad.add(String(interaction.assignedBy));

    let userMap;
    if (userIdsToLoad.size > 0) {
      const users = await User.find(
        { _id: { $in: Array.from(userIdsToLoad) } },
        'firstName lastName email avatar'
      ).lean();
      userMap = new Map(users.map((u) => [String(u._id), u]));
    } else {
      userMap = new Map();
    }

    const resolveUser = (ref) => {
      if (!ref) return ref;
      const id = typeof ref === 'object' ? String(ref._id || ref) : String(ref);
      return userMap.get(id) || ref;
    };

    interaction.assignmentHistory = dedupedHistory.map((h) => ({
      ...h,
      assignedTo: h.assignedTo ? resolveUser(h.assignedTo) : null,
      assignedBy: h.assignedBy ? resolveUser(h.assignedBy) : null
    }));
    interaction.internalNotes = (interaction.internalNotes || []).map((n) => ({
      ...n,
      addedBy: n.addedBy ? resolveUser(n.addedBy) : null
    }));
    if (interaction.assignedBy) {
      interaction.assignedBy = resolveUser(interaction.assignedBy);
    }

    // ── MESSAGES + PAGINATION META ────────────────────────────────────────────
    const totalMessages = messagesPage?.totalMessages ?? 0;
    const incomingMessages = messagesPage?.incomingMessages || [];
    const hasOlderMessages = !!messagesPage?.hasOlderMessages;
    const oldestMessageTimestamp =
      messagesPage?.oldestMessageTimestamp != null ? messagesPage.oldestMessageTimestamp : null;
    const returnedMessages = messagesPage?.returnedMessages ?? incomingMessages.length;

    interaction.metadata = interaction.metadata || {};
    interaction.metadata.incomingMessages = incomingMessages;
    interaction.metadata.messagePagination = {
      hasOlderMessages,
      oldestMessageTimestamp,
      totalMessages,
      returnedMessages
    };

    const interactionObj = interaction;

    // ── CHILD REPLIES (from other users on the platform) ──────────────────────
    // Uses the `{ parentId, organization }` compound index — one round-trip.
    const childInteractions = await Interaction.find({
      $or: [
        { parentId: String(interactionObj._id) },
        { parentId: interactionObj.platformId }
      ],
      organization: orgId
    })
      .select('_id content author sentiment platform platformId platformCreatedAt platformUrl')
      .sort({ platformCreatedAt: sortDir })
      .lean();

    // Hide soft-deleted app replies and failed campaign sends from thread rendering.
    interactionObj.replies = filterInboxReplies(interactionObj.replies || []);

    // Get all platformResponseIds from app replies to filter out our own replies
    const appReplyPlatformIds = new Set(
      (interactionObj.replies || [])
        .map(reply => reply.platformResponseId)
        .filter(id => id != null) // Filter out null/undefined
    );

    // Merge child interactions with app replies for a complete thread
    // Child interactions are replies from other users on the platform
    // IMPORTANT: Filter out child interactions that match our own platformResponseId
    // (These are our own replies that came back from the platform during sync)
    if (childInteractions.length > 0) {
      // Filter out child interactions that are our own replies
      const externalReplies = childInteractions.filter(child => {
        // If this child interaction's platformId matches any of our app replies' platformResponseId,
        // it means this is our own reply that came back from the platform - skip it
        if (appReplyPlatformIds.has(child.platformId)) {
          logger.debug('[Inbox] filtering out duplicate reply', { platformId: child.platformId });
          return false;
        }
        return true;
      });

      // Transform child interactions to match reply format
      const platformReplies = externalReplies.map(child => ({
        _id: child._id,
        content: child.content,
        sentBy: child.author.name, // From platform user (not app user)
        sentAt: child.platformCreatedAt,
        platform: child.platform,
        platformId: child.platformId,
        status: 'received', // These are received from platform, not sent
        isPlatformReply: true, // Flag to distinguish from app replies
        author: child.author, // Include full author info
        sentiment: child.sentiment,
        platformUrl: child.platformUrl
      }));

      // Merge app replies and platform replies, sort by date
      const allReplies = [
        ...(interactionObj.replies || []).map(r => ({ ...r, isPlatformReply: false })),
        ...platformReplies
      ].sort((a, b) =>
        sortDir === 1
          ? new Date(a.sentAt) - new Date(b.sentAt)
          : new Date(b.sentAt) - new Date(a.sentAt)
      );

      interactionObj.replies = allReplies;
      interactionObj.totalReplies = allReplies.length;
      interactionObj.platformRepliesCount = platformReplies.length;
    } else if (interactionObj.replies && interactionObj.replies.length > 0) {
      // Keep app replies sorted even when there are no child interactions.
      interactionObj.replies = [...interactionObj.replies].sort((a, b) =>
        sortDir === 1
          ? new Date(a.sentAt) - new Date(b.sentAt)
          : new Date(b.sentAt) - new Date(a.sentAt)
      );
    }

    res.status(200).json({
      success: true,
      data: interactionObj,
      pagination: {
        hasOlderMessages,
        oldestMessageTimestamp,
        totalMessages,
        returnedMessages
      }
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Soft-delete a reply (hide from thread, keep in DB)
// @route   DELETE /api/inbox/:id/replies/:replyId
// @access  Private
exports.deleteReply = async (req, res, next) => {
  try {
    const { id, replyId } = req.params;
    const interaction = await Interaction.findById(id);

    if (!interaction) {
      return res.status(404).json({
        success: false,
        error: 'Interaction not found'
      });
    }

    if (interaction.organization.toString() !== req.user.organization._id.toString()) {
      return res.status(403).json({
        success: false,
        error: 'Access denied'
      });
    }

    const reply = interaction.replies.id(replyId);
    if (!reply) {
      return res.status(404).json({
        success: false,
        error: 'Reply not found'
      });
    }

    // Only allow hiding replies that failed to send (unsent/error state).
    if (reply.status !== 'failed') {
      return res.status(400).json({
        success: false,
        error: 'Only failed replies can be hidden'
      });
    }

    // Allow original sender, manager, or admin to hide the reply.
    const isOwner = reply.sentBy?.toString?.() === req.user._id.toString();
    const isPrivileged = ['admin', 'manager'].includes(req.user.role);
    if (!isOwner && !isPrivileged) {
      return res.status(403).json({
        success: false,
        error: 'You can only hide your own failed reply'
      });
    }

    reply.status = 'deleted';
    await interaction.save();

    await cacheService.invalidateInteractionCaches(req.user.organization._id);

    return res.status(200).json({
      success: true,
      message: 'Reply hidden from conversation'
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Reply to interaction
// @route   POST /api/inbox/:id/reply
// @access  Private
exports.replyToInteraction = async (req, res, next) => {
  let instagramPdfCleanup = [];
  try {
    const {
      content,
      useTemplate,
      templateId,
      templateVariables,
      attachmentUrl,
      attachmentType,
      whatsappTemplate,
      whatsappTemplatePreview: whatsappTemplatePreviewBody
    } = req.body;

    const {
      sanitizeWhatsAppOutboundTemplate
    } = require('../utils/whatsappOutboundTemplate');

    // Resolve local disk path so Meta can receive the file directly (avoids ngrok/tunnel issues)
    let attachmentLocalPath = null;
    if (attachmentUrl) {
      const urlFilename = attachmentUrl.split('/').pop();
      if (urlFilename) {
        const candidate = require('path').join(__dirname, '../../uploads/posts', urlFilename);
        if (require('fs').existsSync(candidate)) attachmentLocalPath = candidate;
      }
    }

    // Convert webm audio → m4a (Meta APIs do not accept webm)
    if (attachmentType === 'audio' && attachmentLocalPath && /\.webm$/i.test(attachmentLocalPath)) {
      try {
        const { convertToM4a } = require('../utils/audioConverter');
        attachmentLocalPath = await convertToM4a(attachmentLocalPath);
      } catch (convErr) {
        logger.warn('[replyToInteraction] Audio conversion failed, trying original file', { error: convErr.message });
      }
    }

    const interaction = await Interaction.findById(req.params.id).populate('platformConnection');
    if (!interaction) {
      return res.status(404).json({ success: false, error: 'Interaction not found' });
    }
    if (interaction.organization.toString() !== req.user.organization._id.toString()) {
      return res.status(403).json({ success: false, error: 'Access denied' });
    }
    if (req.user.role === 'agent') {
      const assignedToId = interaction.assignedTo?.toString?.() || interaction.assignedTo;
      if (assignedToId !== req.user._id.toString()) {
        return res.status(403).json({ success: false, error: 'You can only reply to conversations assigned to you' });
      }
    }

    // Resolve template content if requested
    let replyContent = content;
    if (useTemplate && templateId) {
      const template = await ResponseTemplate.findById(templateId);
      if (template) {
        replyContent = template.render(templateVariables || {});
        await template.incrementUsage();
      }
    }

    const sanitizedWaTemplate =
      whatsappTemplate && interaction.platform === 'whatsapp'
        ? sanitizeWhatsAppOutboundTemplate(whatsappTemplate)
        : null;

    if (whatsappTemplate && interaction.platform !== 'whatsapp') {
      return res.status(400).json({
        success: false,
        error: 'WhatsApp templates can only be used for WhatsApp conversations.'
      });
    }

    if (whatsappTemplate && interaction.platform === 'whatsapp' && !sanitizedWaTemplate) {
      return res.status(400).json({
        success: false,
        error: 'Invalid WhatsApp template payload. Provide template name (snake_case) and language.'
      });
    }

    if (sanitizedWaTemplate && attachmentUrl) {
      return res.status(400).json({
        success: false,
        error: 'Send either a WhatsApp template or an attachment — not both.'
      });
    }

    let whatsappTemplatePreview = null;
    if (sanitizedWaTemplate?.name) {
      const WhatsAppTemplate = require('../models/WhatsAppTemplate');
      const {
        buildWhatsAppTemplatePreview,
        mergeWhatsAppTemplatePreviews
      } = require('../utils/whatsappTemplatePreview');
      const { sanitizeWhatsAppInboundPreview } = require('../utils/sanitizeWhatsAppInboundPreview');
      const connId =
        interaction.platformConnection?._id?.toString?.() ||
        interaction.platformConnection?.toString?.() ||
        interaction.platformConnection ||
        null;
      let dbTemplate = null;
      if (connId) {
        dbTemplate = await WhatsAppTemplate.findOne({
          organization: interaction.organization,
          connection: connId,
          name: sanitizedWaTemplate.name,
          language: sanitizedWaTemplate.languageCode
        }).lean();
      }
      const serverBuilt = buildWhatsAppTemplatePreview(sanitizedWaTemplate, dbTemplate);
      const uiPreviewRaw =
        whatsappTemplatePreviewBody ??
        (whatsappTemplate && typeof whatsappTemplate === 'object'
          ? whatsappTemplate.inboxUiPreview
          : undefined);
      const inbound = sanitizeWhatsAppInboundPreview(uiPreviewRaw, {
        expectedName: sanitizedWaTemplate.name,
        expectedLanguageCode: sanitizedWaTemplate.languageCode
      });
      whatsappTemplatePreview = mergeWhatsAppTemplatePreviews(serverBuilt, inbound);

      const bodyLine = String(whatsappTemplatePreview.bodyText || '').trim();
      replyContent =
        bodyLine ||
        `[WhatsApp Template] ${sanitizedWaTemplate.name} (${sanitizedWaTemplate.languageCode})`;
    }

    if (
      interaction.platform === 'instagram' &&
      interaction.type === 'dm' &&
      attachmentType === 'file' &&
      (attachmentUrl || attachmentLocalPath)
    ) {
      const { prepareInstagramDmPdfAttachment } = require('../utils/instagramDmPdfAttachment');
      try {
        const prep = await prepareInstagramDmPdfAttachment({
          attachmentUrl,
          attachmentLocalPath
        });
        attachmentLocalPath = prep.localPath;
        instagramPdfCleanup = prep.cleanupPaths;
      } catch (prepErr) {
        logger.warn('[replyToInteraction] Instagram PDF preparation failed', {
          error: prepErr.message
        });
        return res.status(400).json({
          success: false,
          error: prepErr.message || 'Could not prepare PDF for Instagram DM.'
        });
      }
    }

    if (
      interaction.platform === 'whatsapp' &&
      !sanitizedWaTemplate?.name &&
      attachmentUrl &&
      attachmentType &&
      ['image', 'video', 'file'].includes(attachmentType)
    ) {
      const trimmed =
        replyContent == null || replyContent === undefined ? '' : String(replyContent).trim();
      const placeholderOnly = /^\[(image|video|audio|file|attachment)\]$/i.test(trimmed);
      if (!trimmed || placeholderOnly) {
        return res.status(400).json({
          success: false,
          error:
            'WhatsApp requires a message to send with images, videos, or files. Enter text in the message field and try again.'
        });
      }
    }

    // Resolve the correct platform connection and dispatch the send
    const connection = await replyService.resolveConnection(interaction);
    const { platformResponseId, status: replyStatus, errorMessage } = await replyService.sendReplyToPlatform({
      interaction,
      connection,
      replyContent,
      attachmentUrl,
      attachmentType,
      attachmentLocalPath,
      whatsappTemplate: sanitizedWaTemplate
    });

    // Persist reply in DB
    const previousStatus = interaction.status;
    await interaction.addReply(
      replyContent,
      req.user._id,
      platformResponseId,
      false,
      attachmentUrl || undefined,
      attachmentType || undefined,
      undefined,
      undefined,
      whatsappTemplatePreview || undefined
    );
    await interaction.populate('replies.sentBy', 'firstName lastName');

    if (replyStatus === 'failed') {
      if (interaction.replies?.length > 0) {
        interaction.replies[interaction.replies.length - 1].status = 'failed';
      }
      interaction.status = previousStatus;
      await interaction.save();
    } else {
      interaction.respondedAt = new Date();
      interaction.chatOpen = true;
      await interaction.save();

      // Cancel any pending AI / auto-reply jobs — this conversation is already answered
      try {
        const { aiQueue, autoReplyQueue } = require('../config/queue');
        const allPending = [
          ...(await aiQueue.getJobs(['waiting', 'active', 'delayed'])),
          ...(await autoReplyQueue.getJobs(['waiting', 'active', 'delayed']))
        ];
        for (const job of allPending) {
          if (job.data.interactionId?.toString() === interaction._id.toString()) {
            await job.remove();
          }
        }
      } catch (queueError) {
        logger.warn('[replyToInteraction] Could not cancel pending AI/auto-reply jobs', { error: queueError.message });
      }
    }

    await cacheService.invalidateInteractionCaches(req.user.organization._id);

    if (replyStatus === 'sent') {
      return res.status(200).json({ success: true, data: interaction, message: 'Reply sent successfully' });
    }
    logger.error('[replyToInteraction] Platform send failed', { error: errorMessage });
    return res.status(500).json({
      success: false,
      error: errorMessage || 'Failed to send reply to platform',
      data: interaction,
      message: 'Reply saved locally but failed to post to platform'
    });
  } catch (error) {
    next(error);
  } finally {
    if (instagramPdfCleanup.length > 0) {
      try {
        const { cleanupTempFiles } = require('../utils/instagramDmPdfAttachment');
        await cleanupTempFiles(instagramPdfCleanup);
      } catch (cleanErr) {
        logger.warn('[replyToInteraction] Instagram PDF temp cleanup', { error: cleanErr.message });
      }
    }
  }
};

// @desc    Delete a Facebook comment (from Facebook and from DB)
// @route   DELETE /api/inbox/:id
// @access  Private
exports.deleteInteraction = async (req, res, next) => {
  try {
    const interaction = await Interaction.findById(req.params.id)
      .populate('platformConnection');

    if (!interaction) {
      return res.status(404).json({
        success: false,
        error: 'Interaction not found'
      });
    }

    if (interaction.organization.toString() !== req.user.organization._id.toString()) {
      return res.status(403).json({
        success: false,
        error: 'Access denied'
      });
    }

    // Only Facebook comments can be deleted on the platform; we still remove from DB for any type if needed later
    const isFacebookComment = interaction.platform === 'facebook' && interaction.type === 'comment';

    if (isFacebookComment) {
      let connection = interaction.platformConnection;
      if (!connection && interaction.organization) {
        connection = await PlatformConnection.findOne({
          organization: interaction.organization,
          platform: 'facebook',
          status: 'connected',
          isActive: true
        }).lean();
      }
      if (!connection || connection.status !== 'connected' || !connection.isActive) {
        return res.status(400).json({
          success: false,
          error: 'Facebook Page connection not found or inactive. Reconnect the Page in Settings to delete comments on Facebook.'
        });
      }
      const facebookService = require('../integrations/meta/facebookService');
      const result = await facebookService.deleteComment(connection, interaction.platformId);
      if (!result.success) {
        return res.status(400).json({
          success: false,
          error: result.error || 'Failed to delete comment on Facebook'
        });
      }
    }

    // Delete child interactions (replies that reference this interaction)
    await Interaction.deleteMany({
      organization: interaction.organization,
      $or: [
        { parentId: interaction._id.toString() },
        { parentId: interaction.platformId }
      ]
    });

    await Interaction.findByIdAndDelete(interaction._id);

    await cacheService.invalidateInteractionCaches(req.user.organization._id);

    return res.status(200).json({
      success: true,
      message: isFacebookComment
        ? 'Comment deleted from Facebook and from inbox.'
        : 'Interaction removed from inbox.'
    });
  } catch (error) {
    logger.error('[inboxController] deleteInteraction error', { error: error.message });
    next(error);
  }
};

// @desc    Assign interaction to agent (or unassign if userId is empty)
// @route   PUT /api/inbox/:id/assign
// @access  Private (Manager/Admin)
exports.assignInteraction = async (req, res, next) => {
  try {
    const { userId, reason } = req.body;

    const interaction = await Interaction.findById(req.params.id);

    if (!interaction) {
      return res.status(404).json({
        success: false,
        error: 'Interaction not found'
      });
    }

    // Handle unassignment (empty userId)
    if (!userId || userId === '') {
      // Track unassignment in history (with null assignedTo)
      if (!interaction.assignmentHistory) {
        interaction.assignmentHistory = [];
      }
      interaction.assignmentHistory.push({
        assignedTo: null,
        assignedBy: req.user._id,
        assignedAt: new Date(),
        reason: 'unassignment'
      });

      interaction.assignedTo = undefined;
      interaction.assignedBy = undefined;
      interaction.assignedAt = undefined;
      interaction.assignmentReason = undefined;
      interaction.status = 'pending';
      await interaction.save();

      // Clear cache
      await cacheService.invalidateInteractionCaches(req.user.organization._id);

      return res.status(200).json({
        success: true,
        data: interaction,
        message: 'Interaction unassigned successfully'
      });
    }

    // Verify agent exists
    const agent = await User.findById(userId);
    if (!agent) {
      return res.status(404).json({
        success: false,
        error: 'Agent not found'
      });
    }

    await interaction.assignTo(userId, req.user._id, reason || 'manual');

    // Populate assignedTo and assignedBy for response
    await interaction.populate('assignedTo', 'firstName lastName email');
    await interaction.populate('assignedBy', 'firstName lastName email');

    // Create in-app notification
    const Notification = require('../models/Notification');
    try {
      await Notification.create({
        user: userId,
        organization: req.user.organization._id,
        type: 'assignment',
        title: 'New Interaction Assigned',
        message: `A ${interaction.type} from ${interaction.platform} has been assigned to you.`,
        relatedTo: {
          model: 'Interaction',
          id: interaction._id
        },
        actionUrl: `/app/inbox/${interaction._id}`,
        deliveryMethod: ['in_app', 'email']
      });
      logger.info('[Assignment] in-app notification created', { email: agent.email });
    } catch (notifError) {
      logger.error('[Assignment] failed to create notification', { error: notifError.message });
    }

    // Send email notification
    const emailService = require('../services/emailService');
    try {
      await emailService.sendAssignmentNotification(agent, interaction);
      logger.info('[Assignment] email sent', { email: agent.email });
    } catch (emailError) {
      logger.error('[Assignment] failed to send assignment email', { error: emailError.message });
      // Don't fail the assignment if email fails
    }

    // Clear cache
    await cacheService.invalidateInteractionCaches(req.user.organization._id);

    res.status(200).json({
      success: true,
      data: interaction,
      message: `Interaction assigned to ${agent.firstName} ${agent.lastName} successfully`
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Add label to interaction
// @route   PUT /api/inbox/:id/labels
// @access  Private
exports.addLabel = async (req, res, next) => {
  try {
    const { labelId } = req.body;

    const interaction = await Interaction.findById(req.params.id);

    if (!interaction) {
      return res.status(404).json({
        success: false,
        error: 'Interaction not found'
      });
    }

    // Check if label exists
    const label = await Label.findById(labelId);
    if (!label) {
      return res.status(404).json({
        success: false,
        error: 'Label not found'
      });
    }

    // Add label if not already added
    if (!interaction.labels.includes(labelId)) {
      interaction.labels.push(labelId);
      await interaction.save();
      await label.incrementUsage();
    }

    // Clear cache
    await cacheService.invalidateInteractionCaches(req.user.organization._id);

    res.status(200).json({
      success: true,
      data: interaction
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Add internal note
// @route   POST /api/inbox/:id/notes
// @access  Private
exports.addNote = async (req, res, next) => {
  try {
    const { note, isPrivate } = req.body;

    const interaction = await Interaction.findById(req.params.id);

    if (!interaction) {
      return res.status(404).json({
        success: false,
        error: 'Interaction not found'
      });
    }

    await interaction.addNote(note, req.user._id, isPrivate);

    res.status(200).json({
      success: true,
      data: interaction
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Update interaction status
// @route   PUT /api/inbox/:id/status
// @access  Private
exports.updateStatus = async (req, res, next) => {
  try {
    const { status } = req.body;

    const interaction = await Interaction.findById(req.params.id);

    if (!interaction) {
      return res.status(404).json({
        success: false,
        error: 'Interaction not found'
      });
    }

    interaction.status = status;
    
    if (status === 'resolved') {
      interaction.resolvedAt = new Date();
    }

    await interaction.save();

    // Clear cache
    await cacheService.invalidateInteractionCaches(req.user.organization._id);

    res.status(200).json({
      success: true,
      data: interaction
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Set chat session open/closed (inbox agent workflow)
// @route   PUT /api/inbox/:id/chat-open
// @access  Private
exports.updateChatOpen = async (req, res, next) => {
  try {
    const { chatOpen } = req.body;
    if (typeof chatOpen !== 'boolean') {
      return res.status(400).json({
        success: false,
        error: 'chatOpen must be a boolean'
      });
    }

    const interaction = await Interaction.findOne({
      _id: req.params.id,
      organization: req.user.organization._id
    });

    if (!interaction) {
      return res.status(404).json({
        success: false,
        error: 'Interaction not found'
      });
    }

    if (req.user.role === 'agent') {
      const assignedToId = interaction.assignedTo?.toString?.() || interaction.assignedTo;
      if (assignedToId !== req.user._id.toString()) {
        return res.status(403).json({
          success: false,
          error: 'You can only update conversations assigned to you'
        });
      }
    }

    interaction.chatOpen = chatOpen;
    await interaction.save();

    await cacheService.invalidateInteractionCaches(req.user.organization._id);

    const populated = await Interaction.findById(interaction._id)
      .populate('assignedTo', 'firstName lastName email avatar')
      .populate('assignedBy', 'firstName lastName email')
      .populate('labels', 'name color icon')
      .populate('replies.sentBy', 'firstName lastName')
      .populate('platformConnection', 'platform isActive status');

    res.status(200).json({
      success: true,
      data: populated
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get inbox stats
// @route   GET /api/inbox/stats
// @access  Private
// @query   platform (optional) - filter by platform for per-platform stats
exports.getStats = async (req, res, next) => {
  try {
    const orgId = req.user.organization._id;
    const { platform } = req.query;

    // Active platform connections scope what counts toward inbox stats.
    const activeConnections = await PlatformConnection.find({
      organization: orgId,
      isActive: true,
      status: 'connected'
    }).select('_id platform').lean();

    const matchStage = inboxQueryService.buildStatsMatchStage({
      orgId,
      platform,
      activeConnections
    });
    const slaCutoff = new Date(Date.now() - SLA_THRESHOLD_MS);
    const pipeline = inboxQueryService.buildStatsAggregationPipeline({ matchStage, slaCutoff });

    const stats = await Interaction.aggregate(pipeline);

    const data = stats[0] || {};
    if (!data.responseRate && data.total === undefined) {
      data.responseRate = 0;
    }

    res.status(200).json({ success: true, data });
  } catch (error) {
    if (error instanceof InboxQueryError) {
      return res.status(error.statusCode).json({
        success: false,
        error: error.message,
        code: error.code
      });
    }
    next(error);
  }
};

// @desc    Get org labels
// @route   GET /api/inbox/labels
// @access  Private
exports.getLabels = async (req, res, next) => {
  try {
    let labels = await Label.find({ organization: req.user.organization._id })
      .select('_id name color icon')
      .sort({ name: 1 })
      .lean();
    
    // Auto-create default labels if none exist
    if (labels.length === 0) {
      const labelService = require('../services/labelService');
      const created = await labelService.ensureDefaultLabels(
        req.user.organization._id,
        req.user._id
      );
      labels = created.map(l => ({
        _id: l._id,
        name: l.name,
        color: l.color,
        icon: l.icon
      }));
    }
    
    res.status(200).json({
      success: true,
      data: labels
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Generate AI suggested reply for interaction
// @route   POST /api/inbox/:id/suggest-reply
// @access  Private
exports.suggestReply = async (req, res, next) => {
  try {
    const { data, credits } = await inboxAiAssistService.suggestReplyFor({
      interactionId: req.params.id,
      user: req.user
    });
    return res.status(200).json({
      success: true,
      data,
      credits,
      message: 'AI reply generated successfully'
    });
  } catch (err) {
    if (err instanceof InboxAiError) return respondInboxAiError(res, err);
    logger.error('[inboxController] suggestReply error', { error: err.message });
    next(err);
  }
};

// @desc    Generate AI-assisted replies (short, detailed, sales) for a conversation
// @route   POST /api/inbox/:id/ai-assist
// @access  Private
exports.aiAssist = async (req, res, next) => {
  try {
    const { data, credits } = await inboxAiAssistService.generateAssistTriple({
      interactionId: req.params.id,
      user: req.user
    });
    return res.status(200).json({
      success: true,
      data,
      credits,
      message: 'AI assistance generated successfully'
    });
  } catch (err) {
    if (err instanceof InboxAiError) return respondInboxAiError(res, err);
    logger.error('[inboxController] aiAssist error', { error: err.message });
    next(err);
  }
};

// @desc    Regenerate a single AI reply type (short/detailed/sales)
// @route   POST /api/inbox/:id/ai-assist/regenerate
// @access  Private
exports.aiAssistRegenerate = async (req, res, next) => {
  try {
    const { type } = req.body;
    const { data, credits } = await inboxAiAssistService.regenerateAssistOne({
      interactionId: req.params.id,
      user: req.user,
      type
    });
    return res.status(200).json({
      success: true,
      data,
      credits,
      message: `${type} reply regenerated successfully`
    });
  } catch (err) {
    if (err instanceof InboxAiError) return respondInboxAiError(res, err);
    logger.error('[inboxController] aiAssistRegenerate error', { error: err.message });
    next(err);
  }
};

// @desc    Generate auto-replies for pending interactions
// @route   POST /api/inbox/auto-reply/generate
// @access  Private (Admin/Manager)
exports.generateAutoReplies = async (req, res, next) => {
  try {
    const { interactionIds, autoSend = false } = req.body || {};
    const results = await inboxAiAssistService.processAutoReplyBatch({
      user: req.user,
      interactionIds,
      autoSend,
      mode: 'full'
    });
    return res.status(200).json({
      success: true,
      data: results,
      message: `Generated ${results.generated} replies, sent ${results.sent}, skipped ${results.skipped}, failed ${results.failed}`
    });
  } catch (err) {
    if (err instanceof InboxAiError) return respondInboxAiError(res, err);
    logger.error('[inboxController] generateAutoReplies error', { error: err.message });
    next(err);
  }
};

// @desc    Test/trigger auto-reply manually (for debugging)
// @route   POST /api/inbox/auto-reply/test-trigger
// @access  Private (Admin/Manager)
exports.testAutoReplyTrigger = async (req, res, next) => {
  try {
    const results = await inboxAiAssistService.processAutoReplyBatch({
      user: req.user,
      interactionIds: [],
      autoSend: false,
      mode: 'test'
    });
    if (results.found === 0) {
      return res.status(200).json({
        success: true,
        message: 'No eligible interactions found',
        data: { found: 0 }
      });
    }
    return res.status(200).json({
      success: true,
      message: 'Auto-reply test completed',
      data: results
    });
  } catch (err) {
    if (err instanceof InboxAiError) return respondInboxAiError(res, err);
    logger.error('[inboxController] testAutoReplyTrigger error', { error: err.message });
    next(err);
  }
};

// @desc    Get escalated interactions requiring human response
// @route   GET /api/inbox/escalated
// @access  Private
exports.getEscalatedInteractions = async (req, res, next) => {
  try {
    const { page = 1, limit = 20, assignedToMe, unassigned } = req.query;
    const skip = (page - 1) * limit;

    const query = {
      organization: req.user.organization._id,
      requiresHumanResponse: true,
      status: { $ne: 'resolved' }
    };

    // Filter by assignment
    if (assignedToMe === 'true') {
      query.assignedTo = req.user._id;
    } else if (unassigned === 'true') {
      query.assignedTo = { $exists: false };
    }

    const [interactions, total] = await Promise.all([
      Interaction.find(query)
        .populate('assignedTo', 'firstName lastName email')
        .populate('assignedBy', 'firstName lastName email')
        .populate('platformConnection', 'platform')
        .sort({ escalatedAt: -1, createdAt: -1 })
        .skip(skip)
        .limit(parseInt(limit)),
      Interaction.countDocuments(query)
    ]);

    res.status(200).json({
      success: true,
      data: interactions,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    logger.error('[inboxController] getEscalatedInteractions error', { error: error.message });
    next(error);
  }
};

// @desc    Get available agents for assignment
// @route   GET /api/inbox/agents
// @access  Private (Manager/Admin)
exports.getAvailableAgents = async (req, res, next) => {
  try {
    // Always return ALL assignable users (admins, managers, agents) for manual assignment dropdown
    const agents = await User.find({
      organization: req.user.organization._id,
      role: { $in: ['admin', 'manager', 'agent'] },
      isActive: true
    }).select('firstName lastName email role').sort({ role: 1, firstName: 1 });

    // Get workload for each agent (count all assigned conversations not yet resolved/archived)
    const agentsWithWorkload = await Promise.all(
      agents.map(async (agent) => {
        const assignedCount = await Interaction.countDocuments({
          assignedTo: agent._id,
          status: { $nin: ['resolved', 'archived', 'closed'] }
        });

        return {
          _id: agent._id,
          firstName: agent.firstName,
          lastName: agent.lastName,
          email: agent.email,
          role: agent.role,
          currentWorkload: assignedCount
        };
      })
    );

    res.status(200).json({
      success: true,
      data: agentsWithWorkload
    });
  } catch (error) {
    logger.error('[inboxController] getAvailableAgents error', { error: error.message });
    next(error);
  }
};

// @desc    Bulk assign interactions to agent
// @route   POST /api/inbox/assign-bulk
// @access  Private (Manager/Admin)
exports.bulkAssignInteractions = async (req, res, next) => {
  try {
    const { interactionIds, userId } = req.body;
    if (!Array.isArray(interactionIds) || interactionIds.length === 0) {
      return res.status(400).json({ success: false, error: 'interactionIds array is required' });
    }
    if (!userId) {
      return res.status(400).json({ success: false, error: 'userId is required' });
    }

    const { updated, agentName } = await inboxBulkService.bulkAssign({
      interactionIds,
      userId,
      assignedBy: req.user._id,
      organizationId: req.user.organization._id
    });

    res.status(200).json({
      success: true,
      data: { updated },
      message: `Successfully assigned ${updated} interaction(s) to ${agentName}`
    });
  } catch (error) {
    if (error.statusCode) return res.status(error.statusCode).json({ success: false, error: error.message });
    next(error);
  }
};

// @desc    Bulk update interaction status
// @route   POST /api/inbox/status-bulk
// @access  Private
exports.bulkUpdateStatus = async (req, res, next) => {
  try {
    const { interactionIds, status } = req.body;
    if (!Array.isArray(interactionIds) || interactionIds.length === 0) {
      return res.status(400).json({ success: false, error: 'interactionIds array is required' });
    }
    if (!status) {
      return res.status(400).json({ success: false, error: 'status is required' });
    }

    const { updated } = await inboxBulkService.bulkUpdateStatus({
      interactionIds,
      status,
      organizationId: req.user.organization._id
    });

    res.status(200).json({
      success: true,
      data: { updated },
      message: `Successfully updated ${updated} interaction(s) to ${status}`
    });
  } catch (error) {
    if (error.statusCode) return res.status(error.statusCode).json({ success: false, error: error.message });
    next(error);
  }
};

// @desc    Bulk add label to interactions
// @route   POST /api/inbox/labels-bulk
// @access  Private
exports.bulkAddLabel = async (req, res, next) => {
  try {
    const { interactionIds, labelId } = req.body;
    if (!Array.isArray(interactionIds) || interactionIds.length === 0) {
      return res.status(400).json({ success: false, error: 'interactionIds array is required' });
    }
    if (!labelId) {
      return res.status(400).json({ success: false, error: 'labelId is required' });
    }

    const { updated } = await inboxBulkService.bulkAddLabel({
      interactionIds,
      labelId,
      organizationId: req.user.organization._id
    });

    res.status(200).json({
      success: true,
      data: { updated },
      message: `Successfully added label to ${updated} interaction(s)`
    });
  } catch (error) {
    if (error.statusCode) return res.status(error.statusCode).json({ success: false, error: error.message });
    next(error);
  }
};

// @desc    Get escalation statistics
// @route   GET /api/inbox/escalation-stats
// @access  Private (Manager/Admin)
exports.getEscalationStats = async (req, res, next) => {
  try {
    const { range = 'today' } = req.query;
    
    const stats = await escalationService.getEscalationStats(
      req.user.organization._id,
      range
    );

    res.status(200).json({
      success: true,
      data: stats
    });
  } catch (error) {
    logger.error('[inboxController] getEscalationStats error', { error: error.message });
    next(error);
  }
};

// @desc    Manually escalate interaction to human agent
// @route   POST /api/inbox/:id/escalate
// @access  Private
exports.escalateInteractionManually = async (req, res, next) => {
  try {
    const { reason } = req.body;

    const interaction = await Interaction.findById(req.params.id);

    if (!interaction) {
      return res.status(404).json({
        success: false,
        error: 'Interaction not found'
      });
    }

    if (interaction.requiresHumanResponse) {
      return res.status(400).json({
        success: false,
        error: 'Interaction is already escalated'
      });
    }

    const organization = await Organization.findById(req.user.organization._id);

    const reasons = reason ? [reason] : ['Manually escalated by user'];

    await escalationService.escalateInteraction(
      interaction,
      organization,
      reasons,
      'manual'
    );

    // Clear cache
    await cacheService.invalidateInteractionCaches(req.user.organization._id);

    res.status(200).json({
      success: true,
      data: interaction,
      message: 'Interaction escalated to human agent successfully'
    });
  } catch (error) {
    logger.error('[inboxController] manualEscalation error', { error: error.message });
    next(error);
  }
};

// @desc    Get Facebook/Instagram DM message attachment (image) - proxy so we fetch with page/IG token
// @route   GET /api/inbox/attachment?interactionId=...&mid=...
// @access  Private
exports.getAttachment = async (req, res, next) => {
  try {
    const { interactionId, mid } = req.query;
    if (!interactionId || !mid) {
      return res.status(400).json({ success: false, error: 'interactionId and mid required' });
    }
    const orgId = req.user.organization._id;
    const interaction = await Interaction.findOne({
      _id: interactionId,
      organization: orgId,
      platform: { $in: ['facebook', 'instagram'] },
      type: 'dm'
    }).lean();
    if (!interaction || !interaction.metadata?.incomingMessages) {
      return res.status(404).json({ success: false, error: 'Message not found' });
    }
    const msg = interaction.metadata.incomingMessages.find(m => m.mid === mid);
    if (!msg || !msg.attachmentUrl) {
      return res.status(404).json({ success: false, error: 'Attachment not found' });
    }
    let connection = null;
    if (interaction.platform === 'facebook') {
      const pageId = interaction.metadata.facebookPageId;
      connection = await PlatformConnection.findOne({
        organization: orgId,
        platform: 'facebook',
        platformPageId: pageId,
        status: 'connected',
        isActive: true
      }).select('accessToken').lean();
    } else if (interaction.platform === 'instagram') {
      const igAccountId = interaction.metadata.instagramAccountId;
      connection = await PlatformConnection.findOne({
        organization: orgId,
        platform: 'instagram',
        platformUserId: { $in: [igAccountId, String(igAccountId)].filter(Boolean) },
        status: 'connected',
        isActive: true
      }).select('accessToken').lean();
    }
    if (!connection || !connection.accessToken) {
      return res.status(404).json({ success: false, error: 'Connection not found' });
    }
    const url = msg.attachmentUrl.includes('?') ? `${msg.attachmentUrl}&access_token=${connection.accessToken}` : `${msg.attachmentUrl}?access_token=${connection.accessToken}`;
    const imgRes = await axios.get(url, { responseType: 'arraybuffer', maxRedirects: 5, timeout: 10000 });
    res.set('Content-Type', imgRes.headers['content-type'] || 'image/jpeg');
    res.set('Cache-Control', 'private, max-age=3600');
    res.send(Buffer.from(imgRes.data));
  } catch (error) {
    if (error.response?.status === 404 || error.response?.status === 403) {
      return res.status(404).json({ success: false, error: 'Attachment not available' });
    }
    logger.error('[inboxController] getAttachment error', { error: error.message });
    res.status(500).json({ success: false, error: 'Failed to load attachment' });
  }
};

/**
 * @desc    WhatsApp inbound media (image/audio/video/document) — proxy with Cloud API token
 * @route   GET /api/inbox/whatsapp-media?interactionId=...&mid=...
 * @access  Private
 */
exports.getWhatsAppMedia = async (req, res, next) => {
  try {
    const { interactionId, mid } = req.query;
    if (!interactionId || !mid) {
      return res.status(400).json({ success: false, error: 'interactionId and mid required' });
    }
    const orgId = req.user.organization._id;
    const whatsappService = require('../integrations/whatsapp/whatsappService');

    const interaction = await Interaction.findOne({
      _id: interactionId,
      organization: orgId,
      platform: 'whatsapp',
      type: 'dm'
    })
      .select('metadata.incomingMessages platformConnection')
      .lean();

    if (!interaction?.metadata?.incomingMessages?.length) {
      return res.status(404).json({ success: false, error: 'Message not found' });
    }
    const msg = interaction.metadata.incomingMessages.find((m) => m.mid === mid);
    if (!msg?.mediaId) {
      return res.status(404).json({ success: false, error: 'Media not found on message' });
    }

    if (!interaction.platformConnection) {
      return res.status(404).json({ success: false, error: 'Platform connection missing' });
    }

    const connection = await PlatformConnection.findOne({
      _id: interaction.platformConnection,
      organization: orgId,
      platform: 'whatsapp',
      isActive: true,
      status: 'connected'
    }).lean();

    if (!connection?.accessToken) {
      return res.status(404).json({ success: false, error: 'WhatsApp connection not found' });
    }

    const mediaInfo = await whatsappService.getMediaUrl(connection, msg.mediaId);
    if (!mediaInfo?.success || !mediaInfo.url) {
      return res.status(502).json({ success: false, error: 'Could not resolve media URL' });
    }

    const download = await whatsappService.downloadMedia(connection, mediaInfo.url);
    const contentType =
      download.contentType ||
      mediaInfo.mimeType ||
      'application/octet-stream';

    const msgFilename =
      msg.attachmentDisplayName ||
      (typeof msg.text === 'string' && /\.(pdf|doc|docx)$/i.test(msg.text.trim()) ? msg.text.trim() : null);
    if (msgFilename) {
      res.set('Content-Disposition', `inline; filename="${msgFilename.replace(/"/g, '')}"`);
    }

    res.set('Content-Type', contentType);
    res.set('Cache-Control', 'private, max-age=3600');
    res.send(Buffer.from(download.data));
  } catch (error) {
    if (error.response?.status === 404 || error.response?.status === 403) {
      return res.status(404).json({ success: false, error: 'Media not available' });
    }
    logger.error('[inboxController] getWhatsAppMedia error', { error: error.message });
    res.status(500).json({ success: false, error: 'Failed to load WhatsApp media' });
  }
};

// @desc    Get author avatar (profile picture) - proxy for Instagram/Facebook to avoid CORS
// @route   GET /api/inbox/avatar/:platform/:userId
// @access  Private
exports.getAuthorAvatar = async (req, res, next) => {
  try {
    const { platform, userId } = req.params;
    const pageId = req.query.pageId;
    if (!platform || !userId) {
      return res.status(400).json({ success: false, error: 'platform and userId required' });
    }
    const orgId = req.user.organization._id;
    const platformKey = platform.toLowerCase();
    const API_VER = 'v18.0';
    const GRAPH = `https://graph.facebook.com/${API_VER}`;

    // ── Helper: fetch image bytes from a URL and stream to client ──────────
    async function streamImage(url) {
      const r = await axios.get(url, {
        responseType: 'arraybuffer',
        maxRedirects: 5,
        timeout: 8000,
        validateStatus: s => s === 200
      });
      res.set('Content-Type', r.headers['content-type'] || 'image/jpeg');
      res.set('Cache-Control', 'private, max-age=3600');
      res.send(Buffer.from(r.data));
    }

    // ── Helper: resolve best EAA token for Instagram IGSID lookups ─────────
    // EAA = Facebook Page token (facebook_login or facebook platform connections).
    // IGAA = Instagram Login token — CANNOT look up other users' profiles.
    async function resolveEaaToken() {
      // 1. Instagram connection connected via Facebook Login (EAA token)
      const igFbConn = await PlatformConnection.findOne({
        organization: orgId,
        platform: 'instagram',
        'metadata.connectionType': 'facebook_login',
        isActive: true,
        status: 'connected'
      }).select('accessToken').lean();
      if (igFbConn?.accessToken && !igFbConn.accessToken.startsWith('IGAA')) {
        return igFbConn.accessToken;
      }
      // 2. Facebook Page connection (always EAA)
      const fbFilter = { organization: orgId, platform: 'facebook', isActive: true, status: 'connected' };
      if (pageId) fbFilter.platformPageId = { $in: [String(pageId), pageId] };
      const fbConn = await PlatformConnection.findOne(fbFilter).select('accessToken').lean();
      if (fbConn?.accessToken) return fbConn.accessToken;
      return null;
    }

    // ── Instagram ──────────────────────────────────────────────────────────
    // Instagram customer IGSIDs can only be queried with an EAA (Facebook Login) token.
    // IGAA (Direct Login) tokens block access to other users' profiles by Meta policy.
    if (platformKey === 'instagram') {
      const token = await resolveEaaToken();
      if (!token) {
        // No EAA token available — Instagram Direct Login cannot fetch customer profiles
        return res.status(404).json({ success: false, error: 'No EAA token available for Instagram', useDefault: true });
      }

      // Step 1: resolve the CDN URL via fields=profile_pic (avoids /picture silhouette redirect)
      try {
        const profileRes = await axios.get(`${GRAPH}/${userId}`, {
          params: { fields: 'profile_pic', access_token: token },
          timeout: 8000
        });
        const cdnUrl = profileRes.data?.profile_pic;
        if (cdnUrl && cdnUrl.startsWith('http')) {
          await streamImage(cdnUrl);
          return;
        }
      } catch (_) { /* fall through */ }

      // Step 2: fallback — /picture redirect endpoint
      try {
        await streamImage(`${GRAPH}/${userId}/picture?type=normal&access_token=${encodeURIComponent(token)}`);
        return;
      } catch (_) { /* fall through */ }

      return res.status(404).json({ success: false, error: 'Avatar not available', useDefault: true });
    }

    // ── Facebook ───────────────────────────────────────────────────────────
    if (platformKey === 'facebook') {
      const filter = { organization: orgId, platform: 'facebook', isActive: true, status: 'connected' };
      if (pageId) filter.platformPageId = { $in: [String(pageId), pageId] };
      const conn = await PlatformConnection.findOne(filter).select('accessToken').lean();
      if (!conn?.accessToken) {
        return res.status(404).json({ success: false, error: 'Platform connection not found' });
      }
      const token = conn.accessToken;

      // Use picture{url} to get the resolved CDN URL without following a redirect silhouette
      try {
        const profileRes = await axios.get(`${GRAPH}/${userId}`, {
          params: { fields: 'picture.type(normal){url,is_silhouette}', access_token: token },
          timeout: 8000
        });
        const pic = profileRes.data?.picture?.data;
        if (pic && !pic.is_silhouette && pic.url) {
          await streamImage(pic.url);
          return;
        }
        // Silhouette = no real profile picture → 404 so frontend shows initials
        if (pic?.is_silhouette) {
          return res.status(404).json({ success: false, error: 'No profile picture', useDefault: true });
        }
      } catch (_) { /* fall through to /picture endpoint */ }

      // Fallback: /picture redirect
      try {
        await streamImage(`${GRAPH}/${userId}/picture?type=normal&access_token=${encodeURIComponent(token)}`);
        return;
      } catch (fbErr) {
        return res.status(404).json({ success: false, error: 'Avatar not available', useDefault: true });
      }
    }

    return res.status(400).json({ success: false, error: 'Unsupported platform' });
  } catch (error) {
    const status = error.response?.status;
    if (error.code !== 'ECONNABORTED' && status !== 400 && status !== 403 && status !== 404) {
      logger.error('[inboxController] getAuthorAvatar error', { error: error.message });
    }
    res.status(404).json({ 
      success: false, 
      error: 'Avatar not available',
      useDefault: true 
    });
  }
};

/**
 * POST /api/inbox/backfill-avatars
 *
 * One-time migration: finds all Facebook interactions whose `author.avatarUrl`
 * (or `author.profilePicture`) is still a `graph.facebook.com/{id}/picture` redirect URL
 * and replaces it with the actual CDN URL by calling the Graph API.
 *
 * Safe to run multiple times — already-resolved CDN URLs are skipped.
 * Should be called once after deploying the ingest-time CDN URL fix.
 */
exports.backfillFacebookAvatars = async (req, res) => {
  try {
    const orgId = req.user.organization._id;

    // Find interactions that still have the old Graph redirect URL pattern.
    const staleRecords = await Interaction.find({
      organization: orgId,
      platform: 'facebook',
      $or: [
        { 'author.avatarUrl': /^https:\/\/graph\.facebook\.com\// },
        { 'author.profilePicture': /^https:\/\/graph\.facebook\.com\// }
      ]
    })
      .select('_id author platformConnection')
      .lean()
      .limit(500); // safety cap per run

    if (staleRecords.length === 0) {
      return res.json({ success: true, updated: 0, message: 'Nothing to backfill.' });
    }

    // Load connections keyed by _id so we can find the right page token.
    const connIds = [...new Set(staleRecords.map(r => String(r.platformConnection)).filter(Boolean))];
    const connections = await PlatformConnection.find({
      _id: { $in: connIds },
      platform: 'facebook',
      status: 'connected',
      isActive: true
    })
      .select('_id accessToken')
      .lean();
    const connMap = Object.fromEntries(connections.map(c => [String(c._id), c.accessToken]));

    const FB_API = 'https://graph.facebook.com/v18.0';
    let updated = 0;
    let skipped = 0;

    for (const record of staleRecords) {
      const platformId = record.author?.platformId;
      const token = connMap[String(record.platformConnection)];
      if (!platformId || !token) { skipped++; continue; }

      try {
        const { data } = await axios.get(`${FB_API}/${platformId}`, {
          params: { fields: 'picture{url}', access_token: token },
          timeout: 8000
        });
        const picData = Array.isArray(data.picture?.data) ? data.picture.data[0] : data.picture?.data;
        const cdnUrl = picData?.url || data.picture?.url;
        if (!cdnUrl) { skipped++; continue; }

        await Interaction.updateOne(
          { _id: record._id },
          {
            $set: {
              'author.avatarUrl': cdnUrl,
              'author.profilePicture': cdnUrl
            }
          }
        );
        updated++;
      } catch {
        skipped++;
      }
    }

    return res.json({
      success: true,
      total: staleRecords.length,
      updated,
      skipped,
      message: staleRecords.length === 500
        ? 'Hit 500-record cap — run again to continue backfilling.'
        : 'Backfill complete.'
    });
  } catch (error) {
    logger.error('[inboxController] backfillFacebookAvatars error', { error: error.message });
    res.status(500).json({ success: false, error: error.message });
  }
};

/**
 * Update interaction's intent bucket (drag-and-drop reclassification)
 * PUT /inbox/:id/bucket
 */
exports.updateBucket = async (req, res) => {
  try {
    const { intentBucket } = req.body;
    const interaction = await Interaction.findOne({
      _id: req.params.id,
      organization: req.user.organization._id
    });

    if (!interaction) {
      return res.status(404).json({ success: false, error: 'Interaction not found' });
    }

    interaction.intentBucket = intentBucket || null;
    interaction.bucketAssignedBy = 'manual';
    await interaction.save();

    const socketService = req.app.get('socketService');
    if (socketService) {
      socketService.emitToOrganization(req.user.organization._id.toString(), 'bucket_update', {
        interactionId: interaction._id,
        intentBucket: interaction.intentBucket,
        bucketAssignedBy: 'manual'
      });
    }

    res.json({ success: true, data: interaction });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

/**
 * Get interactions grouped by intent bucket (for kanban board view)
 * GET /inbox/bucket-view
 */
exports.getBucketView = async (req, res) => {
  try {
    const IntentBucket = require('../models/IntentBucket');
    const orgId = req.user.organization._id;
    const { limit = 20, platform, type, sentiment, status, search, dateFrom, dateTo, chatOpen } = req.query;
    const safeLimit = Math.min(Math.max(parseInt(limit) || 20, 1), 50);

    const activeConnections = await PlatformConnection.find({
      organization: orgId,
      status: 'connected'
    }).select('_id platform').lean();

    const visibilityFilter = buildPlatformConnectionVisibilityFilter(activeConnections);

    const baseMatch = {
      organization: orgId,
      $or: [
        { parentId: { $exists: false } },
        { parentId: null },
        { parentId: '' }
      ],
      ...visibilityFilter
    };

    setQueryFieldInOrEquals(baseMatch, 'platform', platform);
    setQueryFieldInOrEquals(baseMatch, 'type', type);
    setQueryFieldInOrEquals(baseMatch, 'sentiment', sentiment);
    const bucketViewStatusParts = parseQueryCsv(status);
    if (bucketViewStatusParts.length === 1) baseMatch.status = bucketViewStatusParts[0];
    else if (bucketViewStatusParts.length > 1) baseMatch.status = { $in: bucketViewStatusParts };
    if (dateFrom || dateTo) {
      baseMatch.platformCreatedAt = {};
      if (dateFrom) baseMatch.platformCreatedAt.$gte = new Date(dateFrom);
      if (dateTo) {
        const end = new Date(dateTo);
        end.setHours(23, 59, 59, 999);
        baseMatch.platformCreatedAt.$lte = end;
      }
    }
    if (search) {
      const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      baseMatch.$and = baseMatch.$and || [];
      baseMatch.$and.push({
        $or: [
          { content: { $regex: escaped, $options: 'i' } },
          { 'author.name': { $regex: escaped, $options: 'i' } },
          { 'author.username': { $regex: escaped, $options: 'i' } }
        ]
      });
    }

    if (bucketViewStatusParts.length === 0) {
      baseMatch.status = { $ne: 'archived' };
    }

    const bucketChatOpenStr = chatOpen != null ? String(chatOpen).toLowerCase() : '';
    if (bucketChatOpenStr === 'true' || bucketChatOpenStr === '1') {
      baseMatch.$and = baseMatch.$and || [];
      baseMatch.$and.push({
        $or: [{ chatOpen: true }, { chatOpen: { $exists: false } }]
      });
    } else if (bucketChatOpenStr === 'false' || bucketChatOpenStr === '0') {
      baseMatch.chatOpen = false;
    }

    let buckets = await IntentBucket.find({ organization: orgId, isActive: true }).sort({ order: 1 }).lean();

    if (buckets.length === 0) {
      const { ensureDefaultBuckets } = require('../controllers/intentBucketController');
      await ensureDefaultBuckets(orgId, req.user._id);
      buckets = await IntentBucket.find({ organization: orgId, isActive: true }).sort({ order: 1 }).lean();
    }

    const bucketResults = await Promise.all(
      buckets.map(async (bucket) => {
        const matchQuery = { ...baseMatch, intentBucket: bucket._id };
        const [interactions, total] = await Promise.all([
          Interaction.find(matchQuery)
            .sort({ platformCreatedAt: -1 })
            .limit(safeLimit)
            .populate('assignedTo', 'firstName lastName email')
            .populate('labels', 'name color icon')
            .populate('intentBucket', 'name color icon')
            .populate('platformConnection', 'platform displayName')
            .lean(),
          Interaction.countDocuments(matchQuery)
        ]);
        return { bucket, interactions, total };
      })
    );

    const unassignedMatch = { ...baseMatch };
    unassignedMatch.$and = [...(unassignedMatch.$and || []), { $or: [{ intentBucket: { $exists: false } }, { intentBucket: null }] }];
    const [unassignedInteractions, unassignedTotal] = await Promise.all([
      Interaction.find(unassignedMatch)
        .sort({ platformCreatedAt: -1 })
        .limit(safeLimit)
        .populate('assignedTo', 'firstName lastName email')
        .populate('labels', 'name color icon')
        .populate('platformConnection', 'platform displayName')
        .lean(),
      Interaction.countDocuments(unassignedMatch)
    ]);

    res.json({
      success: true,
      data: {
        buckets: bucketResults,
        unassigned: { interactions: unassignedInteractions, total: unassignedTotal }
      }
    });
  } catch (error) {
    logger.error('[inboxController] getBucketView error', { error: error.message });
    res.status(500).json({ success: false, error: error.message });
  }
};

// @desc    Get topic insights (keyword frequency + AI recommendation) across ALL org interactions with filters
// @route   GET /api/inbox/topic-insights
exports.getTopicInsights = async (req, res) => {
  try {
    const orgId = req.user.organization._id;
    const { platform, type, sentiment, status, search, dateFrom, dateTo } = req.query;

    const activeConnections = await PlatformConnection.find({
      organization: orgId,
      status: 'connected'
    }).select('_id platform').lean();

    const visibilityFilter = buildPlatformConnectionVisibilityFilter(activeConnections);

    const baseMatch = {
      organization: orgId,
      $or: [
        { parentId: { $exists: false } },
        { parentId: null },
        { parentId: '' }
      ],
      ...visibilityFilter
    };

    setQueryFieldInOrEquals(baseMatch, 'platform', platform);
    setQueryFieldInOrEquals(baseMatch, 'type', type);
    setQueryFieldInOrEquals(baseMatch, 'sentiment', sentiment);
    const topicStatusParts = parseQueryCsv(status);
    if (topicStatusParts.length === 1) baseMatch.status = topicStatusParts[0];
    else if (topicStatusParts.length > 1) baseMatch.status = { $in: topicStatusParts };
    if (dateFrom || dateTo) {
      baseMatch.platformCreatedAt = {};
      if (dateFrom) baseMatch.platformCreatedAt.$gte = new Date(dateFrom);
      if (dateTo) {
        const end = new Date(dateTo);
        end.setHours(23, 59, 59, 999);
        baseMatch.platformCreatedAt.$lte = end;
      }
    }
    if (search) {
      const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      baseMatch.$and = baseMatch.$and || [];
      baseMatch.$and.push({
        $or: [
          { content: { $regex: escaped, $options: 'i' } },
          { 'author.name': { $regex: escaped, $options: 'i' } },
          { 'author.username': { $regex: escaped, $options: 'i' } }
        ]
      });
    }
    if (topicStatusParts.length === 0) {
      baseMatch.status = { $ne: 'archived' };
    }

    // Use aggregation with $project + server-side JS to compute keyword frequency
    // For performance, stream only `content`, `sentiment`, `status`, `platform` fields
    const interactions = await Interaction.find(baseMatch)
      .select('content sentiment status platform author platformCreatedAt')
      .lean();

    const totalMessages = interactions.length;

    // --- Keyword frequency ---
    const STOP = new Set([
      'i','me','my','we','our','you','your','he','she','it','they','them',
      'is','am','are','was','were','be','been','being','have','has','had',
      'do','does','did','will','would','could','should','may','might','shall',
      'a','an','the','and','but','or','so','if','in','on','at','to','for',
      'of','with','by','from','up','about','into','than','then','that','this',
      'what','which','who','how','when','where','why','not','no','yes','can',
      'just','get','got','also','very','more','some','any','all','there','here',
      'really','still','even','much','only','like','know','make','come','think',
      'good','great','well','back','over','after','want','give','most','them',
      'been','going','said','each','tell','made','find','work','because','long',
      'look','thing','many','before','need','call','first','people','down','side'
    ]);

    const kmap = new Map();
    interactions.forEach(interaction => {
      const seen = new Set();
      (interaction.content || '')
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter(w => w.length > 3 && !STOP.has(w))
        .forEach(word => {
          if (seen.has(word)) return;
          seen.add(word);
          const entry = kmap.get(word);
          if (entry) {
            entry.count++;
          } else {
            kmap.set(word, {
              count: 1,
              sample: {
                content: interaction.content?.substring(0, 200),
                platform: interaction.platform,
                sentiment: interaction.sentiment,
                author: interaction.author
              }
            });
          }
        });
    });

    const commonTopics = Array.from(kmap.entries())
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, 8)
      .map(([keyword, { count, sample }]) => ({ keyword, count, sample }));

    // --- Sentiment stats ---
    let positive = 0, neutral = 0, negative = 0, unreadCount = 0;
    interactions.forEach(i => {
      if (i.sentiment === 'positive') positive++;
      else if (i.sentiment === 'negative') negative++;
      else if (i.sentiment === 'neutral') neutral++;
      if (i.status === 'unread') unreadCount++;
    });
    const sentTotal = positive + neutral + negative || 1;
    const positivePercent = Math.round((positive / sentTotal) * 100);
    const negativePercent = Math.round((negative / sentTotal) * 100);

    // --- AI Recommendation ---
    let recommendation = '';
    if (totalMessages === 0) {
      recommendation = 'No conversations match the current filters. Try adjusting your filters to see insights.';
    } else if (negativePercent >= 30) {
      recommendation = `${negative} negative conversation${negative > 1 ? 's' : ''} out of ${totalMessages} total (${negativePercent}%). Focus on addressing customer complaints to improve satisfaction.`;
    } else if (negativePercent >= 15) {
      recommendation = `${negativePercent}% of conversations have negative sentiment. Monitor and respond promptly to prevent escalation.`;
    } else if (unreadCount > 20) {
      recommendation = `You have ${unreadCount} unread conversations out of ${totalMessages}. Consider assigning them to team members to reduce response times.`;
    } else if (positivePercent >= 60) {
      recommendation = `Great sentiment! ${positivePercent}% positive across ${totalMessages} conversations. Consider sharing positive testimonials to boost brand trust.`;
    } else {
      recommendation = `Engage consistently with your audience across ${totalMessages} conversations to maintain healthy sentiment scores.`;
    }

    res.json({
      success: true,
      data: {
        commonTopics,
        recommendation,
        totalMessages,
        sentiment: { positive, neutral, negative, total: sentTotal }
      }
    });
  } catch (error) {
    logger.error('[inboxController] getTopicInsights error', { error: error.message });
    res.status(500).json({ success: false, error: error.message });
  }
};

// @desc    Generate AI chat summary (deducts 1 credit)
// @route   POST /api/inbox/:id/summary/generate
// @access  Private
exports.generateSummary = async (req, res, next) => {
  const aiCreditService = require('../services/aiCreditService');
  let creditsDeducted = 0;
  try {
    const interaction = await Interaction.findById(req.params.id)
      .populate({ path: 'replies.sentBy', select: 'firstName lastName' })
      .lean();

    if (!interaction) {
      return res.status(404).json({ success: false, error: 'Interaction not found' });
    }
    if (interaction.organization.toString() !== req.user.organization._id.toString()) {
      return res.status(403).json({ success: false, error: 'Access denied' });
    }

    const organizationId = req.user.organization._id.toString();

    // Credit check
    const creditCheck = await aiCreditService.checkCredits(organizationId, 1);
    if (!creditCheck.allowed) {
      return res.status(403).json({
        success: false,
        error: creditCheck.error || 'Insufficient AI credits',
        code: creditCheck.code || 'INSUFFICIENT_CREDITS',
        credits: { current: creditCheck.current, limit: creditCheck.limit, remaining: creditCheck.remaining }
      });
    }

    // Build conversation transcript
    const lines = [];
    const customerName = interaction.author?.name || 'Customer';
    lines.push(`${customerName}: "${interaction.content}"`);

    // Child thread messages (other platform replies threaded from this one)
    const childInteractions = await Interaction.find({
      $or: [
        { parentId: interaction._id.toString() },
        { parentId: interaction.platformId }
      ],
      organization: req.user.organization._id
    }).sort({ platformCreatedAt: 1 }).limit(20).lean();

    for (const child of childInteractions) {
      lines.push(`${child.author?.name || 'Customer'}: "${child.content}"`);
    }

    // Replies (agent / AI)
    const validReplies = (interaction.replies || [])
      .filter(r => r.status !== 'deleted' && r.content)
      .sort((a, b) => new Date(a.sentAt) - new Date(b.sentAt));

    for (const reply of validReplies) {
      if (reply.isPlatformReply) {
        const name = reply.author?.name || 'Customer';
        lines.push(`${name}: "${reply.content}"`);
      } else {
        const agent = reply.sentBy;
        const agentName = agent?.firstName
          ? `${agent.firstName} ${agent.lastName || ''}`.trim()
          : 'Agent';
        const tag = reply.wasAutoGenerated ? `${agentName} (AI)` : agentName;
        lines.push(`${tag}: "${reply.content}"`);
      }
    }

    const transcript = lines.join('\n');

    const systemPrompt = `You are a support team member writing a quick internal note about a customer conversation.

Respond ONLY with this exact JSON (no markdown, no extra text):
{
  "summary": "2-4 plain sentences covering: what the customer wanted, how the team responded, whether it's resolved or still open, any key detail (frustrated tone, specific issue, promised callback). Keep under 80 words. No headers, no bullets, no bold.",
  "suggestedAction": "One short sentence: the single most useful next action for the agent, e.g. 'Follow up if customer does not respond within 24 hours.' or 'No action needed — conversation resolved.' or 'Escalate to billing team — payment issue unresolved.'"
}

If the conversation was unclear or test messages, say so honestly in the summary. Keep both fields concise and human.`;

    const userPrompt = `Platform: ${interaction.platform} | Status: ${interaction.status}\n\nTranscript:\n${transcript}`;

    const { result: rawResult, aiApiUsageId } = await runWithAiContextAndUsageId(
      {
        organizationId: req.user.organization._id,
        userId: req.user._id,
        feature: 'inbox.chat_summary'
      },
      () => aiService.generateText(systemPrompt, userPrompt, { temperature: 0.65, maxTokens: 220 })
    );

    if (!rawResult) {
      return res.status(500).json({ success: false, error: 'AI returned an empty summary. Please try again.' });
    }

    // Parse JSON response — fall back to treating the entire result as summary if parse fails
    let summaryText = rawResult.trim();
    let suggestedAction = null;
    try {
      const jsonMatch = rawResult.match(/\{[\s\S]*\}/);
      const parsed = JSON.parse(jsonMatch ? jsonMatch[0] : rawResult);
      if (parsed?.summary) {
        summaryText = parsed.summary.trim();
        suggestedAction = parsed.suggestedAction?.trim() || null;
      }
    } catch (_) {
      // JSON parse failed — use raw text as summary, no suggested action
    }

    // Deduct credit
    await aiCreditService.deductCredits(
      organizationId,
      1,
      {
        operation: 'chat_summary',
        userId: req.user._id,
        interactionId: interaction._id.toString(),
        platform: interaction.platform
      },
      { aiApiUsageId }
    );
    creditsDeducted = 1;

    // Persist summary + suggested action
    await Interaction.findByIdAndUpdate(req.params.id, {
      summary: summaryText,
      summarySuggestedAction: suggestedAction,
      summaryGeneratedAt: new Date(),
      summaryGeneratedBy: 'ai'
    });

    const updatedCredits = await aiCreditService.getUsage(organizationId);

    return res.status(200).json({
      success: true,
      data: {
        summary: summaryText,
        suggestedAction,
        generatedBy: 'ai',
        generatedAt: new Date()
      },
      credits: updatedCredits
    });
  } catch (error) {
    if (creditsDeducted > 0) {
      try {
        const aiCreditService = require('../services/aiCreditService');
        await aiCreditService.rollbackCredits(
          req.user.organization._id.toString(),
          creditsDeducted,
          { operation: 'chat_summary', userId: req.user._id, reason: error.message }
        );
      } catch (_) { /* ignore rollback error */ }
    }
    logger.error('[inboxController] generateSummary error', { error: error.message });
    next(error);
  }
};

// @desc    Save (create/update) a manual chat summary
// @route   PUT /api/inbox/:id/summary
// @access  Private
exports.saveSummary = async (req, res, next) => {
  try {
    const { summary } = req.body;
    if (typeof summary !== 'string') {
      return res.status(400).json({ success: false, error: 'summary must be a string' });
    }

    const interaction = await Interaction.findById(req.params.id).select('organization');
    if (!interaction) {
      return res.status(404).json({ success: false, error: 'Interaction not found' });
    }
    if (interaction.organization.toString() !== req.user.organization._id.toString()) {
      return res.status(403).json({ success: false, error: 'Access denied' });
    }

    await Interaction.findByIdAndUpdate(req.params.id, {
      summary: summary.trim(),
      summaryGeneratedAt: new Date(),
      summaryGeneratedBy: 'manual'
    });

    return res.status(200).json({
      success: true,
      data: { summary: summary.trim(), generatedBy: 'manual', generatedAt: new Date() }
    });
  } catch (error) {
    logger.error('[inboxController] saveSummary error', { error: error.message });
    next(error);
  }
};
