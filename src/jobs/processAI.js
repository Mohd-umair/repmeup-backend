const Interaction = require('../models/Interaction');
const KnowledgeBase = require('../models/KnowledgeBase');
const User = require('../models/User');
const aiService = require('../services/aiService');
const emailService = require('../services/emailService');

/**
 * Process AI analysis for an interaction
 * This job is triggered when a new interaction is created
 */
module.exports = async function processAI(job) {
  try {
    const { interactionId } = job.data;

    console.log(`Processing AI for interaction: ${interactionId}`);

    // Get interaction
    const interaction = await Interaction.findById(interactionId)
      .populate('organization');

    if (!interaction) {
      throw new Error(`Interaction ${interactionId} not found`);
    }

    // Step 1: Analyze sentiment
    console.log('Analyzing sentiment...');
    const sentimentResult = await aiService.analyzeSentiment(interaction.content);
    
    interaction.sentiment = sentimentResult.sentiment;
    interaction.sentimentScore = sentimentResult.sentimentScore;
    interaction.sentimentConfidence = sentimentResult.sentimentConfidence;

    // Step 2: Detect intent
    console.log('Detecting intent...');
    const intent = await aiService.detectIntent(interaction.content);
    interaction.intent = intent;

    // Step 3: Extract topics
    console.log('Extracting topics...');
    const topics = await aiService.extractTopics(interaction.content);
    interaction.topics = topics;

    // Step 4: Get knowledge base for AI response
    const knowledgeBase = await KnowledgeBase.find({
      organization: interaction.organization,
      isActive: true,
      isTrainingData: true
    }).sort({ trainingWeight: -1 }).limit(10);

    // Step 5: Generate AI response suggestion
    console.log('Generating AI response...');
    const aiResponse = await aiService.generateResponse(interaction, knowledgeBase);
    
    if (aiResponse) {
      interaction.aiSuggestion = aiResponse;
    }

    // Step 6: Determine if auto-reply eligible
    interaction.autoReplyEligible = aiService.canAutoReply(interaction);

    // Step 7: Check if should auto-reply or assign to agent
    if (interaction.autoReplyEligible && aiResponse) {
      // TODO: Implement actual auto-reply logic
      // For now, just mark as eligible
      console.log('Interaction is eligible for auto-reply');
      
      // In production, you would:
      // 1. Auto-reply via platform integration
      // 2. Mark as replied
      // 3. Log the response
    } else {
      // Assign to agent
      console.log('Assigning to agent...');
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
    console.error('AI processing error:', error);
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
      console.log('No agents available for assignment');
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
    console.error('Agent assignment error:', error);
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

    console.log(`Negative comment count for post: ${negativeCount}`);

    if (negativeCount >= 3) {
      console.log('ALERT: Negative spike detected!');

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
    console.error('Negative spike check error:', error);
  }
}

