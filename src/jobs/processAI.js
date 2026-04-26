const Interaction = require('../models/Interaction');
const IntentBucket = require('../models/IntentBucket');
const User = require('../models/User');
const Organization = require('../models/Organization');
const { resolveEscalationAssignmentUsers } = require('../services/autoAssignmentPoolService');
const { runWithAiContext } = require('../services/aiRequestContext');
const aiService = require('../services/aiService');
const aiCreditService = require('../services/aiCreditService');
const emailService = require('../services/emailService');
const cacheService = require('../services/cacheService');
const logger = require('../config/logger');
const logEvents = require('../utils/logEvents');
const { isThreadStyleDm } = require('../utils/interactionThreadDm');

/**
 * Process AI analysis for an interaction
 * This job is triggered when a new interaction is created
 */
module.exports = async function processAI(job) {
  const { interactionId } = job.data;
  const jobLogger = logger.createChild({ 
    module: 'processAI', 
    jobId: job.id,
    interactionId 
  });
  
  try {
    logEvents.ai.analysisStarted({ interactionId, operation: 'full_analysis' });

    // Get interaction
    const interaction = await Interaction.findById(interactionId)
      .populate('organization');

    if (!interaction) {
      jobLogger.info('Interaction not found - skipping');
      return { skipped: true, reason: 'Interaction not found' };
    }

    const threadDm = isThreadStyleDm(interaction);

    if (!threadDm && interaction.replies && interaction.replies.length > 0) {
      jobLogger.debug('Skipping - interaction already has replies', { replyCount: interaction.replies.length });
      return { skipped: true, reason: 'Already has replies' };
    }

    if (!threadDm && (interaction.status === 'replied' || interaction.status === 'resolved')) {
      jobLogger.debug('Skipping - interaction status', { status: interaction.status });
      return { skipped: true, reason: `Status is ${interaction.status}` };
    }

    const orgIdCtx = interaction.organization?._id || interaction.organization;

    // Credit gate — 1 credit covers the full analysis pipeline for this interaction
    const creditCheck = await aiCreditService.checkCredits(orgIdCtx, 1);
    if (!creditCheck.allowed) {
      jobLogger.warn('Skipping AI analysis — insufficient credits', { orgId: String(orgIdCtx) });
      return { skipped: true, reason: 'No AI credits' };
    }

    // Steps 1-3: Combined single AI call — sentiment + intent + topics + bucket classification
    jobLogger.debug('Running combined interaction analysis');
    const orgIdForBuckets = interaction.organization?._id || interaction.organization;
    const activeBuckets = await IntentBucket.find({ organization: orgIdForBuckets, isActive: true })
      .sort({ order: 1 })
      .lean();

    const analysis = await runWithAiContext(
      { organizationId: orgIdCtx, feature: 'processAI.analyze_interaction' },
      () => aiService.analyzeInteraction(interaction.content, activeBuckets)
    );

    interaction.sentiment = analysis.sentiment;
    interaction.sentimentScore = analysis.sentimentScore;
    interaction.sentimentConfidence = analysis.sentimentConfidence;
    interaction.intent = analysis.intent;
    interaction.topics = analysis.topics;

    if (analysis.bucketResult?.bucketId) {
      interaction.intentBucket = analysis.bucketResult.bucketId;
      interaction.bucketAssignedBy = analysis.bucketResult.method;
      jobLogger.debug('Bucket assigned', {
        bucketId: analysis.bucketResult.bucketId,
        method: analysis.bucketResult.method
      });
    }

    const populatedOrg = interaction.organization && typeof interaction.organization === 'object'
      ? interaction.organization
      : null;

    // Step 4: Determine if auto-reply eligible (pass populated org so settings are evaluated)
    interaction.autoReplyEligible = await aiService.canAutoReply(interaction, populatedOrg || {});

    // Step 5: Auto-assign to agent when auto-reply won't handle this interaction
    if (!interaction.autoReplyEligible) {
      const autoAssign = populatedOrg?.escalationSettings?.autoAssign !== false;
      if (autoAssign) {
        jobLogger.debug('Assigning to agent (auto-assign enabled)');
        await assignToAgent(interaction, 'ai_unable');
      } else {
        jobLogger.debug('Skipping assignment (auto-assign disabled, manual assign)');
      }
    } else {
      jobLogger.debug('Interaction eligible for auto-reply');
    }

    // Step 6: Check for negative spike (3+ negative comments on same post)
    if (interaction.type === 'comment' && interaction.sentiment === 'negative') {
      await checkNegativeSpike(interaction);
    }

    // Deduct 1 credit for the analysis pipeline (analyzeInteraction only)
    try {
      await aiCreditService.deductCredits(
        orgIdCtx,
        1,
        { operation: 'processAI_analysis', userId: interaction.assignedTo || orgIdCtx }
      );
    } catch (creditErr) {
      jobLogger.warn('Credit deduction failed (non-fatal)', { error: creditErr.message });
    }

    // Persist only the AI-derived fields using a targeted $set update.
    // Using interaction.save() causes a Mongoose VersionError when processWebhook
    // concurrently writes metadata.incomingMessages between our findById and this
    // save — the document version increments and save() finds a stale __v.
    const aiUpdate = {
      sentiment:             interaction.sentiment,
      sentimentScore:        interaction.sentimentScore,
      sentimentConfidence:   interaction.sentimentConfidence,
      intent:                interaction.intent,
      topics:                interaction.topics,
      autoReplyEligible:     interaction.autoReplyEligible,
    };
    if (interaction.intentBucket)       aiUpdate.intentBucket       = interaction.intentBucket;
    if (interaction.bucketAssignedBy)   aiUpdate.bucketAssignedBy   = interaction.bucketAssignedBy;
    if (interaction.assignedTo)         aiUpdate.assignedTo         = interaction.assignedTo;
    if (interaction.assignedBy)         aiUpdate.assignedBy         = interaction.assignedBy;
    if (interaction.assignedAt)         aiUpdate.assignedAt         = interaction.assignedAt;
    if (interaction.assignmentReason)   aiUpdate.assignmentReason   = interaction.assignmentReason;
    if (interaction.assignmentHistory?.length) {
      // Append any new assignment history entries added by assignToAgent()
      await Interaction.findByIdAndUpdate(
        interactionId,
        {
          $set: aiUpdate,
          $push: { assignmentHistory: { $each: interaction.assignmentHistory } }
        },
        { new: false }
      );
    } else {
      await Interaction.findByIdAndUpdate(interactionId, { $set: aiUpdate }, { new: false });
    }

    cacheService.invalidateAnalytics(orgIdCtx).catch(() => {});

    jobLogger.info('AI processing completed', { interactionId });

    return {
      success: true,
      interactionId,
      sentiment: interaction.sentiment,
      autoReplyEligible: interaction.autoReplyEligible
    };

  } catch (error) {
    jobLogger.error('AI processing error', { 
      error: error.message,
      stack: error.stack
    });
    logEvents.ai.error({ 
      operation: 'full_analysis', 
      error, 
      context: { interactionId } 
    });
    throw error;
  }
};

/**
 * Assign interaction to an available agent
 */
async function assignToAgent(interaction, reason) {
  try {
    // Thread DMs re-run processAI on every new customer message; do not re-auto-assign if someone already owns it.
    const latestAssign = await Interaction.findById(interaction._id).select('assignedTo').lean();
    if (latestAssign?.assignedTo) {
      interaction.assignedTo = latestAssign.assignedTo;
      logger.info('Skipping auto-assign — interaction already has an assignee', {
        interactionId: interaction._id.toString(),
        assignedTo: String(latestAssign.assignedTo)
      });
      return;
    }

    const orgId = interaction.organization?._id || interaction.organization;
    const orgDoc =
      interaction.organization &&
      typeof interaction.organization === 'object' &&
      interaction.organization.escalationSettings
        ? interaction.organization
        : await Organization.findById(orgId);

    if (!orgDoc) {
      logger.warn('Organization not found for assignment', {
        organizationId: String(orgId)
      });
      return;
    }

    const poolUsers = await resolveEscalationAssignmentUsers(orgDoc);

    if (poolUsers.length === 0) {
      logger.warn('No users available for assignment', {
        organizationId: orgId.toString()
      });
      return;
    }

    const agentOnly = poolUsers.filter((u) => u.role === 'agent');

    const bucketId = interaction.intentBucket ? interaction.intentBucket.toString() : null;
    const platform = interaction.platform ? interaction.platform.toLowerCase() : null;

    const matchedAgents = agentOnly.filter((agent) => {
      const hasBuckets = Array.isArray(agent.assignedBuckets) && agent.assignedBuckets.length > 0;
      const hasPlatforms = Array.isArray(agent.assignedPlatforms) && agent.assignedPlatforms.length > 0;

      if (!hasBuckets && !hasPlatforms) return false;

      const bucketMatch = !hasBuckets || (bucketId && agent.assignedBuckets.some((b) => b.toString() === bucketId));
      const platformMatch = !hasPlatforms || (platform && agent.assignedPlatforms.includes(platform));

      return bucketMatch && platformMatch;
    });

    const pool =
      agentOnly.length > 0
        ? matchedAgents.length > 0
          ? matchedAgents
          : agentOnly
        : poolUsers;

    const agentWorkload = await Promise.all(
      pool.map(async (agent) => {
        const count = await Interaction.countDocuments({
          assignedTo: agent._id,
          status: { $in: ['assigned', 'unread'] }
        });
        return { agent, count };
      })
    );

    agentWorkload.sort((a, b) => a.count - b.count);
    const selectedAgent = agentWorkload[0].agent;

    await interaction.assignTo(selectedAgent._id, null, reason);
    await emailService.sendAssignmentNotification(selectedAgent, interaction);

    console.log(
      `Assigned interaction ${interaction._id} to agent ${selectedAgent.email}` +
      (matchedAgents.length > 0 ? ' (bucket/platform match)' : ' (fallback)')
    );

  } catch (error) {
    logger.error('Agent assignment error', {
      error: error.message,
      interactionId: interaction._id.toString()
    });
  }
}

/**
 * Check for negative comment spike on a post
 */
async function checkNegativeSpike(interaction) {
  try {
    if (!interaction.metadata?.postId) return;

    // Count negative comments on this post in last 24 hours
    const negativeCount = await Interaction.countDocuments({
      organization: interaction.organization,
      'metadata.postId': interaction.metadata.postId,
      sentiment: 'negative',
      createdAt: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) }
    });

    logger.debug('Negative comment count check', { postId: interaction.metadata.postId, negativeCount });

    if (negativeCount >= 3) {
      logger.warn('Negative spike detected', { 
        postId: interaction.metadata.postId, 
        negativeCount 
      });

      // Find manager or admin to alert
      const manager = await User.findOne({
        organization: interaction.organization,
        role: { $in: ['manager', 'admin'] },
        isActive: true
      });

      if (manager) {
        // Send alert email
        await emailService.sendNegativeSpikeAlert(
          manager,
          interaction.metadata.postId,
          negativeCount
        );
      }

      // Mark interaction as high priority
      interaction.priority = 'urgent';
      interaction.urgency = 'urgent';
    }
  } catch (error) {
    logger.error('Negative spike check error', { 
      error: error.message,
      interactionId: interaction._id.toString()
    });
  }
}

