const Interaction = require('../models/Interaction');
const Label = require('../models/Label');
const ResponseTemplate = require('../models/ResponseTemplate');
const cacheService = require('../services/cacheService');
const aiService = require('../services/aiService');
const Organization = require('../models/Organization');

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
      page = 1,
      limit = 50,
      sortBy = 'createdAt',
      sortOrder = 'desc'
    } = req.query;

    // Build query
    const query = { organization: req.user.organization._id };

    if (platform) query.platform = platform;
    if (type) query.type = type;
    if (sentiment) query.sentiment = sentiment;
    if (status) query.status = status;
    if (assignedTo) query.assignedTo = assignedTo;
    
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

    // Build agent condition
    const agentCondition = req.user.role === 'agent' ? {
      $or: [
        { assignedTo: req.user._id },
        { assignedTo: { $exists: false } }
      ]
    } : null;

    // Combine all conditions using $and
    const conditionsToAnd = [platformConnectionFilter];
    
    if (searchCondition) {
      conditionsToAnd.push(searchCondition);
    }
    
    if (agentCondition) {
      conditionsToAnd.push(agentCondition);
    }

    // If we have multiple conditions, use $and, otherwise merge directly
    if (conditionsToAnd.length > 1) {
      query.$and = conditionsToAnd;
    } else if (conditionsToAnd.length === 1) {
      Object.assign(query, conditionsToAnd[0]);
    }

    // Calculate pagination
    const skip = (page - 1) * limit;
    const sort = { [sortBy]: sortOrder === 'desc' ? -1 : 1 };

    // Try to get from cache (include search in cache key, normalized)
    // Normalize search term for cache key (lowercase and trimmed)
    const cacheSearchKey = searchTerm ? searchTerm.toLowerCase().trim() : '';
    const cacheKey = cacheService.interactionsKey(req.user.organization._id, {
      platform,
      type,
      sentiment,
      status,
      search: cacheSearchKey, // Include normalized search term in cache key
      page,
      limit,
      assignedTo: req.user.role === 'agent' ? req.user._id.toString() : assignedTo || '',
      activeConnections: activeConnectionIds.map(id => id.toString()).sort().join(',') // Include active connections in cache key
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

    res.status(200).json({
      success: true,
      data: interaction
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
      // Check if platform connection exists and is active
      if (!interaction.platformConnection) {
        replyStatus = 'failed';
        errorMessage = 'Platform connection not found. Please reconnect your YouTube account in Settings.';
      } else if (interaction.platformConnection.status !== 'connected' || !interaction.platformConnection.isActive) {
        replyStatus = 'failed';
        errorMessage = 'Platform connection is not active. Please reconnect your YouTube account in Settings.';
      } else if (interaction.platform === 'youtube') {
        const youtubeService = require('../integrations/google/youtubeService');
        const result = await youtubeService.replyToComment(
          interaction.platformConnection,
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
        // TODO: Implement Instagram reply
        console.log('Instagram reply not yet implemented');
        replyStatus = 'failed';
        errorMessage = 'Instagram replies are not yet implemented';
      } else if (interaction.platform === 'facebook') {
        // TODO: Implement Facebook reply
        console.log('Facebook reply not yet implemented');
        replyStatus = 'failed';
        errorMessage = 'Facebook replies are not yet implemented';
      } else {
        replyStatus = 'failed';
        errorMessage = `Replies for ${interaction.platform} are not yet implemented`;
      }
    } catch (platformError) {
      console.error('Error posting reply to platform:', platformError.response?.data || platformError.message);
      replyStatus = 'failed';
      errorMessage = platformError.response?.data?.error?.message || platformError.message || 'Failed to post reply to platform';
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

// @desc    Assign interaction to agent
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

    await interaction.assignTo(userId, req.user._id, reason || 'manual');

    // TODO: Send notification to assigned user

    // Clear cache
    await cacheService.delPattern(`interactions:${req.user.organization._id}*`);

    res.status(200).json({
      success: true,
      data: interaction,
      message: 'Interaction assigned successfully'
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
exports.getStats = async (req, res, next) => {
  try {
    const orgId = req.user.organization._id;

    const stats = await Interaction.aggregate([
      { $match: { organization: orgId } },
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
      }
    ]);

    res.status(200).json({
      success: true,
      data: stats[0] || {}
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

      res.status(200).json({
        success: true,
        data: {
          suggestedReply: aiResponse.content,
          confidence: aiResponse.confidence,
          usedKnowledgeBase: aiResponse.usedKnowledgeBase,
          knowledgeBaseCount: aiResponse.knowledgeBaseCount
        },
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
    console.log('\n🧪 [Test] Manual auto-reply trigger requested');
    
    const organizationId = req.user.organization._id;
    const organization = await Organization.findById(organizationId);

    if (!organization) {
      return res.status(404).json({
        success: false,
        message: 'Organization not found'
      });
    }

    console.log('📊 [Test] Organization settings:', {
      enabled: organization.autoReplySettings.enabled,
      triggerMode: organization.autoReplySettings.triggerMode,
      scheduleEnabled: organization.autoReplySettings.scheduleEnabled,
      autoSend: organization.autoReplySettings.autoSend,
      requireApproval: organization.autoReplySettings.requireApproval,
      enabledPlatforms: organization.autoReplySettings.enabledPlatforms,
      enabledTypes: organization.autoReplySettings.enabledTypes,
      minConfidence: organization.autoReplySettings.minConfidence,
      repliesCountToday: organization.autoReplySettings.repliesCountToday,
      maxRepliesPerDay: organization.autoReplySettings.maxRepliesPerDay
    });

    // Find unread interactions without replies
    const query = {
      organization: organizationId,
      status: 'unread',
      $or: [
        { replies: { $size: 0 } },
        { replies: { $exists: false } }
      ]
    };

    console.log('🔍 [Test] Query:', JSON.stringify(query));

    const interactions = await Interaction.find(query)
      .populate('platformConnection')
      .limit(20);

    console.log(`📝 [Test] Found ${interactions.length} eligible interactions`);

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

    // Process each interaction
    for (const interaction of interactions) {
      console.log(`\n📝 [Test] Processing: ${interaction._id} (${interaction.platform}/${interaction.type})`);
      console.log(`   Content: "${interaction.content.substring(0, 100)}..."`);
      console.log(`   Sentiment: ${interaction.sentiment}`);
      console.log(`   Status: ${interaction.status}`);
      console.log(`   Replies: ${interaction.replies?.length || 0}`);

      // Check eligibility
      const autoReply = await aiService.generateAutoReply(
        interaction,
        organizationId,
        organization
      );

      if (!autoReply.eligible) {
        console.log(`❌ [Test] Not eligible: ${autoReply.reason}`);
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

      console.log(`✅ [Test] Generated reply with confidence: ${autoReply.response.confidence}`);
      results.processed++;
      results.details.push({
        id: interaction._id,
        platform: interaction.platform,
        type: interaction.type,
        status: 'generated',
        confidence: autoReply.response.confidence,
        reply: autoReply.response.content
      });
    }

    console.log(`\n📊 [Test] Results: processed=${results.processed}, sent=${results.sent}, skipped=${results.skipped}`);

    res.status(200).json({
      success: true,
      message: 'Auto-reply test completed',
      data: results
    });

  } catch (error) {
    console.error('❌ [Test] Error:', error);
    next(error);
  }
};

