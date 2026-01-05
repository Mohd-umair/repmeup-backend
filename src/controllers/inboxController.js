const Interaction = require('../models/Interaction');
const Label = require('../models/Label');
const ResponseTemplate = require('../models/ResponseTemplate');
const cacheService = require('../services/cacheService');

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
    if (search) {
      query.$or = [
        { content: { $regex: search, $options: 'i' } },
        { 'author.name': { $regex: search, $options: 'i' } },
        { 'author.username': { $regex: search, $options: 'i' } }
      ];
    }

    // For agents, show only assigned to them or unassigned
    if (req.user.role === 'agent') {
      query.$or = [
        { assignedTo: req.user._id },
        { assignedTo: { $exists: false } }
      ];
    }

    // Calculate pagination
    const skip = (page - 1) * limit;
    const sort = { [sortBy]: sortOrder === 'desc' ? -1 : 1 };

    // Try to get from cache
    const cacheKey = cacheService.interactionsKey(req.user.organization._id, {
      platform,
      type,
      sentiment,
      status,
      page,
      limit
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

    // Cache result for 5 minutes
    await cacheService.set(cacheKey, result, 300);

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
    if (!interaction.isRead) {
      interaction.isRead = true;
      interaction.readAt = new Date();
      interaction.readBy = req.user._id;
      await interaction.save();
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

    let replyContent = content;

    // If using template
    if (useTemplate && templateId) {
      const template = await ResponseTemplate.findById(templateId);
      if (template) {
        replyContent = template.render(templateVariables || {});
        await template.incrementUsage();
      }
    }

    // Add reply
    await interaction.addReply(replyContent, req.user._id);

    // TODO: Send actual reply to platform via integration service
    // This would call instagramService.replyToComment() or similar

    // Clear cache
    await cacheService.delPattern(`interactions:${req.user.organization._id}*`);

    res.status(200).json({
      success: true,
      data: interaction,
      message: 'Reply sent successfully'
    });
  } catch (error) {
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

