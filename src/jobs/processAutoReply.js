const Interaction = require('../models/Interaction');
const Organization = require('../models/Organization');
const aiService = require('../services/aiService');
const cacheService = require('../services/cacheService');

/**
 * Process auto-reply job
 * This job handles generating and optionally sending auto-replies
 */
module.exports = async function processAutoReply(job) {
  try {
    const { type, organizationId, interactionId } = job.data;

    console.log(`Processing auto-reply job: type=${type}, org=${organizationId}, interaction=${interactionId}`);

    // Get organization settings
    const organization = await Organization.findById(organizationId);
    
    if (!organization || !organization.autoReplySettings.enabled) {
      console.log('Auto-reply disabled for organization');
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
      console.log('Daily auto-reply limit reached');
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

    console.log(`Auto-reply job completed: processed=${processedCount}, sent=${sentCount}, skipped=${skippedCount}`);

    return {
      success: true,
      processed: processedCount,
      sent: sentCount,
      skipped: skippedCount
    };

  } catch (error) {
    console.error('Auto-reply job error:', error);
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

    // Check if already replied
    if (interaction.replies && interaction.replies.length > 0) {
      return { skipped: true, reason: 'Already has replies' };
    }

    // Generate auto-reply
    const autoReply = await aiService.generateAutoReply(
      interaction,
      organization._id,
      organization
    );

    if (!autoReply.eligible) {
      return { skipped: true, reason: autoReply.reason };
    }

    // Send if autoSend is enabled and no approval required
    if (organization.autoReplySettings.autoSend && !organization.autoReplySettings.requireApproval) {
      const sent = await sendReplyToPlatform(interaction, autoReply.response.content, organization);
      return { sent: sent };
    }

    // Otherwise just mark as generated
    return { processed: true };

  } catch (error) {
    console.error('Error processing single interaction:', error);
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
    skipped: 0
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

    for (const interaction of interactions) {
      // Check daily limit
      if (organization.autoReplySettings.repliesCountToday >= organization.autoReplySettings.maxRepliesPerDay) {
        results.skipped++;
        continue;
      }

      // Generate auto-reply
      const autoReply = await aiService.generateAutoReply(
        interaction,
        organizationId,
        organization
      );

      if (!autoReply.eligible) {
        results.skipped++;
        continue;
      }

      results.processed++;

      // Send if autoSend is enabled
      if (organization.autoReplySettings.autoSend && !organization.autoReplySettings.requireApproval) {
        const sent = await sendReplyToPlatform(interaction, autoReply.response.content, organization);
        if (sent) {
          results.sent++;
          organization.autoReplySettings.repliesCountToday++;
        }
      }
    }

    return results;

  } catch (error) {
    console.error('Error processing batch interactions:', error);
    return results;
  }
}

/**
 * Send reply to platform
 */
async function sendReplyToPlatform(interaction, content, organization) {
  try {
    if (!interaction.platformConnection || interaction.platformConnection.status !== 'connected') {
      console.log('Platform connection not available');
      return false;
    }

    let platformResponseId = null;
    let replyStatus = 'failed';

    if (interaction.platform === 'youtube') {
      const youtubeService = require('../integrations/google/youtubeService');
      const result = await youtubeService.replyToComment(
        interaction.platformConnection,
        interaction.platformId,
        content
      );
      
      if (result.success && result.commentId) {
        platformResponseId = result.commentId;
        replyStatus = 'sent';
      }
    } else if (interaction.platform === 'google') {
      const googleService = require('../integrations/google/googleService');
      // TODO: Implement Google Business reply
      console.log('Google Business reply not yet implemented');
    }
    // Add other platforms here

    if (replyStatus === 'sent') {
      // Add reply to database
      // Find a user to attribute the reply to (preferably the organization owner)
      const User = require('../models/User');
      const user = await User.findOne({ organization: organization._id, role: { $in: ['admin', 'manager'] } });
      
      if (user) {
        await interaction.addReply(content, user._id, platformResponseId, true);
        interaction.respondedAt = new Date();
        await interaction.save();
        return true;
      }
    }

    return false;

  } catch (error) {
    console.error('Error sending reply to platform:', error);
    return false;
  }
}

