const Interaction = require('../models/Interaction');
const Organization = require('../models/Organization');
const User = require('../models/User');

/**
 * Escalation Service - Hybrid Approach
 * Manages intelligent escalation of conversations to human agents
 * 
 * Escalation Rules:
 * 1. Hard Rules (immediate escalation):
 *    - 3+ auto-replies reached
 *    - 2+ negative sentiments in thread
 *    - Escalation keywords detected
 * 
 * 2. Soft Rules (escalation with scoring):
 *    - Sentiment declining
 *    - AI confidence low
 *    - Customer frustration indicators
 */

class EscalationService {
  
  /**
   * Check if interaction should be escalated
   * @param {Object} interaction - The interaction to check
   * @param {Object} organization - Organization with escalation settings
   * @param {Object} aiResponse - Optional AI response with confidence
   * @returns {Object} { shouldEscalate, reasons[], score, type }
   */
  async shouldEscalate(interaction, organization, aiResponse = null) {
    if (!organization.escalationSettings?.enabled) {
      return { shouldEscalate: false, reasons: [], score: 0 };
    }

    const settings = organization.escalationSettings;
    const reasons = [];
    let escalationScore = 0;
    let escalationType = 'auto';

    // HARD RULE 1: Max auto-replies reached
    if (interaction.autoReplyCount >= settings.maxAutoReplies) {
      reasons.push(`Maximum auto-replies reached (${interaction.autoReplyCount}/${settings.maxAutoReplies})`);
      return {
        shouldEscalate: true,
        reasons,
        score: 100,
        type: 'reply_limit'
      };
    }

    // HARD RULE 2: Multiple negative sentiments
    const negativeCount = interaction.escalationMetadata?.negativeCount || 
      (interaction.sentimentHistory || []).filter(s => s.sentiment === 'negative').length;
    
    if (settings.escalateOnNegative && negativeCount >= settings.negativeThreshold) {
      reasons.push(`Negative sentiment threshold exceeded (${negativeCount}/${settings.negativeThreshold})`);
      return {
        shouldEscalate: true,
        reasons,
        score: 100,
        type: 'sentiment'
      };
    }

    // HARD RULE 3: Escalation keywords detected
    const containsKeyword = this.checkEscalationKeywords(
      interaction.content,
      settings.escalationKeywords || []
    );
    
    if (containsKeyword.found) {
      reasons.push(`Escalation keywords detected: ${containsKeyword.keywords.join(', ')}`);
      return {
        shouldEscalate: true,
        reasons,
        score: 100,
        type: 'keyword',
        metadata: { triggerKeywords: containsKeyword.keywords }
      };
    }

    // SOFT RULES: Calculate escalation score
    
    // Soft Rule 1: Reply depth (10 points per reply)
    escalationScore += interaction.autoReplyCount * 10;
    if (interaction.autoReplyCount >= 2) {
      reasons.push(`Approaching reply limit (${interaction.autoReplyCount}/${settings.maxAutoReplies})`);
    }

    // Soft Rule 2: Negative sentiment (30 points)
    if (interaction.sentiment === 'negative') {
      escalationScore += 30;
      reasons.push('Negative sentiment detected');
    }

    // Soft Rule 3: Low AI confidence (20 points)
    if (aiResponse && aiResponse.confidence < settings.lowConfidenceThreshold) {
      escalationScore += 20;
      reasons.push(`Low AI confidence (${(aiResponse.confidence * 100).toFixed(0)}%)`);
    }

    // Soft Rule 4: Sentiment declining trend (15 points)
    const sentimentTrend = this.analyzeSentimentTrend(interaction.sentimentHistory || []);
    if (sentimentTrend === 'declining') {
      escalationScore += 15;
      reasons.push('Sentiment is declining');
    }

    // Soft Rule 5: Customer frustration indicators (15 points)
    const frustrationIndicators = this.detectFrustrationIndicators(interaction.content);
    if (frustrationIndicators.found) {
      escalationScore += 15;
      reasons.push(`Frustration indicators: ${frustrationIndicators.indicators.join(', ')}`);
    }

    // Soft Rule 6: Urgency keywords (10 points)
    const urgencyKeywords = this.detectUrgencyKeywords(interaction.content);
    if (urgencyKeywords.found) {
      escalationScore += 10;
      reasons.push(`Urgency detected: ${urgencyKeywords.keywords.join(', ')}`);
    }

    // ESCALATION THRESHOLD: Score >= 50
    const shouldEscalate = escalationScore >= 50;

    return {
      shouldEscalate,
      reasons,
      score: escalationScore,
      type: shouldEscalate ? 'auto' : null,
      metadata: {
        sentimentTrend,
        frustrationIndicators: frustrationIndicators.indicators,
        urgencyKeywords: urgencyKeywords.keywords
      }
    };
  }

  /**
   * Check for escalation keywords
   */
  checkEscalationKeywords(content, keywords) {
    const lowerContent = content.toLowerCase();
    const foundKeywords = keywords.filter(keyword =>
      lowerContent.includes(keyword.toLowerCase())
    );

    return {
      found: foundKeywords.length > 0,
      keywords: foundKeywords
    };
  }

  /**
   * Analyze sentiment trend
   * @returns {String} 'improving', 'declining', 'stable'
   */
  analyzeSentimentTrend(sentimentHistory) {
    if (sentimentHistory.length < 2) {
      return 'stable';
    }

    const recentSentiments = sentimentHistory.slice(-3);
    const sentimentValues = recentSentiments.map(s => {
      if (s.sentiment === 'positive') return 1;
      if (s.sentiment === 'negative') return -1;
      return 0;
    });

    // Check if trending downward
    let decliningCount = 0;
    for (let i = 1; i < sentimentValues.length; i++) {
      if (sentimentValues[i] < sentimentValues[i - 1]) {
        decliningCount++;
      }
    }

    if (decliningCount >= 2) return 'declining';
    
    // Check if trending upward
    let improvingCount = 0;
    for (let i = 1; i < sentimentValues.length; i++) {
      if (sentimentValues[i] > sentimentValues[i - 1]) {
        improvingCount++;
      }
    }

    if (improvingCount >= 2) return 'improving';

    return 'stable';
  }

  /**
   * Detect customer frustration indicators
   */
  detectFrustrationIndicators(content) {
    const indicators = [
      'again', 'still', 'yet', 'already told', 'keep telling',
      'not listening', 'not understanding', 'frustrated',
      'waste of time', 'ridiculous', 'unbelievable',
      'how many times', 'repeatedly', 'multiple times',
      '!!!', 'ALL CAPS', 'REALLY', 'SERIOUSLY'
    ];

    const lowerContent = content.toLowerCase();
    const foundIndicators = [];

    indicators.forEach(indicator => {
      if (lowerContent.includes(indicator.toLowerCase())) {
        foundIndicators.push(indicator);
      }
    });

    // Check for ALL CAPS (frustration indicator)
    const words = content.split(/\s+/);
    const capsWords = words.filter(word => 
      word.length > 3 && word === word.toUpperCase() && /^[A-Z]+$/.test(word)
    );
    if (capsWords.length >= 2) {
      foundIndicators.push('ALL CAPS');
    }

    // Check for multiple exclamation marks
    if (content.includes('!!!') || (content.match(/!/g) || []).length >= 3) {
      foundIndicators.push('Multiple exclamation marks');
    }

    return {
      found: foundIndicators.length > 0,
      indicators: foundIndicators
    };
  }

  /**
   * Detect urgency keywords
   */
  detectUrgencyKeywords(content) {
    const urgencyWords = [
      'urgent', 'asap', 'immediately', 'right now', 'emergency',
      'critical', 'important', 'quickly', 'hurry', 'fast',
      'soon as possible', 'time sensitive'
    ];

    const lowerContent = content.toLowerCase();
    const foundKeywords = urgencyWords.filter(keyword =>
      lowerContent.includes(keyword.toLowerCase())
    );

    return {
      found: foundKeywords.length > 0,
      keywords: foundKeywords
    };
  }

  /**
   * Escalate interaction to human agent
   * @param {Object} interaction - Interaction to escalate
   * @param {Object} organization - Organization
   * @param {Array} reasons - Reasons for escalation
   * @param {String} type - Escalation type
   * @param {Object} metadata - Additional metadata
   */
  async escalateInteraction(interaction, organization, reasons, type, metadata = {}) {
    try {
      // Mark interaction as requiring human response
      await interaction.escalateToHuman(reasons, type, metadata);

      console.log(`🚨 [Escalation] Interaction ${interaction._id} escalated to human`);
      console.log(`   Type: ${type}`);
      console.log(`   Reasons: ${reasons.join(', ')}`);

      // Auto-assign to agent if enabled
      if (organization.escalationSettings?.autoAssign) {
        const agent = await this.assignToAgent(interaction, organization);
        if (agent) {
          console.log(`👤 [Escalation] Auto-assigned to agent: ${agent.firstName} ${agent.lastName}`);
          
          // Send notification if enabled
          if (organization.escalationSettings?.notifyAgents) {
            await this.notifyAgent(agent, interaction, organization);
          }
        }
      }

      return interaction;
    } catch (error) {
      console.error('❌ [Escalation] Error escalating interaction:', error);
      throw error;
    }
  }

  /**
   * Assign interaction to agent using configured method
   */
  async assignToAgent(interaction, organization) {
    const settings = organization.escalationSettings;
    const method = settings.assignmentMethod || 'round_robin';

    try {
      let agent = null;

      switch (method) {
        case 'round_robin':
          agent = await this.assignRoundRobin(organization);
          break;
        
        case 'least_busy':
          agent = await this.assignLeastBusy(organization);
          break;
        
        case 'skill_based':
          agent = await this.assignSkillBased(interaction, organization);
          break;
        
        case 'manual':
          // Don't auto-assign, wait for manual assignment
          return null;
        
        default:
          agent = await this.assignRoundRobin(organization);
      }

      if (agent) {
        await interaction.assignTo(agent._id, agent._id, 'escalation');
        return agent;
      }

      return null;
    } catch (error) {
      console.error('❌ [Escalation] Error assigning to agent:', error);
      return null;
    }
  }

  /**
   * Round-robin assignment
   */
  async assignRoundRobin(organization) {
    const availableAgents = organization.escalationSettings?.availableAgents || [];
    
    if (availableAgents.length === 0) {
      // Fallback: Get all users with 'admin' or 'manager' role
      const agents = await User.find({
        organization: organization._id,
        role: { $in: ['admin', 'manager'] },
        isActive: true
      });

      if (agents.length === 0) return null;

      // Use first agent
      return agents[0];
    }

    // Get next agent in round-robin
    const lastIndex = organization.escalationSettings.lastAssignedAgentIndex || -1;
    const nextIndex = (lastIndex + 1) % availableAgents.length;
    const agentId = availableAgents[nextIndex];

    // Update last assigned index
    organization.escalationSettings.lastAssignedAgentIndex = nextIndex;
    await organization.save();

    const agent = await User.findById(agentId);
    return agent;
  }

  /**
   * Assign to least busy agent
   */
  async assignLeastBusy(organization) {
    const availableAgents = organization.escalationSettings?.availableAgents || [];
    
    let agents;
    if (availableAgents.length === 0) {
      agents = await User.find({
        organization: organization._id,
        role: { $in: ['admin', 'manager'] },
        isActive: true
      });
    } else {
      agents = await User.find({ _id: { $in: availableAgents } });
    }

    if (agents.length === 0) return null;

    // Count assigned interactions for each agent
    const agentWorkload = await Promise.all(
      agents.map(async (agent) => {
        const count = await Interaction.countDocuments({
          assignedTo: agent._id,
          status: 'assigned',
          requiresHumanResponse: true
        });
        return { agent, count };
      })
    );

    // Sort by workload (least busy first)
    agentWorkload.sort((a, b) => a.count - b.count);

    return agentWorkload[0].agent;
  }

  /**
   * Skill-based assignment (placeholder for future implementation)
   */
  async assignSkillBased(interaction, organization) {
    // For now, fallback to round-robin
    // In future, can assign based on:
    // - Platform expertise
    // - Issue type (billing, technical, etc.)
    // - Language
    // - Priority level
    return await this.assignRoundRobin(organization);
  }

  /**
   * Notify agent of assignment
   */
  async notifyAgent(agent, interaction, organization) {
    try {
      // TODO: Implement actual notifications
      // For now, just log
      console.log(`📧 [Escalation] Notification sent to ${agent.email}`);
      console.log(`   Interaction: ${interaction._id}`);
      console.log(`   Platform: ${interaction.platform}`);
      console.log(`   Type: ${interaction.type}`);
      console.log(`   Content: ${interaction.content.substring(0, 100)}...`);

      // Future implementation:
      // - Send email via SendGrid
      // - Send push notification
      // - Send Slack message
      // - Send SMS via Twilio

    } catch (error) {
      console.error('❌ [Escalation] Error sending notification:', error);
    }
  }

  /**
   * Get escalation statistics for organization
   */
  async getEscalationStats(organizationId, dateRange = 'today') {
    const startDate = this.getStartDate(dateRange);

    const [
      totalEscalated,
      escalatedByType,
      averageResponseTime,
      pendingAssignments
    ] = await Promise.all([
      // Total escalated
      Interaction.countDocuments({
        organization: organizationId,
        requiresHumanResponse: true,
        escalatedAt: { $gte: startDate }
      }),

      // Escalated by type
      Interaction.aggregate([
        {
          $match: {
            organization: organizationId,
            requiresHumanResponse: true,
            escalatedAt: { $gte: startDate }
          }
        },
        {
          $group: {
            _id: '$escalationType',
            count: { $sum: 1 }
          }
        }
      ]),

      // Average response time for escalated interactions
      Interaction.aggregate([
        {
          $match: {
            organization: organizationId,
            requiresHumanResponse: true,
            respondedAt: { $exists: true },
            escalatedAt: { $gte: startDate }
          }
        },
        {
          $project: {
            responseTime: {
              $subtract: ['$respondedAt', '$escalatedAt']
            }
          }
        },
        {
          $group: {
            _id: null,
            avgResponseTime: { $avg: '$responseTime' }
          }
        }
      ]),

      // Pending assignments
      Interaction.countDocuments({
        organization: organizationId,
        requiresHumanResponse: true,
        assignedTo: { $exists: false },
        status: { $ne: 'resolved' }
      })
    ]);

    return {
      totalEscalated,
      escalatedByType: escalatedByType.reduce((acc, item) => {
        acc[item._id] = item.count;
        return acc;
      }, {}),
      averageResponseTime: averageResponseTime[0]?.avgResponseTime || 0,
      pendingAssignments
    };
  }

  /**
   * Helper to get start date based on range
   */
  getStartDate(range) {
    const now = new Date();
    switch (range) {
      case 'today':
        return new Date(now.setHours(0, 0, 0, 0));
      case 'week':
        return new Date(now.setDate(now.getDate() - 7));
      case 'month':
        return new Date(now.setMonth(now.getMonth() - 1));
      default:
        return new Date(now.setHours(0, 0, 0, 0));
    }
  }
}

module.exports = new EscalationService();

