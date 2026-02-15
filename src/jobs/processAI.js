const Interaction = require('../models/Interaction');
const KnowledgeBase = require('../models/KnowledgeBase');
const User = require('../models/User');
const aiService = require('../services/aiService');
const emailService = require('../services/emailService');
const logger = require('../config/logger');
const logEvents = require('../utils/logEvents');

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

    // IMPORTANT: Skip if interaction already has replies (already been replied to)
    if (interaction.replies && interaction.replies.length > 0) {
      jobLogger.debug('Skipping - interaction already has replies', { replyCount: interaction.replies.length });
      return { skipped: true, reason: 'Already has replies' };
    }

    // Skip if already replied/resolved
    if (interaction.status === 'replied' || interaction.status === 'resolved') {
      jobLogger.debug('Skipping - interaction status', { status: interaction.status });
      return { skipped: true, reason: `Status is ${interaction.status}` };
    }

    // Step 1: Analyze sentiment
    jobLogger.debug('Analyzing sentiment');
    const sentimentResult = await aiService.analyzeSentiment(interaction.content);
    
    interaction.sentiment = sentimentResult.sentiment;
    interaction.sentimentScore = sentimentResult.sentimentScore;
    interaction.sentimentConfidence = sentimentResult.sentimentConfidence;

    // Step 2: Detect intent
    jobLogger.debug('Detecting intent');
    const intent = await aiService.detectIntent(interaction.content);
    interaction.intent = intent;

    // Step 3: Extract topics
    jobLogger.debug('Extracting topics');
    const topics = await aiService.extractTopics(interaction.content);
    interaction.topics = topics;

    // Step 4: Get knowledge base for AI response
    const knowledgeBase = await KnowledgeBase.find({
      organization: interaction.organization,
      isActive: true,
      isTrainingData: true
    }).sort({ trainingWeight: -1 }).limit(10);

    // Step 5: Generate AI response suggestion
    jobLogger.debug('Generating AI response');
    const aiResponse = await aiService.generateResponse(interaction, knowledgeBase);
    
    if (aiResponse) {
      interaction.aiSuggestion = aiResponse;
    }

    // Step 6: Determine if auto-reply eligible
    interaction.autoReplyEligible = aiService.canAutoReply(interaction);

    // Step 7: Check if should auto-reply or assign to agent
    if (interaction.autoReplyEligible && aiResponse) {
      jobLogger.debug('Interaction eligible for auto-reply');
    } else {
      // Assign to agent
      jobLogger.debug('Assigning to agent');
      await assignToAgent(interaction, 'ai_unable');
    }

    // Step 8: Check for negative spike (3+ negative comments on same post)
    if (interaction.type === 'comment' && interaction.sentiment === 'negative') {
      await checkNegativeSpike(interaction);
    }

    // Save interaction
    await interaction.save();

    console.log(`AI processing completed for interaction: ${interactionId}`);

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
    // Find available agent (least busy)
    const agents = await User.find({
      organization: interaction.organization,
      role: 'agent',
      isActive: true
    });

    if (agents.length === 0) {
      logger.warn('No agents available for assignment', { 
        organizationId: interaction.organization.toString() 
      });
      return;
    }

    // Count current assignments for each agent
    const agentWorkload = await Promise.all(
      agents.map(async (agent) => {
        const count = await Interaction.countDocuments({
          assignedTo: agent._id,
          status: { $in: ['assigned', 'unread'] }
        });
        return { agent, count };
      })
    );

    // Sort by workload (ascending) and get least busy agent
    agentWorkload.sort((a, b) => a.count - b.count);
    const selectedAgent = agentWorkload[0].agent;

    // Assign
    await interaction.assignTo(selectedAgent._id, null, reason);

    // Send notification email
    await emailService.sendAssignmentNotification(selectedAgent, interaction);

    console.log(`Assigned interaction ${interaction._id} to agent ${selectedAgent.email}`);

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

