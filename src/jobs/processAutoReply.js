const Interaction = require('../models/Interaction');
const Organization = require('../models/Organization');
const aiService = require('../services/aiService');
const cacheService = require('../services/cacheService');
const escalationService = require('../services/escalationService');
const logger = require('../config/logger');
const logEvents = require('../utils/logEvents');

/**
 * Process auto-reply job
 * This job handles generating and optionally sending auto-replies
 */
module.exports = async function processAutoReply(job) {
  const { type, organizationId, interactionId } = job.data;
  const jobLogger = logger.createChild({ 
    module: 'processAutoReply', 
    jobId: job.id,
    orgId: organizationId,
    type
  });
  
  try {
    // Get organization settings
    const organization = await Organization.findById(organizationId);
    
    if (!organization || !organization.autoReplySettings.enabled) {
      jobLogger.info('Auto-reply disabled for organization');
      return { success: false, reason: 'Auto-reply disabled' };
    }

    // Check daily limit
    const today = new Date().toDateString();
    const lastReset = organization.autoReplySettings.lastReplyResetDate 
      ? new Date(organization.autoReplySettings.lastReplyResetDate).toDateString()
      : null;

    if (lastReset !== today) {
      organization.autoReplySettings.repliesCountToday = 0;
      organization.autoReplySettings.lastReplyResetDate = new Date();
    }

    if (organization.autoReplySettings.repliesCountToday >= organization.autoReplySettings.maxRepliesPerDay) {
      jobLogger.info('Daily auto-reply limit reached', { 
        limit: organization.autoReplySettings.maxRepliesPerDay 
      });
      return { success: false, reason: 'Daily limit reached' };
    }

    let processedCount = 0;
    let sentCount = 0;
    let skippedCount = 0;

    if (type === 'single' && interactionId) {
      // Process single interaction (webhook-triggered)
      const result = await processSingleInteraction(interactionId, organization);
      if (result.sent) sentCount++;
      else if (result.skipped) skippedCount++;
      else processedCount++;
    } else if (type === 'scheduled') {
      // Process batch of eligible interactions (scheduled)
      const result = await processBatchInteractions(organizationId, organization);
      processedCount = result.processed;
      sentCount = result.sent;
      skippedCount = result.skipped;
    }

    // Update organization
    organization.autoReplySettings.repliesCountToday += sentCount;
    if (type === 'scheduled') {
      organization.autoReplySettings.lastScheduledRun = new Date();
    }
    await organization.save();

    // Clear cache
    await cacheService.delPattern(`interactions:${organizationId}*`);

    // Only log at info level if something was sent or processed
    // Use debug level for skipped-only jobs to reduce log spam
    if (sentCount > 0 || processedCount > 0) {
      jobLogger.info('Auto-reply job completed', {
        sent: sentCount,
        processed: processedCount,
        skipped: skippedCount,
        todayTotal: organization.autoReplySettings.repliesCountToday,
        dailyLimit: organization.autoReplySettings.maxRepliesPerDay
      });
    } else {
      jobLogger.debug('Auto-reply job completed (all skipped)', {
        type,
        skipped: skippedCount
      });
    }

    return {
      success: true,
      processed: processedCount,
      sent: sentCount,
      skipped: skippedCount
    };

  } catch (error) {
    jobLogger.error('Auto-reply job error', { 
      error: error.message,
      stack: error.stack
    });
    throw error;
  }
};

/**
 * Process a single interaction (webhook-triggered)
 */
async function processSingleInteraction(interactionId, organization) {
  try {
    const interaction = await Interaction.findById(interactionId)
      .populate('platformConnection');

    if (!interaction) {
      return { skipped: true, reason: 'Interaction not found' };
    }

    // Check if already replied (IMPORTANT: This prevents duplicate auto-replies)
    if (interaction.replies && interaction.replies.length > 0) {
      return { skipped: true, reason: 'Already has replies' };
    }

    // Check if status is already replied/resolved
    if (interaction.status === 'replied' || interaction.status === 'resolved') {
      return { skipped: true, reason: `Status is ${interaction.status}` };
    }

    // IMPORTANT: Don't reply to replies that are replies to our own replies
    // Check 1: If this interaction has a parentId, check if the parent has a system reply
    if (interaction.parentId) {
      // Find the parent interaction
      // Note: parentId is a platform ID (e.g., YouTube comment ID), not a MongoDB ObjectId
      // So we only search by platformId, not _id
      const parentInteraction = await Interaction.findOne({
        platformId: interaction.parentId,
        organization: organization._id
      });

      if (parentInteraction) {
        // Check if parent has a system-generated reply
        if (parentInteraction.replies && parentInteraction.replies.length > 0) {
          const hasSystemReply = parentInteraction.replies.some(reply => reply.wasAutoGenerated === true);
          if (hasSystemReply) {
            return { skipped: true, reason: 'Parent comment already has system reply' };
          }
        }

        // Check if the parent's author is the same as the platform connection's user
        // This would indicate the parent is a reply from the system itself
        if (interaction.platformConnection && parentInteraction.author) {
          const platformConnection = interaction.platformConnection;
          // For YouTube: Check if parent author matches the channel
          if (interaction.platform === 'youtube' && platformConnection.platformData?.channelId) {
            if (parentInteraction.author.platformId === platformConnection.platformData.channelId) {
              return { skipped: true, reason: 'Parent comment is from our own account' };
            }
          }
          // For Instagram: Check if parent author matches the business account
          if (interaction.platform === 'instagram' && platformConnection.platformData?.businessAccountId) {
            if (parentInteraction.author.platformId === platformConnection.platformData.businessAccountId) {
              return { skipped: true, reason: 'Parent comment is from our own account' };
            }
          }
        }
      }
    }

    // Check 2: Don't reply to interactions that are from our own account
    if (interaction.platformConnection && interaction.author) {
      const platformConnection = interaction.platformConnection;
      // For YouTube: Check if author matches the channel
      if (interaction.platform === 'youtube' && platformConnection.platformData?.channelId) {
        if (interaction.author.platformId === platformConnection.platformData.channelId) {
          return { skipped: true, reason: 'Interaction is from our own account' };
        }
      }
      // For Instagram: Check if author matches the business account
      if (interaction.platform === 'instagram' && platformConnection.platformData?.businessAccountId) {
        if (interaction.author.platformId === platformConnection.platformData.businessAccountId) {
          return { skipped: true, reason: 'Interaction is from our own account' };
        }
      }
    }

    // CHECK ESCALATION RULES BEFORE GENERATING AUTO-REPLY
    const escalationCheck = await escalationService.shouldEscalate(
      interaction,
      organization
    );

    if (escalationCheck.shouldEscalate) {
      await escalationService.escalateInteraction(
        interaction,
        organization,
        escalationCheck.reasons,
        escalationCheck.type,
        escalationCheck.metadata
      );

      return { skipped: true, reason: 'Escalated to human agent' };
    }

    // Reload interaction so sentiment / intent from processAI match org filters (sentimentFilter, replyToComplaints, etc.)
    const interactionForReply = await Interaction.findById(interactionId)
      .populate('platformConnection');
    if (!interactionForReply) {
      return { skipped: true, reason: 'Interaction not found' };
    }
    if (interactionForReply.replies && interactionForReply.replies.length > 0) {
      return { skipped: true, reason: 'Already has replies' };
    }
    if (interactionForReply.status === 'replied' || interactionForReply.status === 'resolved') {
      return { skipped: true, reason: `Status is ${interactionForReply.status}` };
    }

    // Generate auto-reply
    const autoReply = await aiService.generateAutoReply(
      interactionForReply,
      organization._id,
      organization
    );
    
    if (!autoReply.eligible) {
      return { skipped: true, reason: autoReply.reason };
    }
    
    logEvents.autoReply.generated({
      interactionId: interactionForReply._id,
      confidence: autoReply.response.confidence,
      sentiment: interactionForReply.sentiment,
      length: autoReply.response.content.length
    });

    // Check escalation after generating reply (to check AI confidence)
    const postReplyEscalationCheck = await escalationService.shouldEscalate(
      interactionForReply,
      organization,
      autoReply.response // Pass AI response with confidence
    );

    if (postReplyEscalationCheck.shouldEscalate) {
      await escalationService.escalateInteraction(
        interactionForReply,
        organization,
        postReplyEscalationCheck.reasons,
        'ai_confidence',
        postReplyEscalationCheck.metadata
      );

      return { skipped: true, reason: 'Escalated due to low AI confidence' };
    }

    // Send if autoSend is enabled and no approval required
    if (organization.autoReplySettings.autoSend && !organization.autoReplySettings.requireApproval) {
      const sent = await sendReplyToPlatform(interactionForReply, autoReply.response.content, organization);
      if (sent) {
        logEvents.autoReply.sent({
          interactionId: interactionForReply._id,
          platform: interactionForReply.platform
        });
      }
      return { sent: sent };
    }

    // Otherwise just mark as generated
    return { processed: true };

  } catch (error) {
    logEvents.autoReply.failed({
      interactionId,
      error,
      phase: 'processSingleInteraction'
    });
    return { skipped: true, reason: error.message };
  }
}

/**
 * Process batch of interactions (scheduled)
 */
async function processBatchInteractions(organizationId, organization) {
  const results = {
    processed: 0,
    sent: 0,
    skipped: 0,
    details: [] // Add details for debugging
  };

  try {
    // Find eligible interactions
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
      .limit(20); // Process max 20 at a time

    logger.info('Auto-reply batch processing', { 
      interactionCount: interactions.length,
      organizationId 
    });

    for (const interaction of interactions) {
      // IMPORTANT: Double-check if already replied (in case it was replied to between query and processing)
      if (interaction.replies && interaction.replies.length > 0) {
        results.skipped++;
        results.details.push({ id: interaction._id, reason: 'Already has replies' });
        continue;
      }

      // Check if status is already replied/resolved
      if (interaction.status === 'replied' || interaction.status === 'resolved') {
        results.skipped++;
        results.details.push({ id: interaction._id, reason: `Status is ${interaction.status}` });
        continue;
      }
      
      // Check daily limit
      if (organization.autoReplySettings.repliesCountToday >= organization.autoReplySettings.maxRepliesPerDay) {
        logger.warn('Auto-reply daily limit reached', {
          current: organization.autoReplySettings.repliesCountToday,
          limit: organization.autoReplySettings.maxRepliesPerDay
        });
        results.skipped++;
        results.details.push({ id: interaction._id, reason: 'Daily limit reached' });
        continue;
      }

      // IMPORTANT: Don't reply to replies that are replies to our own replies
      // Check 1: If this interaction has a parentId, check if the parent has a system reply
      if (interaction.parentId) {
        // Find the parent interaction
        // Note: parentId is a platform ID (e.g., YouTube comment ID), not a MongoDB ObjectId
        // So we only search by platformId, not _id
        const parentInteraction = await Interaction.findOne({
          platformId: interaction.parentId,
          organization: organizationId
        });

        if (parentInteraction) {
          // Check if parent has a system-generated reply
          if (parentInteraction.replies && parentInteraction.replies.length > 0) {
            const hasSystemReply = parentInteraction.replies.some(reply => reply.wasAutoGenerated === true);
            if (hasSystemReply) {
              results.skipped++;
              results.details.push({ id: interaction._id, reason: 'Parent comment already has system reply' });
              continue;
            }
          }

          // Check if the parent's author is the same as the platform connection's user
          // This would indicate the parent is a reply from the system itself
          if (interaction.platformConnection && parentInteraction.author) {
            const platformConnection = interaction.platformConnection;
            // For YouTube: Check if parent author matches the channel
            if (interaction.platform === 'youtube' && platformConnection.platformData?.channelId) {
              if (parentInteraction.author.platformId === platformConnection.platformData.channelId) {
                results.skipped++;
                results.details.push({ id: interaction._id, reason: 'Parent comment is from our own account' });
                continue;
              }
            }
            // For Instagram: Check if parent author matches the business account
            if (interaction.platform === 'instagram' && platformConnection.platformData?.businessAccountId) {
              if (parentInteraction.author.platformId === platformConnection.platformData.businessAccountId) {
                results.skipped++;
                results.details.push({ id: interaction._id, reason: 'Parent comment is from our own account' });
                continue;
              }
            }
          }
        }
      }

      // Check 2: Don't reply to interactions that are from our own account
      if (interaction.platformConnection && interaction.author) {
        const platformConnection = interaction.platformConnection;
        // For YouTube: Check if author matches the channel
        if (interaction.platform === 'youtube' && platformConnection.platformData?.channelId) {
          if (interaction.author.platformId === platformConnection.platformData.channelId) {
            results.skipped++;
            results.details.push({ id: interaction._id, reason: 'Interaction is from our own account' });
            continue;
          }
        }
        // For Instagram: Check if author matches the business account
        if (interaction.platform === 'instagram' && platformConnection.platformData?.businessAccountId) {
          if (interaction.author.platformId === platformConnection.platformData.businessAccountId) {
            results.skipped++;
            results.details.push({ id: interaction._id, reason: 'Interaction is from our own account' });
            continue;
          }
        }
      }

      // Fresh doc so batch jobs respect sentiment / intent after processAI
      const interactionFresh = await Interaction.findById(interaction._id)
        .populate('platformConnection');
      if (!interactionFresh) {
        results.skipped++;
        results.details.push({ id: interaction._id, reason: 'Interaction not found' });
        continue;
      }
      if (interactionFresh.replies && interactionFresh.replies.length > 0) {
        results.skipped++;
        results.details.push({ id: interaction._id, reason: 'Already has replies' });
        continue;
      }
      if (interactionFresh.status === 'replied' || interactionFresh.status === 'resolved') {
        results.skipped++;
        results.details.push({ id: interaction._id, reason: `Status is ${interactionFresh.status}` });
        continue;
      }

      // Generate auto-reply
      const autoReply = await aiService.generateAutoReply(
        interactionFresh,
        organizationId,
        organization
      );

      if (!autoReply.eligible) {
        results.skipped++;
        results.details.push({ id: interaction._id, reason: autoReply.reason });
        continue;
      }

      logEvents.autoReply.generated({
        interactionId: interactionFresh._id,
        confidence: autoReply.response.confidence,
        sentiment: interactionFresh.sentiment,
        length: autoReply.response.content.length
      });
      results.processed++;

      // Send if autoSend is enabled
      if (organization.autoReplySettings.autoSend && !organization.autoReplySettings.requireApproval) {
        const sent = await sendReplyToPlatform(interactionFresh, autoReply.response.content, organization);
        if (sent) {
          logEvents.autoReply.sent({
            interactionId: interactionFresh._id,
            platform: interactionFresh.platform
          });
          results.sent++;
          organization.autoReplySettings.repliesCountToday++;
          results.details.push({ id: interaction._id, status: 'sent' });
        } else {
          results.details.push({ id: interaction._id, status: 'failed to send' });
        }
      } else {
        results.details.push({ id: interaction._id, status: 'generated only' });
      }
    }

    return results;

  } catch (error) {
    logger.error('Error processing batch interactions', { 
      error: error.message,
      organizationId 
    });
    return results;
  }
}

/**
 * Resolve the platform connection to use for sending. For Instagram DM must use the thread owner
 * to avoid "(#100) not the thread owner". For Facebook DM must use the Page that owns the thread.
 */
async function getConnectionForReply(interaction) {
  const isInstagramDm = interaction.platform === 'instagram' && interaction.type === 'dm';
  let igAccountId = interaction.metadata?.instagramAccountId;
  if (isInstagramDm && !igAccountId && interaction.platformId && interaction.platformId.startsWith('dm_')) {
    const parts = interaction.platformId.split('_');
    if (parts.length >= 3) igAccountId = parts[1];
  }
  if (isInstagramDm && igAccountId) {
    const PlatformConnection = require('../models/PlatformConnection');
    const conn = await PlatformConnection.findOne({
      organization: interaction.organization,
      platform: 'instagram',
      platformUserId: { $in: [igAccountId, String(igAccountId)].filter(Boolean) },
      status: 'connected',
      isActive: true
    }).lean();
    if (conn) return conn;
    return null;
  }

  const isFacebookDm = interaction.platform === 'facebook' && interaction.type === 'dm';
  let facebookPageId = interaction.metadata?.facebookPageId;
  if (isFacebookDm && !facebookPageId && interaction.platformId && interaction.platformId.startsWith('dm_')) {
    const parts = interaction.platformId.split('_');
    if (parts.length >= 3) facebookPageId = parts[1];
  }
  if (isFacebookDm && facebookPageId) {
    const PlatformConnection = require('../models/PlatformConnection');
    const conn = await PlatformConnection.findOne({
      organization: interaction.organization,
      platform: 'facebook',
      platformPageId: { $in: [String(facebookPageId), facebookPageId] },
      status: 'connected',
      isActive: true
    }).lean();
    if (conn) return conn;
    return null;
  }

  return interaction.platformConnection;
}

/**
 * Send reply to platform
 */
async function sendReplyToPlatform(interaction, content, organization) {
  try {
    const connection = await getConnectionForReply(interaction);
    if (!connection || connection.status !== 'connected' || !connection.isActive) {
      return false;
    }

    let platformResponseId = null;
    let replyStatus = 'failed';

    if (interaction.platform === 'youtube') {
      const youtubeService = require('../integrations/google/youtubeService');
      const result = await youtubeService.replyToComment(
        connection,
        interaction.platformId,
        content
      );
      
      if (result.success && result.commentId) {
        platformResponseId = result.commentId;
        replyStatus = 'sent';
      }
    } else if (interaction.platform === 'instagram') {
      const instagramService = require('../integrations/meta/instagramService');
      let result;
      if (interaction.type === 'dm') {
        const pageId = connection.platformPageId || connection.platformData?.pageId;
        const recipientId = interaction.author?.platformId;
        if (pageId && recipientId) {
          result = await instagramService.sendMessage(
            recipientId,
            content,
            connection.accessToken,
            pageId,
            true
          );
        }
      }
      if (!result) {
        result = await instagramService.replyToComment(
          interaction.platformId,
          content,
          connection.accessToken
        );
      }
      if (result && result.success && result.platformResponseId) {
        platformResponseId = result.platformResponseId;
        replyStatus = 'sent';
      }
    } else if (interaction.platform === 'facebook') {
      const facebookService = require('../integrations/meta/facebookService');
      let result;
      if (interaction.type === 'dm') {
        const pageId = connection.platformPageId || connection.platformData?.pageId;
        const recipientId = interaction.author?.platformId;
        if (pageId && recipientId) {
          result = await facebookService.sendMessage(
            recipientId,
            content,
            connection.accessToken,
            pageId,
            true
          );
        }
      }
      if (!result) {
        result = await facebookService.replyToComment(
          connection,
          interaction.platformId,
          content
        );
      }
      if (result && result.success && (result.platformResponseId || result.commentId)) {
        platformResponseId = result.platformResponseId || result.commentId;
        replyStatus = 'sent';
      }
    } else if (interaction.platform === 'google') {
      const googleService = require('../integrations/google/googleService');
      // TODO: Implement Google Business reply
      logger.debug('Google Business reply not yet implemented');
    }
    // Add other platforms here

    if (replyStatus === 'sent') {
      // Add reply to database
      // Find a user to attribute the reply to (preferably the organization owner)
      const User = require('../models/User');
      const user = await User.findOne({ organization: organization._id, role: { $in: ['admin', 'manager'] } });
      
      if (!user) {
        return false;
      }
      
      await interaction.addReply(content, user._id, platformResponseId, true);
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
          }
        }
      } catch (queueError) {
        // Don't fail the reply if queue cleanup fails
      }

      return true;
    }

    return false;

  } catch (error) {
    logger.error('Error sending reply to platform', { 
      error: error.message,
      platform: interaction.platform,
      interactionId: interaction._id.toString()
    });
    return false;
  }
}

