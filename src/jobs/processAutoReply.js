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

    console.log(`\n📊 [Auto-Reply] Job completed: processed=${processedCount}, sent=${sentCount}, skipped=${skippedCount}`);
    console.log(`📊 [Auto-Reply] Organization settings:`, {
      enabled: organization.autoReplySettings.enabled,
      autoSend: organization.autoReplySettings.autoSend,
      requireApproval: organization.autoReplySettings.requireApproval,
      triggerMode: organization.autoReplySettings.triggerMode,
      enabledPlatforms: organization.autoReplySettings.enabledPlatforms,
      enabledTypes: organization.autoReplySettings.enabledTypes,
      minConfidence: organization.autoReplySettings.minConfidence,
      repliesCountToday: organization.autoReplySettings.repliesCountToday,
      maxRepliesPerDay: organization.autoReplySettings.maxRepliesPerDay
    });

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

    // Check if already replied (IMPORTANT: This prevents duplicate auto-replies)
    if (interaction.replies && interaction.replies.length > 0) {
      console.log(`⏭️  [Auto-Reply] Skipping interaction ${interaction._id} - already has ${interaction.replies.length} reply(ies)`);
      return { skipped: true, reason: 'Already has replies' };
    }

    // Check if status is already replied/resolved
    if (interaction.status === 'replied' || interaction.status === 'resolved') {
      console.log(`⏭️  [Auto-Reply] Skipping interaction ${interaction._id} - status is ${interaction.status}`);
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
            console.log(`⏭️  [Auto-Reply] Skipping reply to interaction ${interaction._id} - parent already has system reply`);
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
              console.log(`⏭️  [Auto-Reply] Skipping reply to interaction ${interaction._id} - parent is from our own channel`);
              return { skipped: true, reason: 'Parent comment is from our own account' };
            }
          }
          // For Instagram: Check if parent author matches the business account
          if (interaction.platform === 'instagram' && platformConnection.platformData?.businessAccountId) {
            if (parentInteraction.author.platformId === platformConnection.platformData.businessAccountId) {
              console.log(`⏭️  [Auto-Reply] Skipping reply to interaction ${interaction._id} - parent is from our own account`);
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
          console.log(`⏭️  [Auto-Reply] Skipping reply to interaction ${interaction._id} - this is from our own channel`);
          return { skipped: true, reason: 'Interaction is from our own account' };
        }
      }
      // For Instagram: Check if author matches the business account
      if (interaction.platform === 'instagram' && platformConnection.platformData?.businessAccountId) {
        if (interaction.author.platformId === platformConnection.platformData.businessAccountId) {
          console.log(`⏭️  [Auto-Reply] Skipping reply to interaction ${interaction._id} - this is from our own account`);
          return { skipped: true, reason: 'Interaction is from our own account' };
        }
      }
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

    console.log(`🔍 [Auto-Reply] Searching for interactions with query:`, JSON.stringify(query));

    const interactions = await Interaction.find(query)
      .populate('platformConnection')
      .limit(20); // Process max 20 at a time

    console.log(`🔍 [Auto-Reply] Found ${interactions.length} eligible interactions`);

    for (const interaction of interactions) {
      console.log(`\n📝 [Auto-Reply] Processing interaction ${interaction._id} (${interaction.platform}/${interaction.type})`);
      
      // IMPORTANT: Double-check if already replied (in case it was replied to between query and processing)
      if (interaction.replies && interaction.replies.length > 0) {
        console.log(`⏭️  [Auto-Reply] Skipping interaction ${interaction._id} - already has ${interaction.replies.length} reply(ies)`);
        results.skipped++;
        results.details.push({ id: interaction._id, reason: 'Already has replies' });
        continue;
      }

      // Check if status is already replied/resolved
      if (interaction.status === 'replied' || interaction.status === 'resolved') {
        console.log(`⏭️  [Auto-Reply] Skipping interaction ${interaction._id} - status is ${interaction.status}`);
        results.skipped++;
        results.details.push({ id: interaction._id, reason: `Status is ${interaction.status}` });
        continue;
      }
      
      // Check daily limit
      if (organization.autoReplySettings.repliesCountToday >= organization.autoReplySettings.maxRepliesPerDay) {
        console.log(`❌ [Auto-Reply] Daily limit reached: ${organization.autoReplySettings.repliesCountToday}/${organization.autoReplySettings.maxRepliesPerDay}`);
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
              console.log(`⏭️  [Auto-Reply] Skipping reply to interaction ${interaction._id} - parent already has system reply`);
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
                console.log(`⏭️  [Auto-Reply] Skipping reply to interaction ${interaction._id} - parent is from our own channel`);
                results.skipped++;
                results.details.push({ id: interaction._id, reason: 'Parent comment is from our own account' });
                continue;
              }
            }
            // For Instagram: Check if parent author matches the business account
            if (interaction.platform === 'instagram' && platformConnection.platformData?.businessAccountId) {
              if (parentInteraction.author.platformId === platformConnection.platformData.businessAccountId) {
                console.log(`⏭️  [Auto-Reply] Skipping reply to interaction ${interaction._id} - parent is from our own account`);
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
            console.log(`⏭️  [Auto-Reply] Skipping reply to interaction ${interaction._id} - this is from our own channel`);
            results.skipped++;
            results.details.push({ id: interaction._id, reason: 'Interaction is from our own account' });
            continue;
          }
        }
        // For Instagram: Check if author matches the business account
        if (interaction.platform === 'instagram' && platformConnection.platformData?.businessAccountId) {
          if (interaction.author.platformId === platformConnection.platformData.businessAccountId) {
            console.log(`⏭️  [Auto-Reply] Skipping reply to interaction ${interaction._id} - this is from our own account`);
            results.skipped++;
            results.details.push({ id: interaction._id, reason: 'Interaction is from our own account' });
            continue;
          }
        }
      }

      // Generate auto-reply
      console.log(`🤖 [Auto-Reply] Generating AI reply for interaction ${interaction._id}...`);
      const autoReply = await aiService.generateAutoReply(
        interaction,
        organizationId,
        organization
      );

      if (!autoReply.eligible) {
        console.log(`❌ [Auto-Reply] Not eligible: ${autoReply.reason}`);
        results.skipped++;
        results.details.push({ id: interaction._id, reason: autoReply.reason });
        continue;
      }

      console.log(`✅ [Auto-Reply] Generated reply with confidence: ${autoReply.response.confidence}`);
      results.processed++;

      // Send if autoSend is enabled
      if (organization.autoReplySettings.autoSend && !organization.autoReplySettings.requireApproval) {
        console.log(`📤 [Auto-Reply] Attempting to send reply to platform...`);
        const sent = await sendReplyToPlatform(interaction, autoReply.response.content, organization);
        if (sent) {
          console.log(`✅ [Auto-Reply] Reply sent successfully!`);
          results.sent++;
          organization.autoReplySettings.repliesCountToday++;
          results.details.push({ id: interaction._id, status: 'sent' });
        } else {
          console.log(`❌ [Auto-Reply] Failed to send reply to platform`);
          results.details.push({ id: interaction._id, status: 'failed to send' });
        }
      } else {
        console.log(`💾 [Auto-Reply] Reply generated but not sent (autoSend: ${organization.autoReplySettings.autoSend}, requireApproval: ${organization.autoReplySettings.requireApproval})`);
        results.details.push({ id: interaction._id, status: 'generated only' });
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
    } else if (interaction.platform === 'instagram') {
      const instagramService = require('../integrations/meta/instagramService');
      const result = await instagramService.replyToComment(
        interaction.platformId,
        content,
        interaction.platformConnection.accessToken
      );
      
      if (result.success && result.platformResponseId) {
        platformResponseId = result.platformResponseId;
        replyStatus = 'sent';
      }
    } else if (interaction.platform === 'facebook') {
      const facebookService = require('../integrations/meta/facebookService');
      const result = await facebookService.replyToComment(
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

