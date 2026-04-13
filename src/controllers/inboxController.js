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

/**
 * Inbox visibility: same org + platform still has a connected account, and either
 * platformConnection matches an active row, is missing/null (legacy), or is stale (reconnect).
 */
function buildPlatformConnectionVisibilityFilter(activeConnections) {
  const activeConnectionIds = activeConnections.map((c) => c._id);
  const activePlatforms = [...new Set(activeConnections.map((c) => c.platform))];
  if (!activeConnectionIds.length || !activePlatforms.length) {
    return { _id: { $in: [] } };
  }
  return {
    $and: [
      { platform: { $in: activePlatforms } },
      {
        $or: [
          { platformConnection: { $in: activeConnectionIds } },
          { platformConnection: { $exists: false } },
          { platformConnection: null },
          {
            platformConnection: {
              $exists: true,
              $ne: null,
              $nin: activeConnectionIds
            }
          }
        ]
      }
    ]
  };
}

/** Comma-separated or repeated query values → trimmed non-empty strings */
function parseQueryCsv(val) {
  if (val == null || val === '') return [];
  if (Array.isArray(val)) {
    return val.flatMap((s) => String(s).split(',')).map((x) => x.trim()).filter(Boolean);
  }
  return String(val).split(',').map((s) => s.trim()).filter(Boolean);
}

function setQueryFieldInOrEquals(queryObj, field, rawVal) {
  const parts = parseQueryCsv(rawVal);
  if (parts.length === 0) return;
  if (parts.length === 1) queryObj[field] = parts[0];
  else queryObj[field] = { $in: parts };
}

// @desc    Get all interactions (inbox)
// @route   GET /api/inbox
exports.getInteractions = async (req, res, next) => {
  try {
    const {
      platform,
      type,
      sentiment,
      status,
      search,
      assignedTo,
      label,
      intentBucket,
      viewMode,
      postId,
      dateFrom,
      dateTo,
      chatOpen,
      page = 1,
      limit = 20,
      // Keep inbox ordered by newest platform comment/message first.
      sortBy = 'platformCreatedAt',
      sortOrder = 'desc'
    } = req.query;

    // Enforce max page size: clients cannot request more than 100 at once
    const safeLimit = Math.min(Math.max(parseInt(limit) || 20, 1), 100);
    const safePage  = Math.max(parseInt(page) || 1, 1);

    // Build query
    const query = { organization: req.user.organization._id };

    // Only show parent interactions (top-level comments/reviews), not replies
    // Replies are shown in the detail view when clicking on a parent
    // This filter will be added to $and array below

    // Multiselect sends CSV or repeated params → OR via $in (single value stays equality)
    setQueryFieldInOrEquals(query, 'platform', platform);
    setQueryFieldInOrEquals(query, 'type', type);
    if (postId) query['metadata.postId'] = postId;
    setQueryFieldInOrEquals(query, 'sentiment', sentiment);
    setQueryFieldInOrEquals(query, 'status', status);
    if (assignedTo) query.assignedTo = assignedTo;

    // Date range filter on platformCreatedAt
    if (dateFrom || dateTo) {
      query.platformCreatedAt = {};
      if (dateFrom) query.platformCreatedAt.$gte = new Date(dateFrom);
      if (dateTo) {
        // Include the full end day (23:59:59.999)
        const end = new Date(dateTo);
        end.setHours(23, 59, 59, 999);
        query.platformCreatedAt.$lte = end;
      }
    }

    // Label filter — one id or $in (OR) on labels array
    setQueryFieldInOrEquals(query, 'labels', label);

    // Intent bucket filter
    if (intentBucket) {
      if (intentBucket === 'none') {
        query.$and = [...(query.$and || []), { $or: [{ intentBucket: { $exists: false } }, { intentBucket: null }] }];
      } else {
        query.intentBucket = intentBucket;
      }
    }

    // View mode overrides: assigned (to me), needs_response (unread, oldest first), overdue (past SLA), archived
    const SLA_HOURS = 24;
    const slaCutoff = new Date(Date.now() - SLA_HOURS * 60 * 60 * 1000);
    let effectiveSortBy = sortBy;
    let effectiveSortOrder = sortOrder;
    if (viewMode === 'assigned') {
      query.assignedTo = req.user._id;
    } else if (viewMode === 'needs_response') {
      query.status = 'unread';
      effectiveSortBy = 'platformCreatedAt';
      effectiveSortOrder = 'asc';
    } else if (viewMode === 'overdue') {
      query.status = { $nin: ['replied', 'resolved'] };
      query.platformCreatedAt = { $lt: slaCutoff };
      effectiveSortBy = 'platformCreatedAt';
      effectiveSortOrder = 'asc';
    } else if (viewMode === 'archived') {
      // Show only archived conversations
      query.status = 'archived';
    }
    
    // For non-archived views, explicitly exclude archived conversations
    // unless the user has specifically filtered by archived status
    if (viewMode !== 'archived' && !status) {
      if (query.status && typeof query.status === 'object' && query.status.$nin) {
        // If status is already an object with $nin, add 'archived' to it
        query.status.$nin.push('archived');
      } else if (!query.status) {
        // If no status filter exists, exclude archived
        query.status = { $ne: 'archived' };
      }
    }
    
    // Build search condition - escape special regex characters
    // Trim and validate search term
    const searchTerm = search ? search.trim() : null;
    const searchCondition = searchTerm && searchTerm.length > 0 ? (() => {
      // Escape special regex characters but allow emojis and unicode
      // Replace special regex characters with escaped versions: . * + ? ^ $ { } ( ) | [ ] \
      // Note: We don't escape emojis or unicode characters - MongoDB handles them fine with UTF-8
      const escapedSearch = searchTerm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      
      return {
        $or: [
          { content: { $regex: escapedSearch, $options: 'i' } },
          { 'author.name': { $regex: escapedSearch, $options: 'i' } },
          { 'author.username': { $regex: escapedSearch, $options: 'i' } }
        ]
      };
    })() : null;

    // Get active platform connections to filter interactions
    const PlatformConnection = require('../models/PlatformConnection');
    const activeConnections = await PlatformConnection.find({
      organization: req.user.organization._id,
      isActive: true,
      status: 'connected'
    }).select('_id platform');

    const activeConnectionIds = activeConnections.map((conn) => conn._id);
    const platformConnectionFilter = buildPlatformConnectionVisibilityFilter(activeConnections);

    // Build agent condition: agents see only chats assigned to them OR previously assigned to them
    const agentCondition = req.user.role === 'agent' ? {
      $or: [
        { assignedTo: req.user._id },
        { 'assignmentHistory.assignedTo': req.user._id }
      ]
    } : null;

    // Combine all conditions using $and
    // Note: We need to combine the parentId filter with other conditions
    const conditionsToAnd = [
      // Parent ID filter (only top-level interactions - no replies)
      // Exclude any interaction that has a parentId set (replies have parentId)
      {
        $or: [
          { parentId: { $exists: false } },
          { parentId: null },
          { parentId: '' }
        ]
      },
      platformConnectionFilter
    ];
    
    if (searchCondition) {
      conditionsToAnd.push(searchCondition);
    }
    
    if (agentCondition) {
      conditionsToAnd.push(agentCondition);
    }

    // Chat session filter: open = true or legacy missing field; closed = explicit false
    const chatOpenStr = chatOpen != null ? String(chatOpen).toLowerCase() : '';
    if (chatOpenStr === 'true' || chatOpenStr === '1') {
      conditionsToAnd.push({
        $or: [{ chatOpen: true }, { chatOpen: { $exists: false } }]
      });
    } else if (chatOpenStr === 'false' || chatOpenStr === '0') {
      conditionsToAnd.push({ chatOpen: false });
    }

    // Use $and to combine all conditions
    query.$and = conditionsToAnd;

    // Calculate pagination
    const skip = (safePage - 1) * safeLimit;
    const sort = { [effectiveSortBy]: effectiveSortOrder === 'desc' ? -1 : 1 };

    // Try to get from cache (include search in cache key, normalized)
    const cacheSearchKey = searchTerm ? searchTerm.toLowerCase().trim() : '';
    const effectiveAssignedTo = viewMode === 'assigned' ? req.user._id.toString() : (assignedTo || '');
    const cacheKey = cacheService.interactionsKey(req.user.organization._id, {
      platform,
      type,
      sentiment,
      status,
      label,
      postId: postId || '',
      viewMode: viewMode || '',
      search: cacheSearchKey,
      page: safePage,
      limit: safeLimit,
      assignedTo: req.user.role === 'agent' ? req.user._id.toString() : effectiveAssignedTo,
      activeConnections: activeConnectionIds.map(id => id.toString()).sort().join(','),
      // Must be part of the key or date / bucket filters return wrong cached pages
      dateFrom: dateFrom ? String(dateFrom) : '',
      dateTo: dateTo ? String(dateTo) : '',
      intentBucket: intentBucket ? String(intentBucket) : '',
      chatOpen: chatOpen != null && chatOpen !== '' ? String(chatOpen) : ''
    });

    const cached = await cacheService.get(cacheKey);
    if (cached) {
      if (!cached.pagination) {
        cached.pagination = {
          page: safePage,
          limit: safeLimit,
          hasMore: Array.isArray(cached.interactions) ? cached.interactions.length >= safeLimit : false
        };
      }
      // Backward compatibility: older cached entries may not include pagination.total.
      if (cached?.pagination && typeof cached.pagination.total !== 'number') {
        const totalFromDb = await Interaction.countDocuments(query);
        cached.pagination.total = totalFromDb;
      }
      return res.status(200).json({
        success: true,
        data: cached,
        cached: true
      });
    }

    // Execute query — fetch one extra to know if another page exists (avoids COUNT for perf)
    const interactions = await Interaction.find(query)
      .populate('assignedTo', 'firstName lastName email avatar')
      .populate('assignedBy', 'firstName lastName email')
      .populate('assignmentHistory.assignedTo', 'firstName lastName email')
      .populate('assignmentHistory.assignedBy', 'firstName lastName email')
      .populate('labels', 'name color icon')
      .populate('replies.sentBy', 'firstName lastName')
      .populate('platformConnection', 'platform isActive status')
      .sort(sort)
      .limit(safeLimit + 1)   // +1 to detect next page
      .skip(skip)
      .lean();

    const hasMore = interactions.length > safeLimit;
    if (hasMore) interactions.pop();  // remove the extra document

    // Lazy backfill: assign chatRef to any interaction that doesn't have one yet
    const missingChatRef = interactions.filter(i => !i.chatRef && i.organization);
    if (missingChatRef.length > 0) {
      try {
        await Promise.all(
          missingChatRef.map(async (i) => {
            try {
              const refData = await generateChatRef(i.organization);
              if (refData?.chatRef) {
                await Interaction.updateOne(
                  { _id: i._id, chatRef: null },
                  { $set: { chatNumber: refData.chatNumber, chatRef: refData.chatRef } }
                );
                i.chatNumber = refData.chatNumber;
                i.chatRef = refData.chatRef;
              }
            } catch (_err) { /* skip individual failures */ }
          })
        );
      } catch (_err) { /* non-fatal */ }
    }

    const total = await Interaction.countDocuments(query);

    const result = {
      interactions,
      pagination: {
        page: safePage,
        limit: safeLimit,
        hasMore,
        total
      }
    };

    // Cache result - shorter TTL for search queries (2 minutes) vs regular queries (5 minutes)
    const cacheTTL = searchTerm ? 120 : 300; // 2 min for searches, 5 min for filters
    await cacheService.set(cacheKey, result, cacheTTL);

    res.status(200).json({
      success: true,
      data: result
    });
  } catch (error) {
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

    const interaction = await Interaction.findById(req.params.id)
      .populate('assignedTo', 'firstName lastName email avatar')
      .populate('assignedBy', 'firstName lastName email')
      .populate('assignmentHistory.assignedTo', 'firstName lastName email')
      .populate('assignmentHistory.assignedBy', 'firstName lastName email')
      .populate('labels')
      .populate('replies.sentBy', 'firstName lastName avatar')
      .populate('internalNotes.addedBy', 'firstName lastName avatar')
      .populate('platformConnection', 'platform platformUsername platformDisplayName platformProfilePicture metadata');

    if (!interaction) {
      return res.status(404).json({
        success: false,
        error: 'Interaction not found'
      });
    }

    // Check organization access
    if (interaction.organization.toString() !== req.user.organization._id.toString()) {
      return res.status(403).json({
        success: false,
        error: 'Access denied'
      });
    }

    // Agents can only view interactions assigned to them or previously assigned to them
    if (req.user.role === 'agent') {
      const isAssigned = interaction.assignedTo?.toString() === req.user._id.toString();
      const wasPreviouslyAssigned = (interaction.assignmentHistory || []).some(
        h => h.assignedTo?.toString() === req.user._id.toString()
      );
      if (!isAssigned && !wasPreviouslyAssigned) {
        return res.status(403).json({
          success: false,
          error: 'Access denied'
        });
      }
    }

    // Only mark as read when the caller explicitly requests it (e.g. user opens a conversation).
    // Background refreshes, polling, socket-triggered refetches and action-panel refreshes must
    // NOT pass markRead=true so they never override a status that was manually set to 'unread'.
    if (req.query.markRead === 'true') {
      if (!interaction.isRead || interaction.status === 'unread') {
        interaction.isRead = true;
        interaction.readAt = new Date();
        interaction.readBy = req.user._id;
        if (interaction.status === 'unread') {
          interaction.status = 'read';
        }
        await interaction.save();
        await cacheService.delPattern(`interactions:${req.user.organization._id}*`);
      }
    }

    // Fetch child interactions (replies from the platform, e.g., YouTube user replies)
    // These are separate Interaction documents with parentId pointing to this interaction
    const childInteractions = await Interaction.find({
      $or: [
        { parentId: interaction._id.toString() },
        { parentId: interaction.platformId } // Also check by platformId
      ],
      organization: req.user.organization._id
    }).sort({ platformCreatedAt: sortDir }); // Sort by requested order

    // Convert to plain object for modification
    const interactionObj = interaction.toObject();

    // Hide soft-deleted app replies from thread rendering.
    interactionObj.replies = (interactionObj.replies || []).filter(
      (reply) => reply.status !== 'deleted'
    );

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
          console.log(`⏭️  [Inbox] Filtering out duplicate reply: ${child.platformId} (already in app replies)`);
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
      data: interactionObj
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

    await cacheService.delPattern(`interactions:${req.user.organization._id}*`);

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
  try {
    const { content, useTemplate, templateId, templateVariables, attachmentUrl, attachmentType } = req.body;

    // Resolve the local file on disk so we can upload directly to Meta (avoids
    // Meta needing to download from our URL which fails behind ngrok/tunnels).
    let attachmentLocalPath = null;
    if (attachmentUrl) {
      const urlFilename = attachmentUrl.split('/').pop();
      if (urlFilename) {
        const candidate = require('path').join(__dirname, '../../uploads/posts', urlFilename);
        if (require('fs').existsSync(candidate)) attachmentLocalPath = candidate;
      }
    }

    // Convert webm audio to m4a (AAC) — webm is not accepted by Meta APIs.
    if (attachmentType === 'audio' && attachmentLocalPath && /\.webm$/i.test(attachmentLocalPath)) {
      try {
        const { convertToM4a } = require('../utils/audioConverter');
        attachmentLocalPath = await convertToM4a(attachmentLocalPath);
      } catch (convErr) {
        console.error('[Inbox Reply] Audio conversion failed, will try original file:', convErr.message);
      }
    }

    const interaction = await Interaction.findById(req.params.id)
      .populate('platformConnection');

    if (!interaction) {
      return res.status(404).json({
        success: false,
        error: 'Interaction not found'
      });
    }

    // Check organization access
    if (interaction.organization.toString() !== req.user.organization._id.toString()) {
      return res.status(403).json({
        success: false,
        error: 'Access denied'
      });
    }

    // Agents can only reply when currently assigned to this interaction
    if (req.user.role === 'agent') {
      const assignedToId = interaction.assignedTo?.toString?.() || interaction.assignedTo;
      if (assignedToId !== req.user._id.toString()) {
        return res.status(403).json({
          success: false,
          error: 'You can only reply to conversations assigned to you'
        });
      }
    }

    let replyContent = content;

    // If using template
    if (useTemplate && templateId) {
      const template = await ResponseTemplate.findById(templateId);
      if (template) {
        replyContent = template.render(templateVariables || {});
        await template.incrementUsage();
      }
    }

    // Initialize reply status
    let platformResponseId = null;
    let replyStatus = 'sent';
    let errorMessage = null;

    // Send actual reply to platform via integration service
    try {
      // Resolve platform connection (may be missing if interaction was created via webhook without it)
      let connection = null;
      const isInstagramDm = interaction.platform === 'instagram' && interaction.type === 'dm';
      let igAccountId = interaction.metadata?.instagramAccountId;
      if (isInstagramDm && !igAccountId && interaction.platformId && interaction.platformId.startsWith('dm_')) {
        const parts = interaction.platformId.split('_');
        if (parts.length >= 3) igAccountId = parts[1];
      }

      const isFacebookDm = interaction.platform === 'facebook' && interaction.type === 'dm';
      let facebookPageId = interaction.metadata?.facebookPageId;
      if (isFacebookDm && !facebookPageId && interaction.platformId && interaction.platformId.startsWith('dm_')) {
        const parts = interaction.platformId.split('_');
        if (parts.length >= 3) facebookPageId = parts[1];
      }

      if (isInstagramDm && igAccountId) {
        const threadOwnerConn = await PlatformConnection.findOne({
          organization: interaction.organization,
          platform: 'instagram',
          platformUserId: { $in: [igAccountId, String(igAccountId)].filter(Boolean) },
          status: 'connected',
          isActive: true
        }).lean();
        if (threadOwnerConn) connection = threadOwnerConn;
      }
      if (!connection) connection = interaction.platformConnection;
      if (!connection && interaction.platform && interaction.organization && !isInstagramDm) {
        const conn = await PlatformConnection.findOne({
          organization: interaction.organization,
          platform: interaction.platform,
          status: 'connected',
          isActive: true
        }).lean();
        if (conn) connection = conn;
      }
      if (isFacebookDm && facebookPageId && (!connection || String(connection.platformPageId) !== String(facebookPageId))) {
        const pageConn = await PlatformConnection.findOne({
          organization: interaction.organization,
          platform: 'facebook',
          platformPageId: { $in: [String(facebookPageId), facebookPageId] },
          status: 'connected',
          isActive: true
        }).lean();
        if (pageConn) connection = pageConn;
      }
      if (connection && isInstagramDm && igAccountId) {
        const connectionIgId = connection.platformUserId != null ? String(connection.platformUserId) : '';
        if (connectionIgId !== String(igAccountId)) {
          const threadOwnerConn = await PlatformConnection.findOne({
            organization: interaction.organization,
            platform: 'instagram',
            platformUserId: { $in: [igAccountId, String(igAccountId)] },
            status: 'connected',
            isActive: true
          }).lean();
          connection = threadOwnerConn || null;
        }
      }
      if (!connection) {
        replyStatus = 'failed';
        if (isInstagramDm) {
          errorMessage = igAccountId
            ? 'Could not find the Instagram account for this conversation. Please reconnect it in Settings.'
            : 'This conversation is not linked to an Instagram account. Sync the Instagram that receives these DMs from Settings, then try again.';
        } else if (isFacebookDm) {
          errorMessage = facebookPageId
            ? 'Could not find the Facebook Page for this conversation. Please reconnect it in Settings.'
            : 'This conversation is not linked to a Facebook Page. Reconnect the Page that receives these messages in Settings.';
        } else {
          errorMessage = 'Platform connection not found. Please reconnect this account in Settings.';
        }
      } else if (connection.status !== 'connected' || !connection.isActive) {
        replyStatus = 'failed';
        errorMessage = 'Platform connection is not active. Please reconnect this account in Settings.';
      } else if (interaction.platform === 'youtube') {
        const youtubeService = require('../integrations/google/youtubeService');
        const result = await youtubeService.replyToComment(
          connection,
          interaction.platformId,
          replyContent
        );
        
        if (result.success && result.commentId) {
          platformResponseId = result.commentId;
          replyStatus = 'sent';
        } else {
          replyStatus = 'failed';
          errorMessage = 'Failed to post reply to YouTube';
        }
      } else if (interaction.platform === 'instagram') {
        const instagramService = require('../integrations/meta/instagramService');
        let result;
        if (interaction.type === 'dm') {
          // Send API requires the Facebook Page ID that owns the Instagram thread (thread owner).
          // Resolve from token so we always use the token's Page and avoid "not the thread owner" (#100).
          let pageId = connection.platformPageId || connection.platformData?.pageId;
          const resolvedFromToken = await instagramService.getPageIdFromToken(connection.accessToken);
          if (resolvedFromToken) pageId = resolvedFromToken;
          const recipientId = interaction.author?.platformId;
          logger.info('[Inbox Reply] Instagram DM send', {
            igAccountId,
            platformUserId: connection.platformUserId,
            storedPageId: connection.platformPageId || connection.platformData?.pageId,
            resolvedFromToken: resolvedFromToken || null,
            pageId
          });
          if (!pageId || !recipientId) {
            replyStatus = 'failed';
            errorMessage = 'Missing page or recipient for Instagram DM reply. Reconnect this Instagram account in Settings (Settings → Platforms) so we have the correct Page ID.';
            console.error('[Inbox Reply] Instagram DM: missing pageId or recipientId', { hasPageId: !!pageId, hasRecipientId: !!recipientId, igAccountId });
          } else if (attachmentUrl && attachmentType) {
            result = await instagramService.sendMessageWithAttachment(
              recipientId,
              attachmentType,
              attachmentUrl,
              replyContent || undefined,
              connection.accessToken,
              pageId,
              true,
              attachmentLocalPath
            );
          } else {
            result = await instagramService.sendMessage(
              recipientId,
              replyContent,
              connection.accessToken,
              pageId,
              true
            );
          }
        } else {
          result = await instagramService.replyToComment(
            interaction.platformId,
            replyContent,
            connection.accessToken
          );
        }
        if (result && result.success && result.platformResponseId) {
          platformResponseId = result.platformResponseId;
          replyStatus = 'sent';
        } else if (replyStatus !== 'failed') {
          replyStatus = 'failed';
          errorMessage = (result && result.error) || 'Failed to post reply to Instagram';
        }
      } else if (interaction.platform === 'facebook') {
        const facebookService = require('../integrations/meta/facebookService');
        let result;
        if (interaction.type === 'dm') {
          const pageId = connection.platformPageId || connection.platformData?.pageId;
          const recipientId = interaction.author?.platformId;
          if (!pageId || !recipientId) {
            replyStatus = 'failed';
            errorMessage = 'Missing Page or recipient for Facebook Messenger reply. Reconnect the Page in Settings.';
          } else if (attachmentUrl && attachmentType) {
            result = await facebookService.sendMessageWithAttachment(
              recipientId,
              attachmentType,
              attachmentUrl,
              replyContent || undefined,
              connection.accessToken,
              pageId,
              true,
              attachmentLocalPath
            );
          } else {
            result = await facebookService.sendMessage(
              recipientId,
              replyContent,
              connection.accessToken,
              pageId,
              true
            );
          }
        } else {
          result = await facebookService.replyToComment(
            connection,
            interaction.platformId,
            replyContent
          );
        }
        if (result && result.success && (result.platformResponseId || result.commentId)) {
          platformResponseId = result.platformResponseId || result.commentId;
          replyStatus = 'sent';
        } else if (replyStatus !== 'failed') {
          replyStatus = 'failed';
          errorMessage = (result && result.error) || 'Failed to post reply to Facebook';
        }
      } else if (interaction.platform === 'linkedin') {
        const linkedinService = require('../integrations/linkedin/linkedinService');
        const result = await linkedinService.replyToComment(
          connection,
          interaction._id,
          replyContent
        );
        
        if (result.status === 'sent' && result.platformResponseId) {
          platformResponseId = result.platformResponseId;
          replyStatus = 'sent';
        } else {
          replyStatus = 'failed';
          errorMessage = result.error || 'Failed to post reply to LinkedIn';
        }
      } else if (interaction.platform === 'whatsapp') {
        const whatsappService = require('../integrations/whatsapp/whatsappService');
        const result = await whatsappService.sendTextMessage(
          interaction.author.platformId,
          replyContent
        );
        
        if (result.success && result.messageId) {
          platformResponseId = result.messageId;
          replyStatus = 'sent';
        } else {
          replyStatus = 'failed';
          errorMessage = 'Failed to send WhatsApp message';
        }
      } else if (interaction.platform === 'google' && interaction.type === 'review') {
        const locationId = interaction.metadata?.locationId;
        const reviewId = interaction.metadata?.reviewId || interaction.platformId;
        if (!locationId || !reviewId) {
          replyStatus = 'failed';
          errorMessage = 'Missing location or review ID for Google review reply.';
        } else {
          try {
            await googleService.ensureValidToken(connection);
            await googleService.replyToReview(
              connection,
              locationId,
              reviewId,
              replyContent
            );
            platformResponseId = `google-review-${reviewId}`;
            replyStatus = 'sent';
          } catch (err) {
            replyStatus = 'failed';
            errorMessage = err.message || 'Failed to post reply to Google review';
          }
        }
      } else {
        replyStatus = 'failed';
        errorMessage = `Replies for ${interaction.platform} are not yet implemented`;
      }
    } catch (platformError) {
      const metaError = platformError.response?.data?.error || platformError.platformError;
      const metaUserMsg = metaError?.error_user_msg || metaError?.message;
      console.error('Error posting reply to platform:', metaUserMsg || platformError.message);
      if (platformError.response?.data) {
        console.error('Platform API response:', JSON.stringify(platformError.response.data));
      }
      replyStatus = 'failed';
      // Friendly message for Instagram "not the thread owner" (code 100, subcode 2534037)
      if (metaError?.code === 100 && metaError?.error_subcode === 2534037) {
        errorMessage = 'This conversation belongs to a different Instagram account. Reconnect the Instagram account that receives these DMs in Settings → Platforms, then try again.';
      } else {
        errorMessage = metaUserMsg || platformError.message || 'Failed to post reply to platform';
      }
    }

    // Add reply to database with platform response ID
    // Note: addReply sets status to 'replied', so we'll update it if failed
    const previousStatus = interaction.status;
    await interaction.addReply(replyContent, req.user._id, platformResponseId, false, attachmentUrl || undefined, attachmentType || undefined);
    
    // Reload interaction to get the updated reply
    await interaction.populate('replies.sentBy', 'firstName lastName');
    
    // Update the last reply status and interaction status if it failed
    if (replyStatus === 'failed') {
      if (interaction.replies && interaction.replies.length > 0) {
        const lastReply = interaction.replies[interaction.replies.length - 1];
        lastReply.status = 'failed';
      }
      // Revert status if reply failed
      interaction.status = previousStatus;
      await interaction.save();
    } else {
      // Update respondedAt timestamp if successful
      interaction.respondedAt = new Date();
      interaction.chatOpen = true;
      await interaction.save();

      // IMPORTANT: Remove any pending AI and auto-reply jobs for this interaction
      // since it's already been replied to
      try {
        const { aiQueue, autoReplyQueue } = require('../config/queue');
        const jobs = await aiQueue.getJobs(['waiting', 'active', 'delayed']);

        for (const job of jobs) {
          if (job.data.interactionId && job.data.interactionId.toString() === interaction._id.toString()) {
            await job.remove();
            console.log(`🗑️  [Reply] Removed pending AI job ${job.id} for interaction ${interaction._id} (already replied)`);
          }
        }

        const autoReplyJobs = await autoReplyQueue.getJobs(['waiting', 'active', 'delayed']);
        for (const job of autoReplyJobs) {
          if (job.data.interactionId && job.data.interactionId.toString() === interaction._id.toString()) {
            await job.remove();
            console.log(`🗑️  [Reply] Removed pending auto-reply job ${job.id} for interaction ${interaction._id} (already replied)`);
          }
        }
      } catch (queueError) {
        console.warn('Could not remove pending AI/auto-reply jobs:', queueError.message);
        // Don't fail the reply if queue cleanup fails
      }
    }

    // Clear cache
    await cacheService.delPattern(`interactions:${req.user.organization._id}*`);

    // Return appropriate response
    if (replyStatus === 'sent') {
      res.status(200).json({
        success: true,
        data: interaction,
        message: 'Reply sent successfully to YouTube'
      });
    } else {
      console.error('[Inbox Reply] Failed to send to platform:', errorMessage || 'Unknown error');
      res.status(500).json({
        success: false,
        error: errorMessage || 'Failed to send reply to platform',
        data: interaction,
        message: 'Reply saved locally but failed to post to platform'
      });
    }
  } catch (error) {
    console.error('Error in replyToInteraction:', error);
    next(error);
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

    await cacheService.delPattern(`interactions:${req.user.organization._id}*`);

    return res.status(200).json({
      success: true,
      message: isFacebookComment
        ? 'Comment deleted from Facebook and from inbox.'
        : 'Interaction removed from inbox.'
    });
  } catch (error) {
    console.error('Error in deleteInteraction:', error);
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
      await cacheService.delPattern(`interactions:${req.user.organization._id}*`);

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
      console.log(`🔔 [Assignment] In-app notification created for ${agent.email}`);
    } catch (notifError) {
      console.error('Failed to create notification:', notifError);
    }

    // Send email notification
    const emailService = require('../services/emailService');
    try {
      await emailService.sendAssignmentNotification(agent, interaction);
      console.log(`📧 [Assignment] Email sent to ${agent.email}`);
    } catch (emailError) {
      console.error('Failed to send assignment email:', emailError);
      // Don't fail the assignment if email fails
    }

    // Clear cache
    await cacheService.delPattern(`interactions:${req.user.organization._id}*`);

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
    await cacheService.delPattern(`interactions:${req.user.organization._id}*`);

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
    await cacheService.delPattern(`interactions:${req.user.organization._id}*`);

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

    await cacheService.delPattern(`interactions:${req.user.organization._id}*`);

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

    // Only count interactions for connected accounts; when none connected, stats are zero
    const activeConnectionsForStats = await PlatformConnection.find({
      organization: orgId,
      isActive: true,
      status: 'connected'
    }).select('_id platform');
    const connectionFilter = buildPlatformConnectionVisibilityFilter(activeConnectionsForStats);

    // Match parent interactions only (exclude replies), same as inbox list
    const matchStage = {
      organization: orgId,
      $and: [
        { $or: [{ parentId: { $exists: false } }, { parentId: null }, { parentId: '' }] },
        connectionFilter
      ]
    };
    setQueryFieldInOrEquals(matchStage, 'platform', platform);

    const SLA_HOURS = 24;
    const slaThresholdMs = SLA_HOURS * 60 * 60 * 1000;
    const now = new Date();
    const slaCutoff = new Date(now.getTime() - slaThresholdMs);

    const stats = await Interaction.aggregate([
      { $match: matchStage },
      {
        $facet: {
          counts: [
            {
              $group: {
                _id: null,
                total: { $sum: 1 },
                unread: {
                  $sum: { $cond: [{ $eq: ['$status', 'unread'] }, 1, 0] }
                },
                assigned: {
                  $sum: { $cond: [{ $eq: ['$status', 'assigned'] }, 1, 0] }
                },
                replied: {
                  $sum: { $cond: [{ $eq: ['$status', 'replied'] }, 1, 0] }
                },
                resolved: {
                  $sum: { $cond: [{ $eq: ['$status', 'resolved'] }, 1, 0] }
                },
                positive: {
                  $sum: { $cond: [{ $eq: ['$sentiment', 'positive'] }, 1, 0] }
                },
                negative: {
                  $sum: { $cond: [{ $eq: ['$sentiment', 'negative'] }, 1, 0] }
                },
                neutral: {
                  $sum: { $cond: [{ $eq: ['$sentiment', 'neutral'] }, 1, 0] }
                }
              }
            },
            {
              $addFields: {
                responseRate: {
                  $cond: [
                    { $gt: ['$total', 0] },
                    { $round: [{ $multiply: [{ $divide: [{ $add: ['$replied', '$resolved'] }, '$total'] }, 100] }, 0] },
                    0
                  ]
                }
              }
            }
          ],
          avgResponse: [
            {
              $match: {
                respondedAt: { $exists: true, $ne: null },
                platformCreatedAt: { $exists: true, $ne: null }
              }
            },
            {
              $group: {
                _id: null,
                avgMs: { $avg: { $subtract: ['$respondedAt', '$platformCreatedAt'] } }
              }
            }
          ],
          overdue: [
            {
              $match: {
                status: { $nin: ['replied', 'resolved'] },
                platformCreatedAt: { $lt: slaCutoff }
              }
            },
            { $count: 'count' }
          ]
        }
      },
      {
        $addFields: {
          _counts: { $arrayElemAt: ['$counts', 0] },
          _avgResp: { $arrayElemAt: ['$avgResponse', 0] },
          _overdue: { $arrayElemAt: ['$overdue', 0] }
        }
      },
      {
        $replaceRoot: {
          newRoot: {
            $mergeObjects: [
              { $ifNull: ['$_counts', {}] },
              {
                avgResponseTimeMinutes: {
                  $cond: [
                    { $and: [{ $ne: ['$_avgResp.avgMs', null] }, { $gt: ['$_avgResp.avgMs', 0] }] },
                    { $round: [{ $divide: ['$_avgResp.avgMs', 60000] }, 0] },
                    null
                  ]
                },
                overdueCount: { $ifNull: ['$_overdue.count', 0] }
              }
            ]
          }
        }
      },
      {
        $addFields: {
          total: { $ifNull: ['$total', 0] },
          unread: { $ifNull: ['$unread', 0] },
          assigned: { $ifNull: ['$assigned', 0] },
          replied: { $ifNull: ['$replied', 0] },
          resolved: { $ifNull: ['$resolved', 0] },
          responseRate: { $ifNull: ['$responseRate', 0] },
          positive: { $ifNull: ['$positive', 0] },
          negative: { $ifNull: ['$negative', 0] },
          neutral: { $ifNull: ['$neutral', 0] },
          overdueCount: { $ifNull: ['$overdueCount', 0] }
        }
      }
    ]);

    const data = stats[0] || {};
    // Ensure responseRate is included when no stats
    if (!data.responseRate && data.total === undefined) {
      data.responseRate = 0;
    }

    res.status(200).json({
      success: true,
      data
    });
  } catch (error) {
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
    const interaction = await Interaction.findById(req.params.id);

    if (!interaction) {
      return res.status(404).json({
        success: false,
        error: 'Interaction not found'
      });
    }

    // Check organization access
    if (interaction.organization.toString() !== req.user.organization._id.toString()) {
      return res.status(403).json({
        success: false,
        error: 'Access denied'
      });
    }

    const organizationId = req.user.organization._id.toString();

    // Check AI credits before generating
    const aiCreditService = require('../services/aiCreditService');
    const creditCheck = await aiCreditService.checkCredits(organizationId, 1);

    if (!creditCheck.allowed) {
      return res.status(403).json({
        success: false,
        error: creditCheck.error || 'Insufficient AI credits',
        code: creditCheck.code || 'INSUFFICIENT_CREDITS',
        credits: {
          current: creditCheck.current,
          limit: creditCheck.limit,
          remaining: creditCheck.remaining
        }
      });
    }

    // Get organization for settings
    const organization = await Organization.findById(req.user.organization._id);

    let suggestCreditsDeducted = 0;
    try {
      const { result: aiResponse, aiApiUsageId } = await runWithAiContextAndUsageId(
        {
          organizationId: req.user.organization._id,
          userId: req.user._id,
          feature: 'inbox.suggest_reply'
        },
        () => aiService.generateResponse(interaction, req.user.organization._id)
      );

      if (!aiResponse) {
        return res.status(500).json({ success: false, error: 'Failed to generate AI response' });
      }

      await aiCreditService.deductCredits(
        organizationId,
        1,
        {
          operation: 'ai_response',
          userId: req.user._id,
          interactionId: interaction._id.toString(),
          platform: interaction.platform,
          messagePreview: interaction.lastMessage?.content?.substring(0, 100) || ''
        },
        { aiApiUsageId }
      );
      suggestCreditsDeducted = 1;

      const updatedCredits = await aiCreditService.getUsage(organizationId);

      res.status(200).json({
        success: true,
        data: { suggestedReply: aiResponse.content, confidence: aiResponse.confidence, usedKnowledgeBase: aiResponse.usedKnowledgeBase, knowledgeBaseCount: aiResponse.knowledgeBaseCount },
        credits: updatedCredits, message: 'AI reply generated successfully'
      });
    } catch (aiError) {
      console.error('AI service error in suggestReply:', aiError.message);
      if (suggestCreditsDeducted > 0) {
        await aiCreditService.rollbackCredits(organizationId, suggestCreditsDeducted, { operation: 'ai_response', userId: req.user?._id, reason: aiError.message });
      }
      return res.status(500).json({
        success: false, error: aiError.message || 'Failed to generate AI response. Please check your OpenAI API configuration.'
      });
    }
  } catch (error) {
    console.error('Suggest reply error:', error);
    next(error);
  }
};

// @desc    Generate AI-assisted replies (short, detailed, sales) for a conversation
// @route   POST /api/inbox/:id/ai-assist
// @access  Private
exports.aiAssist = async (req, res, next) => {
  let assistCreditsDeducted = 0;
  const organizationId = req.user.organization._id.toString();
  const aiCreditService = require('../services/aiCreditService');
  try {
    const interaction = await Interaction.findById(req.params.id);
    if (!interaction) {
      return res.status(404).json({ success: false, error: 'Interaction not found' });
    }
    if (interaction.organization.toString() !== req.user.organization._id.toString()) {
      return res.status(403).json({ success: false, error: 'Access denied' });
    }
    const creditCheck = await aiCreditService.checkCredits(organizationId, 1);
    if (!creditCheck.allowed) {
      return res.status(403).json({
        success: false,
        error: creditCheck.error || 'Insufficient AI credits',
        code: creditCheck.code || 'INSUFFICIENT_CREDITS',
        credits: { current: creditCheck.current, limit: creditCheck.limit, remaining: creditCheck.remaining }
      });
    }

    // Gather conversation context: latest messages from thread
    const childInteractions = await Interaction.find({
      $or: [
        { parentId: interaction._id.toString() },
        { parentId: interaction.platformId }
      ],
      organization: req.user.organization._id
    }).sort({ platformCreatedAt: -1 }).limit(10).lean();

    const recentReplies = (interaction.replies || [])
      .filter(r => r.status !== 'deleted')
      .slice(-10);

    const conversationContext = [];
    conversationContext.push(`Customer (${interaction.author?.name || 'Unknown'}): "${interaction.content}"`);
    for (const child of childInteractions.reverse()) {
      conversationContext.push(`Customer: "${child.content}"`);
    }
    for (const reply of recentReplies) {
      const label = reply.isPlatformReply ? 'Customer' : 'Agent';
      conversationContext.push(`${label}: "${reply.content}"`);
    }
    const chatContext = conversationContext.join('\n');

    // Load knowledge base entries for context
    const KnowledgeBase = require('../models/KnowledgeBase');
    const { entries: kbEntries, fromFallback: kbFallback } = await aiService.searchKnowledgeBase(
      organizationId,
      interaction.content,
      5
    );
    // Track real (non-fallback) matches so usage stats stay accurate
    if (!kbFallback && kbEntries && kbEntries.length > 0) {
      for (const kb of kbEntries) {
        try {
          await kb.incrementUsage();
        } catch (usageErr) {
          console.error('Error incrementing KB usage (aiAssist):', usageErr);
        }
      }
    }
    // Cap each KB entry to avoid bloating the AI Assist prompt
    const MAX_KB_ENTRY_CHARS = 600;
    const kbContext = kbEntries && kbEntries.length > 0
      ? kbEntries.map(kb => {
          const body = (kb.content || '').substring(0, MAX_KB_ENTRY_CHARS);
          const truncated = (kb.content || '').length > MAX_KB_ENTRY_CHARS ? '…' : '';
          return `${kb.title}: ${body}${truncated}`;
        }).join('\n\n')
      : '';

    const baseSystemPrompt = `You are a professional customer service AI assistant.
You help agents draft replies to customer messages.

CONVERSATION CONTEXT:
${chatContext}

${kbContext ? `KNOWLEDGE BASE (use this information to ground your answers):\n${kbContext}` : 'No knowledge base content available. Provide helpful general responses.'}

IMPORTANT RULES:
- Address the customer's concern directly
- Be polite, empathetic, and professional
- If knowledge base content is provided, prioritize those facts
- Never say placeholders like "[Your Name]" or "[Company]"
- Match the tone to the platform: ${interaction.platform} (${interaction.type})
- Do NOT include a greeting like "Dear customer" unless the message is formal`;

    const replyTypes = {
      short: {
        instruction: 'Generate a SHORT, concise reply (1-2 sentences max). Get straight to the point.',
        maxTokens: 100,
        temperature: 0.6
      },
      detailed: {
        instruction: 'Generate a DETAILED, comprehensive reply (3-5 sentences). Cover all relevant points thoroughly while remaining friendly.',
        maxTokens: 300,
        temperature: 0.7
      },
      sales: {
        instruction: 'Generate a SALES-oriented reply (2-4 sentences). Address the query, then naturally suggest relevant products/services or upsell opportunities. Be helpful, not pushy.',
        maxTokens: 250,
        temperature: 0.75
      }
    };

    const generateOne = async (type) => {
      const config = replyTypes[type];
      return runWithAiContextAndUsageId(
        {
          organizationId: req.user.organization._id,
          userId: req.user._id,
          feature: `inbox.ai_assist.${type}`
        },
        async () => {
          const result = await aiService.generateText(
            `${baseSystemPrompt}\n\n${config.instruction}`,
            `Customer message: "${interaction.content}"\nPlatform: ${interaction.platform}\nType: ${interaction.type}\nSentiment: ${interaction.sentiment || 'unknown'}`,
            { temperature: config.temperature, maxTokens: config.maxTokens }
          );
          return { type, content: result };
        }
      );
    };

    const [wShort, wDetailed, wSales] = await Promise.all([
      generateOne('short'),
      generateOne('detailed'),
      generateOne('sales')
    ]);
    const shortReply = wShort.result;
    const detailedReply = wDetailed.result;
    const salesReply = wSales.result;
    const assistLinkId = wSales.aiApiUsageId || wDetailed.aiApiUsageId || wShort.aiApiUsageId;

    await aiCreditService.deductCredits(
      organizationId,
      1,
      {
        operation: 'ai_assist',
        userId: req.user._id,
        interactionId: interaction._id.toString(),
        platform: interaction.platform,
        messagePreview: interaction.content?.substring(0, 100) || ''
      },
      { aiApiUsageId: assistLinkId }
    );
    assistCreditsDeducted = 1;

    const updatedCredits = await aiCreditService.getUsage(organizationId);

    res.status(200).json({
      success: true,
      data: { short: shortReply.content, detailed: detailedReply.content, sales: salesReply.content, usedKnowledgeBase: kbEntries && kbEntries.length > 0, knowledgeBaseCount: kbEntries ? kbEntries.length : 0 },
      credits: updatedCredits, message: 'AI assistance generated successfully'
    });
  } catch (error) {
    console.error('AI Assist error:', error);
    if (assistCreditsDeducted > 0 && organizationId) {
      await aiCreditService.rollbackCredits(organizationId, assistCreditsDeducted, { operation: 'ai_assist', userId: req.user?._id, reason: error.message });
    }
    if (error.response?.status === 401) {
      return res.status(500).json({ success: false, error: 'OpenAI API key is invalid or expired.' });
    }
    return res.status(500).json({ success: false, error: error.message || 'Failed to generate AI assistance. Please try again.' });
  }
};

// @desc    Regenerate a single AI reply type (short/detailed/sales)
// @route   POST /api/inbox/:id/ai-assist/regenerate
// @access  Private
exports.aiAssistRegenerate = async (req, res, next) => {
  let regenCreditsDeducted = 0;
  const organizationId = req.user.organization._id.toString();
  const aiCreditService = require('../services/aiCreditService');
  try {
    const { type } = req.body;
    if (!['short', 'detailed', 'sales'].includes(type)) {
      return res.status(400).json({ success: false, error: 'Invalid type. Must be short, detailed, or sales.' });
    }

    const interaction = await Interaction.findById(req.params.id);
    if (!interaction) {
      return res.status(404).json({ success: false, error: 'Interaction not found' });
    }
    if (interaction.organization.toString() !== req.user.organization._id.toString()) {
      return res.status(403).json({ success: false, error: 'Access denied' });
    }
    const creditCheck = await aiCreditService.checkCredits(organizationId, 1);
    if (!creditCheck.allowed) {
      return res.status(403).json({
        success: false,
        error: creditCheck.error || 'Insufficient AI credits',
        code: creditCheck.code || 'INSUFFICIENT_CREDITS',
        credits: { current: creditCheck.current, limit: creditCheck.limit, remaining: creditCheck.remaining }
      });
    }

    const childInteractions = await Interaction.find({
      $or: [
        { parentId: interaction._id.toString() },
        { parentId: interaction.platformId }
      ],
      organization: req.user.organization._id
    }).sort({ platformCreatedAt: -1 }).limit(10).lean();

    const recentReplies = (interaction.replies || [])
      .filter(r => r.status !== 'deleted')
      .slice(-10);

    const conversationContext = [];
    conversationContext.push(`Customer (${interaction.author?.name || 'Unknown'}): "${interaction.content}"`);
    for (const child of childInteractions.reverse()) {
      conversationContext.push(`Customer: "${child.content}"`);
    }
    for (const reply of recentReplies) {
      const label = reply.isPlatformReply ? 'Customer' : 'Agent';
      conversationContext.push(`${label}: "${reply.content}"`);
    }
    const chatContext = conversationContext.join('\n');

    const KnowledgeBase = require('../models/KnowledgeBase');
    const { entries: kbEntries, fromFallback: kbFallback } = await aiService.searchKnowledgeBase(
      organizationId,
      interaction.content,
      5
    );
    // Track real (non-fallback) matches so usage stats stay accurate
    if (!kbFallback && kbEntries && kbEntries.length > 0) {
      for (const kb of kbEntries) {
        try {
          await kb.incrementUsage();
        } catch (usageErr) {
          console.error('Error incrementing KB usage (aiAssistRegenerate):', usageErr);
        }
      }
    }
    // Cap each KB entry to avoid bloating the regenerate prompt
    const MAX_KB_REGEN_ENTRY_CHARS = 600;
    const kbContext = kbEntries && kbEntries.length > 0
      ? kbEntries.map(kb => {
          const body = (kb.content || '').substring(0, MAX_KB_REGEN_ENTRY_CHARS);
          const truncated = (kb.content || '').length > MAX_KB_REGEN_ENTRY_CHARS ? '…' : '';
          return `${kb.title}: ${body}${truncated}`;
        }).join('\n\n')
      : '';

    const replyConfigs = {
      short: { instruction: 'Generate a SHORT, concise reply (1-2 sentences max). Get straight to the point.', maxTokens: 100, temperature: 0.8 },
      detailed: { instruction: 'Generate a DETAILED, comprehensive reply (3-5 sentences). Cover all relevant points thoroughly while remaining friendly.', maxTokens: 300, temperature: 0.8 },
      sales: { instruction: 'Generate a SALES-oriented reply (2-4 sentences). Address the query, then naturally suggest relevant products/services. Be helpful, not pushy.', maxTokens: 250, temperature: 0.85 }
    };

    const config = replyConfigs[type];
    const systemPrompt = `You are a professional customer service AI assistant.
You help agents draft replies to customer messages. Generate a DIFFERENT response than the previous one.

CONVERSATION CONTEXT:
${chatContext}

${kbContext ? `KNOWLEDGE BASE:\n${kbContext}` : ''}

${config.instruction}`;

    const { result: content, aiApiUsageId } = await runWithAiContextAndUsageId(
      {
        organizationId: req.user.organization._id,
        userId: req.user._id,
        feature: `inbox.ai_assist_regenerate.${type}`
      },
      () =>
        aiService.generateText(
          systemPrompt,
          `Customer message: "${interaction.content}"\nPlatform: ${interaction.platform}\nType: ${interaction.type}\nSentiment: ${interaction.sentiment || 'unknown'}`,
          { temperature: config.temperature, maxTokens: config.maxTokens }
        )
    );

    await aiCreditService.deductCredits(
      organizationId,
      1,
      {
        operation: 'ai_assist_regenerate',
        userId: req.user._id,
        interactionId: interaction._id.toString(),
        platform: interaction.platform,
        messagePreview: interaction.content?.substring(0, 100) || ''
      },
      { aiApiUsageId }
    );
    regenCreditsDeducted = 1;

    const updatedCredits = await aiCreditService.getUsage(organizationId);

    res.status(200).json({
      success: true, data: { type, content },
      credits: updatedCredits, message: `${type} reply regenerated successfully`
    });
  } catch (error) {
    console.error('AI Assist regenerate error:', error);
    if (regenCreditsDeducted > 0) {
      await aiCreditService.rollbackCredits(organizationId, regenCreditsDeducted, { operation: 'ai_assist_regenerate', userId: req.user?._id, reason: error.message });
    }
    return res.status(500).json({ success: false, error: error.message || 'Failed to regenerate AI reply.' });
  }
};

// @desc    Generate auto-replies for pending interactions
// @route   POST /api/inbox/auto-reply/generate
// @access  Private (Admin/Manager)
exports.generateAutoReplies = async (req, res, next) => {
  const organizationId = req.user.organization._id.toString();
  const aiCreditService = require('../services/aiCreditService');
  try {
    const { interactionIds, autoSend = false } = req.body;

    // Get organization settings
    const organization = await Organization.findById(req.user.organization._id);

    if (!organization.autoReplySettings.enabled) {
      return res.status(400).json({
        success: false,
        error: 'Auto-reply is not enabled for your organization'
      });
    }

    // Check daily limit
    const today = new Date().toDateString();
    const lastReset = organization.autoReplySettings.lastReplyResetDate 
      ? new Date(organization.autoReplySettings.lastReplyResetDate).toDateString()
      : null;

    if (lastReset !== today) {
      organization.autoReplySettings.repliesCountToday = 0;
      organization.autoReplySettings.lastReplyResetDate = new Date();
      await organization.save();
    }

    if (organization.autoReplySettings.repliesCountToday >= organization.autoReplySettings.maxRepliesPerDay) {
      return res.status(429).json({
        success: false,
        error: 'Daily auto-reply limit reached'
      });
    }

    // Get interactions
    const query = interactionIds && interactionIds.length > 0
      ? { _id: { $in: interactionIds }, organization: req.user.organization._id }
      : { 
          organization: req.user.organization._id,
          status: 'unread',
          $or: [
            { replies: { $size: 0 } },
            { replies: { $exists: false } }
          ]
        };

    const interactions = await Interaction.find(query)
      .populate('platformConnection')
      .limit(20); // Process max 20 at a time

    const results = {
      total: interactions.length,
      generated: 0,
      sent: 0,
      failed: 0,
      skipped: 0,
      details: []
    };

    for (const interaction of interactions) {
      try {
        // Check daily limit
        if (organization.autoReplySettings.repliesCountToday >= organization.autoReplySettings.maxRepliesPerDay) {
          results.skipped++;
          results.details.push({
            interactionId: interaction._id,
            status: 'skipped',
            reason: 'Daily limit reached'
          });
          continue;
        }

        // Check AI credits before generating
        const creditCheck = await aiCreditService.checkCredits(organizationId, 1);
        if (!creditCheck.allowed) {
          results.skipped++;
          results.details.push({
            interactionId: interaction._id,
            status: 'skipped',
            reason: 'Insufficient AI credits'
          });
          continue;
        }

        // Generate auto-reply
        const autoReply = await aiService.generateAutoReply(
          interaction,
          req.user.organization._id,
          organization
        );

        if (!autoReply.eligible) {
          results.skipped++;
          results.details.push({
            interactionId: interaction._id,
            status: 'skipped',
            reason: autoReply.reason
          });
          continue;
        }

        results.generated++;
        // Credits: generateAutoReply already deducts 1 credit (operation: auto_reply)

        // If autoSend is true and organization allows it, send the reply
        if (autoSend && organization.autoReplySettings.autoSend && !organization.autoReplySettings.requireApproval) {
          try {
            // Send reply to platform
            let platformResponseId = null;
            let replyStatus = 'sent';

            if (interaction.platformConnection && interaction.platformConnection.status === 'connected') {
              if (interaction.platform === 'youtube') {
                const youtubeService = require('../integrations/google/youtubeService');
                const result = await youtubeService.replyToComment(
                  interaction.platformConnection,
                  interaction.platformId,
                  autoReply.response.content
                );
                
                if (result.success && result.commentId) {
                  platformResponseId = result.commentId;
                  replyStatus = 'sent';
                } else {
                  replyStatus = 'failed';
                }
              }
              // Add other platforms here
            }

            if (replyStatus === 'sent') {
              // Add reply to database
              await interaction.addReply(autoReply.response.content, req.user._id, platformResponseId, true);
              interaction.respondedAt = new Date();
              await interaction.save();

              results.sent++;
              organization.autoReplySettings.repliesCountToday++;

              results.details.push({
                interactionId: interaction._id,
                status: 'sent',
                reply: autoReply.response.content,
                confidence: autoReply.response.confidence
              });
            } else {
              results.failed++;
              results.details.push({
                interactionId: interaction._id,
                status: 'failed',
                reason: 'Failed to send to platform'
              });
            }
          } catch (sendError) {
            results.failed++;
            results.details.push({
              interactionId: interaction._id,
              status: 'failed',
              reason: sendError.message
            });
          }
        } else {
          // Save as suggested reply (not sent)
          results.details.push({
            interactionId: interaction._id,
            status: 'generated',
            suggestedReply: autoReply.response.content,
            confidence: autoReply.response.confidence,
            usedKnowledgeBase: autoReply.response.usedKnowledgeBase
          });
        }
      } catch (error) {
        results.failed++;
        results.details.push({
          interactionId: interaction._id,
          status: 'error',
          reason: error.message
        });
      }
    }

    // Save updated organization
    await organization.save();

    // Clear cache
    await cacheService.delPattern(`interactions:${req.user.organization._id}*`);

    res.status(200).json({
      success: true,
      data: results,
      message: `Generated ${results.generated} replies, sent ${results.sent}, skipped ${results.skipped}, failed ${results.failed}`
    });
  } catch (error) {
    console.error('Auto-reply generation error:', error);
    next(error);
  }
};

// @desc    Test/trigger auto-reply manually (for debugging)
// @route   POST /api/inbox/auto-reply/test-trigger
// @access  Private (Admin/Manager)
exports.testAutoReplyTrigger = async (req, res, next) => {
  const organizationId = req.user.organization._id;
  const aiCreditService = require('../services/aiCreditService');
  try {
    const organization = await Organization.findById(organizationId);

    if (!organization) {
      return res.status(404).json({
        success: false,
        message: 'Organization not found'
      });
    }

    // Find unread interactions without replies
    const query = {
      organization: organizationId,
      status: 'unread',
      $or: [
        { replies: { $size: 0 } },
        { replies: { $exists: false } }
      ]
    };

    const interactions = await Interaction.find(query)
      .populate('platformConnection')
      .limit(20);

    if (interactions.length === 0) {
      return res.status(200).json({
        success: true,
        message: 'No eligible interactions found',
        data: {
          found: 0,
          query: query,
          settings: organization.autoReplySettings
        }
      });
    }

    const results = {
      processed: 0,
      sent: 0,
      skipped: 0,
      details: []
    };

    for (const interaction of interactions) {
      const creditCheck = await aiCreditService.checkCredits(organizationId, 1);
      if (!creditCheck.allowed) {
        results.skipped++;
        results.details.push({
          id: interaction._id,
          platform: interaction.platform,
          type: interaction.type,
          status: 'skipped',
          reason: 'Insufficient AI credits'
        });
        continue;
      }

      // Check eligibility
      const autoReply = await aiService.generateAutoReply(
        interaction,
        organizationId,
        organization
      );

      if (!autoReply.eligible) {
        results.skipped++;
        results.details.push({
          id: interaction._id,
          platform: interaction.platform,
          type: interaction.type,
          status: 'skipped',
          reason: autoReply.reason
        });
        continue;
      }

      results.processed++;
      // Credits: generateAutoReply already deducts 1 credit

      results.details.push({
        id: interaction._id,
        platform: interaction.platform,
        type: interaction.type,
        status: 'generated',
        confidence: autoReply.response.confidence,
        reply: autoReply.response.content
      });
    }

    res.status(200).json({
      success: true,
      message: 'Auto-reply test completed',
      data: results
    });

  } catch (error) {
    console.error('Auto-reply test error:', error);
    next(error);
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
    console.error('Get escalated interactions error:', error);
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
    console.error('Get available agents error:', error);
    next(error);
  }
};

// @desc    Bulk assign interactions to agent
// @route   POST /api/inbox/assign-bulk
// @access  Private (Manager/Admin)
exports.bulkAssignInteractions = async (req, res, next) => {
  try {
    const { interactionIds, userId } = req.body;

    if (!interactionIds || !Array.isArray(interactionIds) || interactionIds.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'interactionIds array is required'
      });
    }

    if (!userId) {
      return res.status(400).json({
        success: false,
        error: 'userId is required'
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

    const assignedAt = new Date();

    // Update all interactions — also push to assignmentHistory so the
    // "Assigned to X by Y" timeline banner appears in the detail view.
    const result = await Interaction.updateMany(
      {
        _id: { $in: interactionIds },
        organization: req.user.organization._id
      },
      {
        $set: {
          assignedTo: userId,
          assignedBy: req.user._id,
          assignedAt,
          assignmentReason: 'manual',
          status: 'assigned'
        },
        $push: {
          assignmentHistory: {
            assignedTo: userId,
            assignedBy: req.user._id,
            assignedAt,
            reason: 'manual'
          }
        }
      }
    );

    // Clear cache
    await cacheService.delPattern(`interactions:${req.user.organization._id}*`);

    res.status(200).json({
      success: true,
      data: {
        updated: result.modifiedCount
      },
      message: `Successfully assigned ${result.modifiedCount} interaction(s) to ${agent.firstName} ${agent.lastName}`
    });
  } catch (error) {
    console.error('Bulk assign error:', error);
    next(error);
  }
};

// @desc    Bulk update interaction status
// @route   POST /api/inbox/status-bulk
// @access  Private
exports.bulkUpdateStatus = async (req, res, next) => {
  try {
    const { interactionIds, status } = req.body;

    if (!interactionIds || !Array.isArray(interactionIds) || interactionIds.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'interactionIds array is required'
      });
    }

    if (!status || !['unread', 'read', 'replied', 'resolved', 'archived', 'spam'].includes(status)) {
      return res.status(400).json({
        success: false,
        error: 'status must be one of: unread, read, replied, resolved, archived, spam'
      });
    }

    const update = { status };
    if (status === 'resolved') {
      update.resolvedAt = new Date();
    }

    const result = await Interaction.updateMany(
      {
        _id: { $in: interactionIds },
        organization: req.user.organization._id
      },
      { $set: update }
    );

    await cacheService.delPattern(`interactions:${req.user.organization._id}*`);

    res.status(200).json({
      success: true,
      data: { updated: result.modifiedCount },
      message: `Successfully updated ${result.modifiedCount} interaction(s) to ${status}`
    });
  } catch (error) {
    console.error('Bulk status update error:', error);
    next(error);
  }
};

// @desc    Bulk add label to interactions
// @route   POST /api/inbox/labels-bulk
// @access  Private
exports.bulkAddLabel = async (req, res, next) => {
  try {
    const { interactionIds, labelId } = req.body;

    if (!interactionIds || !Array.isArray(interactionIds) || interactionIds.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'interactionIds array is required'
      });
    }

    if (!labelId) {
      return res.status(400).json({
        success: false,
        error: 'labelId is required'
      });
    }

    const label = await Label.findById(labelId);
    if (!label) {
      return res.status(404).json({
        success: false,
        error: 'Label not found'
      });
    }

    const interactions = await Interaction.find({
      _id: { $in: interactionIds },
      organization: req.user.organization._id
    });

    let updated = 0;
    for (const interaction of interactions) {
      if (!interaction.labels.includes(labelId)) {
        interaction.labels.push(labelId);
        await interaction.save();
        await label.incrementUsage();
        updated++;
      }
    }

    await cacheService.delPattern(`interactions:${req.user.organization._id}*`);

    res.status(200).json({
      success: true,
      data: { updated },
      message: `Successfully added label to ${updated} interaction(s)`
    });
  } catch (error) {
    console.error('Bulk add label error:', error);
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
    console.error('Get escalation stats error:', error);
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
    await cacheService.delPattern(`interactions:${req.user.organization._id}*`);

    res.status(200).json({
      success: true,
      data: interaction,
      message: 'Interaction escalated to human agent successfully'
    });
  } catch (error) {
    console.error('Manual escalation error:', error);
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
    console.error('getAttachment error:', error.message);
    res.status(500).json({ success: false, error: 'Failed to load attachment' });
  }
};

// @desc    Get author avatar (profile picture) - proxy for Instagram/Facebook to avoid CORS
// @route   GET /api/inbox/avatar/:platform/:userId
// @access  Private
exports.getAuthorAvatar = async (req, res, next) => {
  try {
    const { platform, userId } = req.params;
    const pageId = req.query.pageId; // optional; for Facebook, pick the connection for this page
    if (!platform || !userId) {
      return res.status(400).json({ success: false, error: 'platform and userId required' });
    }
    const orgId = req.user.organization._id;
    const platformKey = platform.toLowerCase();

    // For Facebook, prefer the connection that owns the page (when pageId provided or single connection).
    let connection;
    if (platformKey === 'facebook') {
      const filter = {
        organization: orgId,
        platform: 'facebook',
        isActive: true,
        status: 'connected'
      };
      if (pageId) filter.platformPageId = { $in: [String(pageId), pageId] };
      connection = await PlatformConnection.findOne(filter).select('accessToken').lean();
    } else {
      connection = await PlatformConnection.findOne({
        organization: orgId,
        platform: platformKey,
        isActive: true,
        status: 'connected'
      }).select('accessToken').lean();
    }

    if (!connection || !connection.accessToken) {
      return res.status(404).json({ success: false, error: 'Platform connection not found' });
    }
    const token = connection.accessToken;
    const apiVersion = 'v18.0';

    if (platform.toLowerCase() === 'instagram') {
      // For Instagram, try to get profile picture via Facebook Graph API
      // Note: Instagram user profile pics via graph.instagram.com require different permissions
      // and only work for users who've used Instagram Login, not commenters/messengers
      try {
        // Try Facebook Graph API endpoint (works for some Instagram user IDs)
        const picUrl = `https://graph.facebook.com/${apiVersion}/${userId}/picture?type=normal&access_token=${encodeURIComponent(token)}`;
        const imgRes = await axios.get(picUrl, { 
          responseType: 'arraybuffer', 
          maxRedirects: 5, 
          timeout: 8000,
          validateStatus: (status) => status === 200
        });
        
        res.set('Content-Type', imgRes.headers['content-type'] || 'image/jpeg');
        res.set('Cache-Control', 'private, max-age=3600');
        res.send(Buffer.from(imgRes.data));
        return;
      } catch (apiError) {
        // If API fails, return a default Instagram avatar placeholder
        // This is common when the user ID can't be accessed via Graph API
        return res.status(404).json({ 
          success: false, 
          error: 'Avatar not available',
          useDefault: true 
        });
      }
    }

    if (platform.toLowerCase() === 'facebook') {
      try {
        const picUrl = `https://graph.facebook.com/${apiVersion}/${userId}/picture?type=normal&access_token=${encodeURIComponent(token)}`;
        const imgRes = await axios.get(picUrl, { responseType: 'arraybuffer', maxRedirects: 5, timeout: 8000, validateStatus: s => s === 200 });
        res.set('Content-Type', imgRes.headers['content-type'] || 'image/jpeg');
        res.set('Cache-Control', 'private, max-age=3600');
        res.send(Buffer.from(imgRes.data));
      } catch (fbErr) {
        // 403 = user privacy / page-token can't access; 404 = user not found. Both are expected.
        return res.status(404).json({ success: false, error: 'Avatar not available', useDefault: true });
      }
      return;
    }

    return res.status(400).json({ success: false, error: 'Unsupported platform' });
  } catch (error) {
    // Handle avatar fetch errors gracefully
    if (error.response?.status === 404) {
      return res.status(404).json({ 
        success: false, 
        error: 'Avatar not found',
        useDefault: true 
      });
    }
    
    if (error.response?.status === 400) {
      // 400 errors are common for Instagram user IDs that can't be accessed
      // Return 404 with useDefault flag instead of logging as error
      return res.status(404).json({ 
        success: false, 
        error: 'Avatar not available',
        useDefault: true 
      });
    }
    
    // 403/404/400 are expected (privacy settings, user not accessible) — suppress to avoid log spam.
    // Only log truly unexpected errors.
    const status = error.response?.status;
    if (error.code !== 'ECONNABORTED' && status !== 400 && status !== 403 && status !== 404) {
      console.error('getAuthorAvatar error:', error.message);
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
    console.error('backfillFacebookAvatars error:', error.message);
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
    console.error('getBucketView error:', error.message);
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
    console.error('getTopicInsights error:', error.message);
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
    console.error('generateSummary error:', error.message);
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
    console.error('saveSummary error:', error.message);
    next(error);
  }
};
