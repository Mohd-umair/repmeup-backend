const Interaction = require('../models/Interaction');
const Organization = require('../models/Organization');
const aiService = require('../services/aiService');
const cacheService = require('../services/cacheService');
const escalationService = require('../services/escalationService');
const logger = require('../config/logger');
const logEvents = require('../utils/logEvents');
const { isThreadStyleDm } = require('../utils/interactionThreadDm');
const { emitToOrg } = require('../utils/socketEmitter');

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
      const result = await processSingleInteraction(interactionId, organization, job.data);
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
async function processSingleInteraction(interactionId, organization, jobData = {}) {
  try {
    const interaction = await Interaction.findById(interactionId)
      .populate('platformConnection');

    if (!interaction) {
      return { skipped: true, reason: 'Interaction not found' };
    }

    const threadDm = isThreadStyleDm(interaction);

    if (!threadDm && interaction.replies && interaction.replies.length > 0) {
      return { skipped: true, reason: 'Already has replies' };
    }

    // Thread DMs: a new inbound message sets status to unread via webhook; if we still see
    // replied/resolved, a human (or prior send) already handled this turn — skip delayed job.
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

    // Evaluate escalation rules now so we know whether to route to human,
    // but DO NOT skip the reply — customers should always receive an acknowledgment.
    const escalationCheck = await escalationService.shouldEscalate(
      interaction,
      organization
    );

    // Reload interaction so sentiment / intent from processAI match org filters
    const interactionForReply = await Interaction.findById(interactionId)
      .populate('platformConnection');
    if (!interactionForReply) {
      // Nothing to reply to — still escalate if needed
      if (escalationCheck.shouldEscalate) {
        await escalationService.escalateInteraction(
          interaction, organization,
          escalationCheck.reasons, escalationCheck.type, escalationCheck.metadata
        );
      }
      return { skipped: true, reason: 'Interaction not found' };
    }
    const threadDmReply = isThreadStyleDm(interactionForReply);

    const expectedLastMid = jobData.expectedLastMid;
    if (
      threadDmReply &&
      expectedLastMid &&
      interactionForReply.metadata?.lastMid != null &&
      String(interactionForReply.metadata.lastMid) !== String(expectedLastMid)
    ) {
      logger.info('[Auto-reply] Skipped — stale job (newer inbound message in thread)', {
        interactionId: interactionForReply._id?.toString(),
        expectedLastMid: String(expectedLastMid),
        currentLastMid: String(interactionForReply.metadata.lastMid)
      });
      return { skipped: true, reason: 'Stale auto-reply job (newer inbound message)' };
    }

    if (!threadDmReply && interactionForReply.replies && interactionForReply.replies.length > 0) {
      if (escalationCheck.shouldEscalate) {
        await escalationService.escalateInteraction(
          interactionForReply, organization,
          escalationCheck.reasons, escalationCheck.type, escalationCheck.metadata
        );
      }
      return { skipped: true, reason: 'Already has replies' };
    }
    if (interactionForReply.status === 'replied' || interactionForReply.status === 'resolved') {
      if (escalationCheck.shouldEscalate) {
        await escalationService.escalateInteraction(
          interactionForReply, organization,
          escalationCheck.reasons, escalationCheck.type, escalationCheck.metadata
        );
      }
      return { skipped: true, reason: `Status is ${interactionForReply.status}` };
    }

    // Skip if a human agent read the interaction during the delay window.
    // isRead is reset to false on every new inbound webhook message, so this
    // only fires when an agent opened this specific message before the job ran.
    if (interactionForReply.isRead && interactionForReply.readBy) {
      logger.info('[Auto-reply] Skipped — human agent read the interaction during the delay window', {
        interactionId: interactionForReply._id?.toString(),
        readBy: interactionForReply.readBy?.toString(),
        readAt: interactionForReply.readAt
      });
      // Still escalate if rules triggered, but do not generate an AI reply
      if (escalationCheck.shouldEscalate) {
        await escalationService.escalateInteraction(
          interactionForReply, organization,
          escalationCheck.reasons, escalationCheck.type, escalationCheck.metadata
        );
      }
      return { skipped: true, reason: 'Human agent is handling this interaction' };
    }

    // ─── LAYER 3: Conversation loop detection ──────────────────────────────────
    // For thread-style DMs where the AI has already replied at least once:
    // increment sameTopicReplies so the escalation scorer can detect unresolved loops.
    if (threadDmReply && (interactionForReply.autoReplyCount || 0) >= 1) {
      try {
        await Interaction.updateOne(
          { _id: interactionForReply._id },
          { $inc: { 'escalationMetadata.sameTopicReplies': 1 } }
        );
        // Keep in-memory copy in sync for the escalation check below
        if (!interactionForReply.escalationMetadata) {
          interactionForReply.escalationMetadata = {};
        }
        interactionForReply.escalationMetadata.sameTopicReplies =
          (interactionForReply.escalationMetadata.sameTopicReplies || 0) + 1;

        logger.info('[Auto-reply] Layer 3: sameTopicReplies incremented', {
          interactionId: interactionForReply._id?.toString(),
          sameTopicReplies: interactionForReply.escalationMetadata.sameTopicReplies
        });
      } catch (loopErr) {
        logger.warn('[Auto-reply] Layer 3: failed to increment sameTopicReplies', { error: loopErr.message });
      }
    }

    // ─── LAYER 1: Intent-based hard routing ────────────────────────────────────
    // Certain intent buckets (billing disputes, account security, legal, etc.) must
    // always skip AI and go directly to a human agent — zero false positives.
    if (organization.escalationSettings?.enabled) {
      const intentRouting = escalationService.checkIntentRouting(interactionForReply, organization);
      if (intentRouting.shouldRoute) {
        logger.info('[Auto-reply] Layer 1: intent routing to human — skipping AI generation', {
          interactionId: interactionForReply._id?.toString(),
          reason: intentRouting.reason,
          bucket: interactionForReply.intentBucket?.toString()
        });

        // Send handoff acknowledgment to customer first
        const handoffMsg =
          organization.escalationSettings?.handoffMessageTemplate ||
          "Thank you for reaching out. I'm connecting you with a team member who can better assist you with this.";
        let handoffSent = false;
        if (organization.autoReplySettings.autoSend && !organization.autoReplySettings.requireApproval) {
          handoffSent = await sendReplyToPlatform(interactionForReply, handoffMsg, organization);
        }

        // Then escalate to human
        await escalationService.escalateInteraction(
          interactionForReply, organization,
          [intentRouting.reason], 'intent_routing', { intentBucket: interactionForReply.intentBucket?.toString() }
        );

        logger.info('[Auto-reply] Layer 1: escalated after intent routing', {
          interactionId: interactionForReply._id?.toString(),
          handoffSent
        });
        return { sent: handoffSent, escalated: true, reason: 'intent_routing' };
      }
    }

    // Generate auto-reply
    const autoReply = await aiService.generateAutoReply(
      interactionForReply,
      organization._id,
      organization
    );

    // ─── LAYER 2: AI self-assessment — unresolvable signal ────────────────────
    // The LLM assessed that it cannot resolve this without private account/system data.
    // Prefer fallbackSettings (newer, configurable), fall back to handoffMessageTemplate.
    if (autoReply.eligible && autoReply.resolvable === false) {
      logger.info('[Auto-reply] Layer 2: AI unresolvable — routing to human', {
        interactionId: interactionForReply._id?.toString(),
        reason: autoReply.resolvableReason
      });

      const fallback = organization.autoReplySettings?.fallbackSettings;
      const handoffMsg = (fallback?.enabled && fallback.message?.trim())
        ? fallback.message.trim()
        : (organization.escalationSettings?.handoffMessageTemplate ||
           "Thank you for reaching out. I'm connecting you with a team member who can better assist you with this.");

      let handoffSent = false;
      if (organization.autoReplySettings.autoSend && !organization.autoReplySettings.requireApproval) {
        handoffSent = await sendReplyToPlatform(interactionForReply, handoffMsg, organization);
      }

      await escalationService.escalateInteraction(
        interactionForReply, organization,
        [`AI self-assessed as unresolvable: ${autoReply.resolvableReason || 'requires private data'}`],
        'ai_unresolvable',
        { resolvableReason: autoReply.resolvableReason }
      );

      // Auto-assign agent and email notification (from fallbackSettings)
      if (fallback?.enabled && fallback.assignToAgent) {
        try {
          const assignedAgent = await escalationService.assignToAgent(interactionForReply, organization);
          if (assignedAgent) {
            console.log(`👤 [Auto-reply L2] Assigned to agent: ${assignedAgent.firstName} ${assignedAgent.lastName}`);
            if (fallback.notifyByEmail) {
              await escalationService.notifyAgent(assignedAgent, interactionForReply, organization);
            }
          }
        } catch (assignErr) {
          logger.warn('[Auto-reply] Layer 2: agent assignment error (non-fatal)', { error: assignErr.message });
        }
      }

      logger.info('[Auto-reply] Layer 2: escalated after AI unresolvable assessment', {
        interactionId: interactionForReply._id?.toString(),
        handoffSent
      });
      return { sent: handoffSent, escalated: true, reason: 'ai_unresolvable' };
    }

    if (!autoReply.eligible) {
      // Reply not eligible (settings gate) — log clearly so the user can diagnose in console
      logger.info('[Auto-reply] Not eligible — check org auto-reply settings', {
        interactionId: interactionForReply._id?.toString(),
        platform: interactionForReply.platform,
        type: interactionForReply.type,
        sentiment: interactionForReply.sentiment,
        intent: interactionForReply.intent,
        reason: autoReply.reason,
        hint: 'Check: sentimentFilter, enabledPlatforms, enabledTypes in Auto-Reply settings'
      });
      console.warn(`⚠️  [Auto-reply] Not eligible for interaction ${interactionForReply._id}: ${autoReply.reason}`);

      // Escalate to human if escalation rules triggered
      if (escalationCheck.shouldEscalate) {
        await escalationService.escalateInteraction(
          interactionForReply, organization,
          escalationCheck.reasons, escalationCheck.type, escalationCheck.metadata
        );
      }

      // ─── FALLBACK: Send message + assign agent + notify when AI cannot respond ──
      const fallback = organization.autoReplySettings?.fallbackSettings;
      if (fallback?.enabled) {
        try {
          const fallbackMsg = (fallback.message && fallback.message.trim())
            ? fallback.message.trim()
            : 'Our Agent will contact you within 24 hours.';

          // Send the fallback message to the customer on the platform
          if (organization.autoReplySettings.autoSend && !organization.autoReplySettings.requireApproval) {
            await sendReplyToPlatform(interactionForReply, fallbackMsg, organization);
            logger.info('[Auto-reply] Fallback message sent to platform', {
              interactionId: interactionForReply._id?.toString(),
              message: fallbackMsg
            });
          }

          // Mark interaction as requiring human response
          await interactionForReply.escalateToHuman(
            [`AI not eligible: ${autoReply.reason}`], 'ai_fallback', { reason: autoReply.reason }
          );

          // Assign to an available agent and email them (independent of escalationSettings)
          if (fallback.assignToAgent) {
            const assignedAgent = await escalationService.assignToAgent(interactionForReply, organization);
            if (assignedAgent) {
              console.log(`👤 [Auto-reply Fallback] Assigned to agent: ${assignedAgent.firstName} ${assignedAgent.lastName}`);
              if (fallback.notifyByEmail) {
                await escalationService.notifyAgent(assignedAgent, interactionForReply, organization);
                logger.info('[Auto-reply] Fallback: agent notified by email', {
                  interactionId: interactionForReply._id?.toString(),
                  agent: assignedAgent._id?.toString()
                });
              }
            }
          }

          return { sent: true, escalated: true, reason: 'ai_fallback' };
        } catch (fallbackErr) {
          logger.warn('[Auto-reply] Fallback handler error (non-fatal)', {
            interactionId: interactionForReply._id?.toString(),
            error: fallbackErr.message
          });
        }
      }

      return { skipped: true, reason: autoReply.reason };
    }

    logEvents.autoReply.generated({
      interactionId: interactionForReply._id,
      confidence: autoReply.response.confidence,
      sentiment: interactionForReply.sentiment,
      length: autoReply.response.content.length
    });
    logger.info('[Auto-reply] Generated reply details', {
      interactionId: interactionForReply._id?.toString(),
      platform: interactionForReply.platform,
      type: interactionForReply.type,
      usedKnowledgeBase: !!autoReply.response.usedKnowledgeBase,
      knowledgeBaseCount: autoReply.response.knowledgeBaseCount || 0,
      knowledgeBaseFallback: !!autoReply.response.knowledgeBaseFallback,
      confidence: autoReply.response.confidence
    });

    // ─── LAYER 2.5: No relevant KB info — fallback instead of generic AI answer ──
    // Trigger when fallback is enabled AND either:
    //   a) no KB was used at all, OR
    //   b) only generic fallback KB entries were injected (no direct text/keyword matches)
    // This prevents the AI from sending generic, unhelpful responses when it has
    // no specific knowledge to draw from for the customer's actual query.
    const fallbackCfg = organization.autoReplySettings?.fallbackSettings;
    const hasNoRelevantKB = !autoReply.response.usedKnowledgeBase || autoReply.response.knowledgeBaseFallback;
    if (fallbackCfg?.enabled && hasNoRelevantKB) {
      logger.info('[Auto-reply] Layer 2.5: AI has no relevant KB info — sending fallback instead of generic reply', {
        interactionId: interactionForReply._id?.toString(),
        usedKnowledgeBase: !!autoReply.response.usedKnowledgeBase,
        knowledgeBaseCount: autoReply.response.knowledgeBaseCount || 0,
        knowledgeBaseFallback: !!autoReply.response.knowledgeBaseFallback
      });

      const fallbackMsg = (fallbackCfg.message && fallbackCfg.message.trim())
        ? fallbackCfg.message.trim()
        : 'Our Agent will contact you within 24 hours.';

      let fallbackSent = false;
      if (organization.autoReplySettings.autoSend && !organization.autoReplySettings.requireApproval) {
        fallbackSent = await sendReplyToPlatform(interactionForReply, fallbackMsg, organization);
      }

      try {
        await interactionForReply.escalateToHuman(
          ['AI reply had no knowledge base context — fallback triggered'], 'ai_no_kb_fallback',
          { confidence: autoReply.response.confidence }
        );
      } catch (_escErr) {
        logger.warn('[Auto-reply] Layer 2.5: escalateToHuman error (non-fatal)', { error: _escErr.message });
      }

      if (fallbackCfg.assignToAgent) {
        try {
          const assignedAgent = await escalationService.assignToAgent(interactionForReply, organization);
          if (assignedAgent) {
            console.log(`👤 [Auto-reply L2.5] Assigned to agent: ${assignedAgent.firstName} ${assignedAgent.lastName}`);
            if (fallbackCfg.notifyByEmail) {
              await escalationService.notifyAgent(assignedAgent, interactionForReply, organization);
            }
          }
        } catch (assignErr) {
          logger.warn('[Auto-reply] Layer 2.5: agent assignment error (non-fatal)', { error: assignErr.message });
        }
      }

      return { sent: fallbackSent, escalated: true, reason: 'ai_no_kb_fallback' };
    }

    // Merge confidence-based escalation check with the earlier one
    const postReplyEscalationCheck = await escalationService.shouldEscalate(
      interactionForReply,
      organization,
      autoReply.response
    );

    const shouldEscalate = escalationCheck.shouldEscalate || postReplyEscalationCheck.shouldEscalate;
    const escalationReasons = [
      ...(escalationCheck.reasons || []),
      ...(postReplyEscalationCheck?.reasons || [])
    ];
    const escalationType = escalationCheck.shouldEscalate
      ? escalationCheck.type
      : 'ai_confidence';
    const escalationMetadata = {
      ...(escalationCheck.metadata || {}),
      ...(postReplyEscalationCheck?.metadata || {})
    };

    // Send the reply FIRST so the customer always gets an acknowledgment,
    // even when the conversation is being escalated to a human agent.
    let replySent = false;
    if (organization.autoReplySettings.autoSend && !organization.autoReplySettings.requireApproval) {
      const sent = await sendReplyToPlatform(interactionForReply, autoReply.response.content, organization);
      if (sent) {
        logEvents.autoReply.sent({
          interactionId: interactionForReply._id,
          platform: interactionForReply.platform
        });
        replySent = true;
      }
    }

    // THEN escalate to human if rules triggered (routing happens after the reply)
    if (shouldEscalate) {
      await escalationService.escalateInteraction(
        interactionForReply,
        organization,
        escalationReasons,
        escalationType,
        escalationMetadata
      );
      logger.info('[Auto-reply] Escalated after reply', {
        interactionId: interactionForReply._id?.toString(),
        replySent,
        escalationType,
        reasons: escalationReasons
      });
      return { sent: replySent, escalated: true };
    }

    return replySent ? { sent: true } : { processed: true };

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
      const batchThreadDm = isThreadStyleDm(interaction);

      if (!batchThreadDm && interaction.replies && interaction.replies.length > 0) {
        results.skipped++;
        results.details.push({ id: interaction._id, reason: 'Already has replies' });
        continue;
      }

      if (!batchThreadDm && (interaction.status === 'replied' || interaction.status === 'resolved')) {
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
      const freshThreadDm = isThreadStyleDm(interactionFresh);
      if (!freshThreadDm && interactionFresh.replies && interactionFresh.replies.length > 0) {
        results.skipped++;
        results.details.push({ id: interaction._id, reason: 'Already has replies' });
        continue;
      }
      if (!freshThreadDm && (interactionFresh.status === 'replied' || interactionFresh.status === 'resolved')) {
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
      status: { $in: ['connected', 'available'] },
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
      status: { $in: ['connected', 'available'] },
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
const ALLOWED_CONNECTION_STATUS = ['connected', 'available'];

async function sendReplyToPlatform(interaction, content, organization) {
  try {
    const connection = await getConnectionForReply(interaction);
    if (!connection || !ALLOWED_CONNECTION_STATUS.includes(connection.status) || !connection.isActive) {
      logger.warn('[Auto-reply] No usable platform connection to send', {
        platform: interaction.platform,
        type: interaction.type,
        interactionId: interaction._id?.toString(),
        hasConnection: !!connection,
        status: connection?.status,
        isActive: connection?.isActive
      });
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
        const pageId =
          connection.platformPageId ||
          connection.platformData?.pageId ||
          connection.metadata?.facebookPageId;
        const recipientId = interaction.author?.platformId;
        if (!pageId || !recipientId) {
          logger.warn('[Auto-reply] Instagram DM missing pageId or recipientId', {
            interactionId: interaction._id?.toString(),
            hasPageId: !!pageId,
            hasRecipientId: !!recipientId
          });
        } else {
          try {
            result = await instagramService.sendMessage(
              recipientId,
              content,
              connection.accessToken,
              pageId,
              true
            );
          } catch (sendErr) {
            logger.error('[Auto-reply] Instagram DM sendMessage failed', {
              interactionId: interaction._id?.toString(),
              error: sendErr.message,
              platformError: sendErr.platformError
            });
            result = null;
          }
        }
      }
      if (!result && interaction.type !== 'dm') {
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
      // Find a user to attribute the auto-reply to.
      // Broaden the search to any org member so a missing admin/manager never
      // blocks the status update. Fall back to null — sentBy is not required.
      const User = require('../models/User');
      const user = await User.findOne({
        organization: organization._id,
        role: { $in: ['admin', 'manager', 'agent', 'super_admin'] }
      }).select('_id').lean();

      await interaction.addReply(content, user?._id ?? null, platformResponseId, true);
      interaction.autoReplied = true;
      interaction.respondedAt = new Date();
      await interaction.save();

      // Clear the interaction cache NOW so the next poll returns fresh DB data
      // (avoids the stale-cache race where the 30s frontend poll overwrites
      //  the socket-updated 'replied' status with cached 'unread' data)
      try {
        await cacheService.delPattern(`interactions:${interaction.organization.toString()}*`);
      } catch (_cacheErr) { /* non-fatal */ }

      // Emit real-time update so the inbox list reflects 'replied' status immediately
      try {
        emitToOrg(interaction.organization.toString(), 'interaction_updated', {
          interaction: interaction.toObject ? interaction.toObject() : interaction
        });
      } catch (_emitErr) {
        // Non-fatal — don't block the reply
      }

      // Remove any pending AI processing jobs for this interaction
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

