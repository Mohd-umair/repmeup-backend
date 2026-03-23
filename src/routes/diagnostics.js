const express = require('express');
const router = express.Router();
const { protect } = require('../middlewares/auth');
const Organization = require('../models/Organization');
const Interaction = require('../models/Interaction');
const PlatformConnection = require('../models/PlatformConnection');
const KnowledgeBase = require('../models/KnowledgeBase');
const aiService = require('../services/aiService');
const autoReplyScheduler = require('../services/autoReplyScheduler');

/**
 * @desc    Check auto-reply system status
 * @route   GET /api/diagnostics/auto-reply
 * @access  Private
 */
router.get('/auto-reply', protect, async (req, res) => {
  try {
    const organizationId = req.user.organization._id;
    const organization = await Organization.findById(organizationId);

    if (!organization) {
      return res.status(404).json({ success: false, error: 'Organization not found' });
    }

    const diagnostics = {
      timestamp: new Date().toISOString(),
      organizationId,
      
      // Auto-reply settings
      settings: {
        enabled: organization.autoReplySettings.enabled,
        triggerMode: organization.autoReplySettings.triggerMode,
        scheduleEnabled: organization.autoReplySettings.scheduleEnabled,
        scheduleInterval: organization.autoReplySettings.scheduleInterval,
        webhookImmediate: organization.autoReplySettings.webhookImmediate,
        webhookDelay: organization.autoReplySettings.webhookDelay,
        autoSend: organization.autoReplySettings.autoSend,
        requireApproval: organization.autoReplySettings.requireApproval,
        enabledPlatforms: organization.autoReplySettings.enabledPlatforms,
        enabledTypes: organization.autoReplySettings.enabledTypes,
        replyToNegative: organization.autoReplySettings.replyToNegative,
        replyToComplaints: organization.autoReplySettings.replyToComplaints,
        minConfidence: organization.autoReplySettings.minConfidence,
        repliesCountToday: organization.autoReplySettings.repliesCountToday,
        maxRepliesPerDay: organization.autoReplySettings.maxRepliesPerDay,
        lastScheduledRun: organization.autoReplySettings.lastScheduledRun
      },

      // Platform connections
      platforms: {},

      // Interactions
      interactions: {
        total: 0,
        unread: 0,
        withoutReplies: 0,
        byPlatform: {},
        eligibleForAutoReply: 0,
        samples: []
      },

      // Knowledge base
      knowledgeBase: {
        total: 0,
        byType: {}
      },

      // AI service
      aiService: {
        provider: aiService.provider,
        model: aiService.openaiModel,
        hasApiKey: !!(aiService.openaiApiKey && aiService.openaiApiKey.trim())
      },

      // Scheduled jobs
      scheduledJobs: [],

      // Issues
      issues: [],
      recommendations: []
    };

    // Check platform connections
    const connections = await PlatformConnection.find({
      organization: organizationId,
      status: 'connected'
    });

    for (const conn of connections) {
      diagnostics.platforms[conn.platform] = {
        connected: true,
        platformUserId: conn.platformUserId,
        platformUsername: conn.platformUsername,
        scopes: conn.scopes
      };
    }

    // Check interactions
    const totalInteractions = await Interaction.countDocuments({ organization: organizationId });
    const unreadInteractions = await Interaction.countDocuments({ 
      organization: organizationId, 
      status: 'unread' 
    });
    const interactionsWithoutReplies = await Interaction.countDocuments({
      organization: organizationId,
      $or: [
        { replies: { $size: 0 } },
        { replies: { $exists: false } }
      ]
    });

    diagnostics.interactions.total = totalInteractions;
    diagnostics.interactions.unread = unreadInteractions;
    diagnostics.interactions.withoutReplies = interactionsWithoutReplies;

    // Count by platform
    const interactionsByPlatform = await Interaction.aggregate([
      { $match: { organization: organizationId } },
      { $group: { _id: '$platform', count: { $sum: 1 } } }
    ]);
    for (const item of interactionsByPlatform) {
      diagnostics.interactions.byPlatform[item._id] = item.count;
    }

    // Find eligible interactions
    const eligibleQuery = {
      organization: organizationId,
      status: 'unread',
      $or: [
        { replies: { $size: 0 } },
        { replies: { $exists: false } }
      ]
    };

    const eligibleInteractions = await Interaction.find(eligibleQuery)
      .limit(5)
      .sort({ createdAt: -1 });

    diagnostics.interactions.eligibleForAutoReply = await Interaction.countDocuments(eligibleQuery);

    for (const interaction of eligibleInteractions) {
      const canReply = aiService.canAutoReply(interaction, organization);
      diagnostics.interactions.samples.push({
        _id: interaction._id,
        platform: interaction.platform,
        type: interaction.type,
        status: interaction.status,
        sentiment: interaction.sentiment,
        intent: interaction.intent,
        hasReplies: interaction.replies && interaction.replies.length > 0,
        canAutoReply: canReply,
        reason: !canReply ? getIneligibilityReason(interaction, organization) : null,
        content: interaction.content?.substring(0, 100),
        createdAt: interaction.createdAt
      });
    }

    // Check knowledge base
    const totalKB = await KnowledgeBase.countDocuments({ organization: organizationId });
    const kbByType = await KnowledgeBase.aggregate([
      { $match: { organization: organizationId } },
      { $group: { _id: '$type', count: { $sum: 1 } } }
    ]);

    diagnostics.knowledgeBase.total = totalKB;
    for (const item of kbByType) {
      diagnostics.knowledgeBase.byType[item._id] = item.count;
    }

    // Get scheduled jobs
    const scheduledJobs = await autoReplyScheduler.getScheduledJobsStatus();
    diagnostics.scheduledJobs = scheduledJobs;

    // Identify issues
    if (!organization.autoReplySettings.enabled) {
      diagnostics.issues.push('Auto-reply is disabled');
    }

    if (organization.autoReplySettings.enabledPlatforms.length === 0) {
      diagnostics.issues.push('No platforms enabled for auto-reply');
    }

    if (organization.autoReplySettings.enabledTypes.length === 0) {
      diagnostics.issues.push('No interaction types enabled for auto-reply');
    }

    if (totalKB === 0) {
      diagnostics.issues.push('No knowledge base entries found');
      diagnostics.recommendations.push('Add knowledge base entries to improve AI responses');
    }

    if (connections.length === 0) {
      diagnostics.issues.push('No platform connections found');
      diagnostics.recommendations.push('Connect at least one social media platform');
    }

    if (organization.autoReplySettings.minConfidence >= 0.9) {
      diagnostics.issues.push(`minConfidence is very high (${organization.autoReplySettings.minConfidence})`);
      diagnostics.recommendations.push('Consider lowering minConfidence to 0.75 for more replies');
    }

    if (organization.autoReplySettings.triggerMode === 'scheduled' && !organization.autoReplySettings.scheduleEnabled) {
      diagnostics.issues.push('triggerMode is "scheduled" but scheduleEnabled is false');
    }

    if (organization.autoReplySettings.triggerMode === 'webhook' && !organization.autoReplySettings.webhookImmediate) {
      diagnostics.issues.push('triggerMode is "webhook" but webhookImmediate is false');
    }

    if (aiService.provider === 'openai' && !aiService.openaiApiKey) {
      diagnostics.issues.push('OpenAI provider selected but no API key found');
    }

    if (organization.autoReplySettings.repliesCountToday >= organization.autoReplySettings.maxRepliesPerDay) {
      diagnostics.issues.push('Daily reply limit reached');
    }

    // Instagram specific checks
    if (organization.autoReplySettings.enabledPlatforms.includes('instagram')) {
      const instagramConnection = connections.find(c => c.platform === 'instagram');
      if (!instagramConnection) {
        diagnostics.issues.push('Instagram enabled but not connected');
        diagnostics.recommendations.push('Connect Instagram account in Settings');
      }

      const instagramInteractions = await Interaction.countDocuments({
        organization: organizationId,
        platform: 'instagram'
      });

      if (instagramInteractions === 0) {
        diagnostics.recommendations.push('No Instagram interactions found - test by posting a comment');
      }
    }

    res.status(200).json({
      success: true,
      data: diagnostics
    });

  } catch (error) {
    console.error('Diagnostics error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * Get reason why interaction is not eligible for auto-reply
 */
function getIneligibilityReason(interaction, organization) {
  const settings = organization.autoReplySettings || {};

  if (interaction.status === 'replied' || interaction.status === 'resolved') {
    return 'Already replied or resolved';
  }

  if (interaction.replies && interaction.replies.length > 0) {
    return 'Has existing replies';
  }

  if (!settings.enabled) {
    return 'Auto-reply disabled';
  }

  if (settings.enabledPlatforms && settings.enabledPlatforms.length > 0) {
    if (!settings.enabledPlatforms.includes(interaction.platform)) {
      return `Platform ${interaction.platform} not enabled`;
    }
  }

  if (interaction.sentiment === 'negative' && !settings.replyToNegative) {
    return 'Negative sentiment and replyToNegative is false';
  }

  if (interaction.intent === 'complaint' && !settings.replyToComplaints) {
    return 'Complaint intent and replyToComplaints is false';
  }

  if (settings.enabledTypes && settings.enabledTypes.length > 0) {
    if (!settings.enabledTypes.includes(interaction.type)) {
      return `Type ${interaction.type} not enabled`;
    }
  }

  return 'Unknown reason';
}

module.exports = router;

