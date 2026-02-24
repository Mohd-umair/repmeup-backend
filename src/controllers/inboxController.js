const Interaction = require('../models/Interaction');
const Label = require('../models/Label');
const ResponseTemplate = require('../models/ResponseTemplate');
const cacheService = require('../services/cacheService');
const aiService = require('../services/aiService');
const Organization = require('../models/Organization');
const escalationService = require('../services/escalationService');
const User = require('../models/User');
const PlatformConnection = require('../models/PlatformConnection');
const googleService = require('../integrations/google/googleService');
const axios = require('axios');

// @desc    Get all interactions (inbox)
// @route   GET /api/inbox
// @access  Private
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
      viewMode,
      postId,
      page = 1,
      limit = 50,
      sortBy = 'createdAt',
      sortOrder = 'desc'
    } = req.query;

    // Build query
    const query = { organization: req.user.organization._id };

    // Only show parent interactions (top-level comments/reviews), not replies
    // Replies are shown in the detail view when clicking on a parent
    // This filter will be added to $and array below

    if (platform) query.platform = platform;
    if (type) query.type = type;
    if (postId) query['metadata.postId'] = postId;
    if (sentiment) query.sentiment = sentiment;
    if (status) query.status = status;
    if (assignedTo) query.assignedTo = assignedTo;
    
    // Label filter - check if label exists in labels array
    if (label) {
      query.labels = label; // MongoDB will match if label ID exists in the labels array
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
    }).select('_id');

    const activeConnectionIds = activeConnections.map(conn => conn._id);

    // Build platform connection filter: only show from active connections OR no connection (website interactions)
    // This ensures disconnected platform interactions are hidden
    const platformConnectionFilter = activeConnectionIds.length > 0 ? {
      $or: [
        { platformConnection: { $in: activeConnectionIds } },
        { platformConnection: { $exists: false } },
        { platformConnection: null }
      ]
    } : {
      $or: [
        { platformConnection: { $exists: false } },
        { platformConnection: null }
      ]
    };

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

    // Use $and to combine all conditions
    query.$and = conditionsToAnd;

    // Calculate pagination
    const skip = (page - 1) * limit;
    const sort = { [effectiveSortBy]: effectiveSortOrder === 'desc' ? -1 : 1 };

    // Try to get from cache (include search in cache key, normalized)
    const cacheSearchKey = searchTerm ? searchTerm.toLowerCase().trim() : '';
    const effectiveAssignedTo = viewMode === 'assigned' ? req.user._id.toString() : (assignedTo || '');
    const cacheKey = cacheService.interactionsKey(req.user.organization._id, {
      platform,
      type,
      sentiment,
      status,
      label, // Include label in cache key to prevent wrong cached results
      postId: postId || '',
      viewMode: viewMode || '',
      search: cacheSearchKey,
      page,
      limit,
      assignedTo: req.user.role === 'agent' ? req.user._id.toString() : effectiveAssignedTo,
      activeConnections: activeConnectionIds.map(id => id.toString()).sort().join(',')
    });

    const cached = await cacheService.get(cacheKey);
    if (cached) {
      return res.status(200).json({
        success: true,
        data: cached,
        cached: true
      });
    }

    // Execute query
    const interactions = await Interaction.find(query)
      .populate('assignedTo', 'firstName lastName email avatar')
      .populate('assignedBy', 'firstName lastName email')
      .populate('assignmentHistory.assignedTo', 'firstName lastName email')
      .populate('assignmentHistory.assignedBy', 'firstName lastName email')
      .populate('labels', 'name color icon')
      .populate('replies.sentBy', 'firstName lastName')
      .populate('platformConnection', 'platform isActive status') // Populate to verify
      .sort(sort)
      .limit(parseInt(limit))
      .skip(skip);

    // Get total count
    const total = await Interaction.countDocuments(query);

    const result = {
      interactions,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / limit)
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
    const interaction = await Interaction.findById(req.params.id)
      .populate('assignedTo', 'firstName lastName email avatar')
      .populate('assignedBy', 'firstName lastName email')
      .populate('assignmentHistory.assignedTo', 'firstName lastName email')
      .populate('assignmentHistory.assignedBy', 'firstName lastName email')
      .populate('labels')
      .populate('replies.sentBy', 'firstName lastName avatar')
      .populate('internalNotes.addedBy', 'firstName lastName avatar');

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

    // Mark as read
    if (!interaction.isRead || interaction.status === 'unread') {
      interaction.isRead = true;
      interaction.readAt = new Date();
      interaction.readBy = req.user._id;
      // Update status from 'unread' to 'read' if it's currently 'unread'
      if (interaction.status === 'unread') {
        interaction.status = 'read';
      }
      await interaction.save();
      
      // Clear cache to reflect the status change
      await cacheService.delPattern(`interactions:${req.user.organization._id}*`);
    }

    // Fetch child interactions (replies from the platform, e.g., YouTube user replies)
    // These are separate Interaction documents with parentId pointing to this interaction
    const childInteractions = await Interaction.find({
      $or: [
        { parentId: interaction._id.toString() },
        { parentId: interaction.platformId } // Also check by platformId
      ],
      organization: req.user.organization._id
    }).sort({ platformCreatedAt: 1 }); // Sort by creation time

    // Convert to plain object for modification
    const interactionObj = interaction.toObject();

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
      ].sort((a, b) => new Date(a.sentAt) - new Date(b.sentAt));

      interactionObj.replies = allReplies;
      interactionObj.totalReplies = allReplies.length;
      interactionObj.platformRepliesCount = platformReplies.length;
    }

    res.status(200).json({
      success: true,
      data: interactionObj
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
    const { content, useTemplate, templateId, templateVariables } = req.body;

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
      const igAccountId = interaction.metadata?.instagramAccountId;

      if (isInstagramDm && igAccountId) {
        // Instagram DM: MUST use the connection that owns the thread (platformUserId === igAccountId).
        // Match both string and number to avoid type mismatch (webhook sends string, DB may have number).
        const threadOwnerConn = await PlatformConnection.findOne({
          organization: interaction.organization,
          platform: 'instagram',
          platformUserId: { $in: [igAccountId, String(igAccountId)].filter(Boolean) },
          status: 'connected',
          isActive: true
        }).lean();
        if (threadOwnerConn) connection = threadOwnerConn;
        if (!connection) {
          console.warn('[Inbox Reply] Instagram DM: no connection for thread owner', { interactionId: interaction._id, metadataIgId: igAccountId });
        }
      }

      if (!connection && !isInstagramDm) {
        connection = interaction.platformConnection;
      }
      if (!connection && interaction.platform && interaction.organization && !isInstagramDm) {
        const conn = await PlatformConnection.findOne({
          organization: interaction.organization,
          platform: interaction.platform,
          status: 'connected',
          isActive: true
        }).lean();
        if (conn) connection = conn;
      }
      // Instagram DM without metadata: do not guess – require sync so we get the correct thread owner
      if (isInstagramDm && !igAccountId) {
        connection = null;
      }
      // For Instagram DM with metadata: never use a connection that isn't the thread owner
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
        if (interaction.platform === 'instagram' && interaction.type === 'dm') {
          errorMessage = 'This conversation is not linked to an Instagram account. Go to Settings → Integrations, open your Instagram connection and click Sync so we can link it to the account that receives these DMs, then try replying again.';
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
          // Send API requires Facebook Page ID (not Instagram business account ID)
          const pageId = connection.platformPageId || connection.platformData?.pageId;
          const recipientId = interaction.author?.platformId;
          if (!pageId || !recipientId) {
            replyStatus = 'failed';
            errorMessage = 'Missing page or recipient for Instagram DM reply. Reconnect Instagram in Settings so we have the Facebook Page ID.';
            console.error('[Inbox Reply] Instagram DM: missing pageId or recipientId', { hasPageId: !!pageId, hasRecipientId: !!recipientId });
          } else {
            console.log('[Inbox Reply] Instagram DM: using connection', { connectionId: connection._id, platformUserId: connection.platformUserId, pageId, metadataIgId: igAccountId });
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
        const result = await facebookService.replyToComment(
          connection,
          interaction.platformId,
          replyContent
        );
        
        if (result.success && result.commentId) {
          platformResponseId = result.commentId;
          replyStatus = 'sent';
        } else {
          replyStatus = 'failed';
          errorMessage = result.error || 'Failed to post reply to Facebook';
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
      errorMessage = metaUserMsg || platformError.message || 'Failed to post reply to platform';
    }

    // Add reply to database with platform response ID
    // Note: addReply sets status to 'replied', so we'll update it if failed
    const previousStatus = interaction.status;
    await interaction.addReply(replyContent, req.user._id, platformResponseId);
    
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
      await interaction.save();

      // IMPORTANT: Remove any pending AI processing jobs for this interaction
      // since it's already been replied to
      try {
        const { aiQueue } = require('../config/queue');
        const jobs = await aiQueue.getJobs(['waiting', 'active', 'delayed']);
        
        for (const job of jobs) {
          if (job.data.interactionId && job.data.interactionId.toString() === interaction._id.toString()) {
            await job.remove();
            console.log(`🗑️  [Reply] Removed pending AI job ${job.id} for interaction ${interaction._id} (already replied)`);
          }
        }
      } catch (queueError) {
        console.warn('Could not remove pending AI jobs:', queueError.message);
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

// @desc    Get inbox stats
// @route   GET /api/inbox/stats
// @access  Private
// @query   platform (optional) - filter by platform for per-platform stats
exports.getStats = async (req, res, next) => {
  try {
    const orgId = req.user.organization._id;
    const { platform } = req.query;

    // Match parent interactions only (exclude replies), same as inbox list
    const matchStage = {
      organization: orgId,
      $or: [
        { parentId: { $exists: false } },
        { parentId: null },
        { parentId: '' }
      ]
    };
    if (platform) matchStage.platform = platform;

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

    // Generate AI response using knowledge base
    try {
      const aiResponse = await aiService.generateResponse(
        interaction,
        req.user.organization._id
      );

      if (!aiResponse) {
        return res.status(500).json({
          success: false,
          error: 'Failed to generate AI response'
        });
      }

      // Deduct credits after successful generation
      await aiCreditService.deductCredits(organizationId, 1, {
        operation: 'ai_response',
        userId: req.user._id,
        interactionId: interaction._id.toString(),
        platform: interaction.platform,
        messagePreview: interaction.lastMessage?.content?.substring(0, 100) || ''
      });

      // Get updated credit balance
      const updatedCredits = await aiCreditService.getUsage(organizationId);

      res.status(200).json({
        success: true,
        data: {
          suggestedReply: aiResponse.content,
          confidence: aiResponse.confidence,
          usedKnowledgeBase: aiResponse.usedKnowledgeBase,
          knowledgeBaseCount: aiResponse.knowledgeBaseCount
        },
        credits: updatedCredits,
        message: 'AI reply generated successfully'
      });
    } catch (aiError) {
      // Handle AI service errors with user-friendly messages
      console.error('AI service error in suggestReply:', aiError.message);
      
      return res.status(500).json({
        success: false,
        error: aiError.message || 'Failed to generate AI response. Please check your OpenAI API configuration.'
      });
    }
  } catch (error) {
    console.error('Suggest reply error:', error);
    next(error);
  }
};

// @desc    Generate auto-replies for pending interactions
// @route   POST /api/inbox/auto-reply/generate
// @access  Private (Admin/Manager)
exports.generateAutoReplies = async (req, res, next) => {
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

    const organizationId = req.user.organization._id.toString();
    const aiCreditService = require('../services/aiCreditService');

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

        // Deduct credits after successful generation
        await aiCreditService.deductCredits(organizationId, 1, {
          operation: 'ai_response',
          userId: req.user._id,
          interactionId: interaction._id.toString(),
          platform: interaction.platform,
          isAutoReply: true,
          messagePreview: interaction.lastMessage?.content?.substring(0, 100) || ''
        });

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
  try {
    const organizationId = req.user.organization._id;
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

    const aiCreditService = require('../services/aiCreditService');

    // Process each interaction
    for (const interaction of interactions) {
      // Check AI credits before generating
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

      // Deduct credits after successful generation
      await aiCreditService.deductCredits(organizationId, 1, {
        operation: 'ai_response',
        userId: req.user._id,
        interactionId: interaction._id.toString(),
        platform: interaction.platform,
        isAutoReplyTest: true,
        messagePreview: interaction.lastMessage?.content?.substring(0, 100) || ''
      });

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

// @desc    Get author avatar (profile picture) - proxy for Instagram/Facebook to avoid CORS
// @route   GET /api/inbox/avatar/:platform/:userId
// @access  Private
exports.getAuthorAvatar = async (req, res, next) => {
  try {
    const { platform, userId } = req.params;
    if (!platform || !userId) {
      return res.status(400).json({ success: false, error: 'platform and userId required' });
    }
    const orgId = req.user.organization._id;
    const connection = await PlatformConnection.findOne({
      organization: orgId,
      platform: platform.toLowerCase(),
      isActive: true,
      status: 'connected'
    });
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
      const picUrl = `https://graph.facebook.com/${apiVersion}/${userId}/picture?type=normal&access_token=${encodeURIComponent(token)}`;
      const imgRes = await axios.get(picUrl, { responseType: 'arraybuffer', maxRedirects: 5, timeout: 8000 });
      res.set('Content-Type', imgRes.headers['content-type'] || 'image/jpeg');
      res.set('Cache-Control', 'private, max-age=3600');
      res.send(Buffer.from(imgRes.data));
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
    
    // Only log unexpected errors
    if (error.code !== 'ECONNABORTED' && error.response?.status !== 400) {
      console.error('getAuthorAvatar error:', error.message);
    }
    
    res.status(404).json({ 
      success: false, 
      error: 'Avatar not available',
      useDefault: true 
    });
  }
};

