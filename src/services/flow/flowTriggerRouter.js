const AutomationFlow = require('../../models/AutomationFlow');
const FlowEnrollment = require('../../models/FlowEnrollment');
const Organization = require('../../models/Organization');
const flowExecutorService = require('./flowExecutorService');
const { isTriggerType } = require('../../config/flowNodeCatalog');
const logger = require('../../config/logger');

const EVENT_TO_TRIGGER = {
  'whatsapp.message': ['trigger.keyword', 'trigger.first_message', 'trigger.new_lead'],
  'whatsapp.order': ['trigger.order_event'],
  'facebook.message': ['trigger.keyword', 'trigger.first_message'],
  'facebook.dm': ['trigger.keyword', 'trigger.first_message', 'trigger.new_lead'],
  'facebook.comment': ['trigger.keyword'],
  'instagram.comment': ['trigger.ig_comment'],
  'instagram.story_reply': ['trigger.ig_story_reply'],
  'instagram.story_mention': ['trigger.ig_story_mention'],
  'instagram.dm': ['trigger.ig_dm', 'trigger.new_lead'],
  'instagram.postback': ['trigger.ig_postback']
};

/**
 * Synchronous trigger gate: event-type allow-list + config filters that need no
 * database access (keywords, postback payload, order event).
 */
function matchesTrigger(node, eventType, payload = {}) {
  if (!isTriggerType(node.type)) return false;
  const allowed = EVENT_TO_TRIGGER[eventType] || [];
  if (!allowed.includes(node.type)) return false;

  const config = node.config || {};
  const text = (payload.text || payload.content || '').toLowerCase();

  if (node.type === 'trigger.keyword' || node.type === 'trigger.ig_comment' || node.type === 'trigger.ig_story_reply') {
    const keywords = config.keywords || [];
    if (keywords.length && !keywords.some((k) => text.includes(String(k).toLowerCase()))) return false;
  }
  if (node.type === 'trigger.ig_postback' && config.payload) {
    if (payload.postback !== config.payload) return false;
  }
  if (node.type === 'trigger.order_event' && config.event) {
    if (payload.orderEvent !== config.event) return false;
  }
  return true;
}

/**
 * Async qualifiers that require DB lookups (first contact / new lead detection).
 * Runs only after the cheap synchronous gate passes.
 *
 * @returns {Promise<boolean>}
 */
async function qualifiesTrigger(node, { organizationId, platform, interaction }) {
  const platformUserId = interaction?.author?.platformId || '';

  if (node.type === 'trigger.first_message' || node.type === 'trigger.new_lead') {
    if (!platformUserId) return true; // can't determine history → don't block
    try {
      const Interaction = require('../../models/Interaction');
      // Count prior inbound interactions from this contact (excluding the
      // current one). Zero prior == genuinely the first message / new lead.
      const priorCount = await Interaction.countDocuments({
        organization: organizationId,
        platform,
        'author.platformId': platformUserId,
        _id: { $ne: interaction?._id }
      });
      return priorCount === 0;
    } catch (err) {
      logger.warn('[FlowTriggerRouter] first_message/new_lead check failed (allow)', { error: err.message });
      return true;
    }
  }
  return true;
}

class FlowTriggerRouter {
  /**
   * Whether flows should run for this org+channel, per the per-channel automation
   * mode (workflow_only / ai_only / hybrid), falling back to the deprecated
   * org-wide automationFlowMode via replyEngineService.
   */
  async shouldUseFlows(organizationId, platform) {
    const org = await Organization.findById(organizationId)
      .select('automationModeByChannel automationFlowMode')
      .lean();
    const replyEngineService = require('../replyEngineService');
    const { runFlows } = replyEngineService.decide({ organization: org, platform, flowHandled: false });
    if (!runFlows) return false;
    const activeCount = await AutomationFlow.countDocuments({ organization: organizationId, status: 'active', isBlueprint: false });
    return activeCount > 0;
  }

  /**
   * Route webhook event to matching flows.
   * @returns {Promise<{ handled: boolean, enrollments: object[] }>}
   */
  async route({ organizationId, platform, eventType, interaction, payload = {} }) {
    try {
      const useFlows = await this.shouldUseFlows(organizationId, platform);
      if (!useFlows) return { handled: false, enrollments: [] };

      const flows = await AutomationFlow.find({
        organization: organizationId,
        status: 'active',
        isBlueprint: false,
        channels: platform
      }).lean();

      if (!flows.length) return { handled: false, enrollments: [] };

      const enrollments = [];
      const platformUserIdTop = interaction?.author?.platformId || payload.platformUserId || '';
      const resumedFlowIds = new Set();

      // Reply-resume pass: any inbound message from a contact parked at a `wait.user_reply`
      // node continues the reply branch, regardless of whether it re-matches the trigger.
      const isReplyEvent = /\.(message|dm|postback)$/.test(eventType);
      if (isReplyEvent && platformUserIdTop) {
        const waiting = await FlowEnrollment.find({
          organization: organizationId,
          platform,
          platformUserId: platformUserIdTop,
          status: 'waiting',
          flow: { $in: flows.map((f) => f._id) }
        });
        for (const enr of waiting) {
          const flow = flows.find((f) => String(f._id) === String(enr.flow));
          const waitNode = flow && (flow.nodes || []).find((n) => n.id === enr.currentNodeId);
          if (waitNode?.type === 'wait.user_reply') {
            await this.resumeOnReply(enr, flow, interaction, organizationId);
            resumedFlowIds.add(String(flow._id));
            enrollments.push(enr);
          }
        }
      }

      for (const flow of flows) {
        if (resumedFlowIds.has(String(flow._id))) continue;
        const triggerNode = (flow.nodes || []).find((n) => matchesTrigger(n, eventType, { ...payload, content: interaction?.content, text: interaction?.content }));
        if (!triggerNode) continue;

        // Async qualifiers (first message / new lead detection).
        const qualifies = await qualifiesTrigger(triggerNode, { organizationId, platform, interaction });
        if (!qualifies) continue;

        const startNodeId = flowExecutorService.getStartNodeId(flow);
        if (!startNodeId) continue;

        const platformUserId = interaction?.author?.platformId || payload.platformUserId || '';
        const existing = await FlowEnrollment.findOne({
          organization: organizationId,
          flow: flow._id,
          platformUserId,
          status: { $in: ['active', 'waiting'] }
        });

        if (existing) {
          // Already enrolled (active, or waiting on a timer/reply handled by the resume pass) —
          // never start a duplicate enrollment for the same contact in the same flow.
          enrollments.push(existing);
          continue;
        }

        const enrollment = await FlowEnrollment.create({
          organization: organizationId,
          flow: flow._id,
          flowVersion: flow.version || 1,
          platform,
          platformUserId,
          contact: interaction?.contact,
          interaction: interaction?._id,
          currentNodeId: startNodeId,
          variables: { triggerEvent: eventType },
          status: 'active'
        });

        await AutomationFlow.updateOne({ _id: flow._id }, { $inc: { 'stats.triggered': 1 } });

        const result = await flowExecutorService.runEnrollment({
          enrollment,
          flow,
          interaction,
          organizationId
        });

        enrollment.currentNodeId = result.currentNodeId;
        enrollment.status = result.status;
        enrollment.nextRunAt = result.nextRunAt;
        enrollment.lastError = result.lastError;
        enrollment.history = result.history;
        enrollment.variables = result.variables;
        await enrollment.save();

        if (result.status === 'completed') {
          await AutomationFlow.updateOne({ _id: flow._id }, { $inc: { 'stats.completed': 1 } });
        } else if (result.status === 'failed') {
          await AutomationFlow.updateOne({ _id: flow._id }, { $inc: { 'stats.failed': 1 } });
        }

        await this._markInteractionOwnership(interaction?._id, result.status);
        enrollments.push(enrollment);
      }

      return { handled: enrollments.length > 0, enrollments };
    } catch (err) {
      logger.error('[FlowTriggerRouter] route error', { error: err.message, organizationId, eventType });
      return { handled: false, enrollments: [] };
    }
  }

  /**
   * Resume a parked `wait.user_reply` enrollment because the contact replied.
   * Advances down the reply branch using the new inbound interaction.
   */
  async resumeOnReply(enrollmentDoc, flow, interaction, organizationId) {
    enrollmentDoc.status = 'active';
    if (interaction?._id) enrollmentDoc.interaction = interaction._id;

    const result = await flowExecutorService.runEnrollment({
      enrollment: enrollmentDoc,
      flow,
      interaction,
      organizationId,
      resume: { reason: 'reply' }
    });

    this._applyResult(enrollmentDoc, result);
    await enrollmentDoc.save();
    await this._recordTerminalStats(flow._id, result.status);
    await this._markInteractionOwnership(interaction?._id || enrollmentDoc.interaction, result.status);
    return enrollmentDoc;
  }

  /** Resume waiting enrollments whose timer elapsed (called from processFlowTick). */
  async tickEnrollment(enrollmentDoc) {
    const flow = await AutomationFlow.findById(enrollmentDoc.flow).lean();
    if (!flow || flow.status !== 'active') {
      enrollmentDoc.status = 'dropped';
      await enrollmentDoc.save();
      await this._markInteractionOwnership(enrollmentDoc.interaction, 'dropped');
      return;
    }

    const Interaction = require('../../models/Interaction');
    const interaction = enrollmentDoc.interaction
      ? await Interaction.findById(enrollmentDoc.interaction).lean()
      : null;

    // A user_reply node that elapses is a timeout; any other wait simply finished its delay.
    const waitNode = (flow.nodes || []).find((n) => n.id === enrollmentDoc.currentNodeId);
    const reason = waitNode?.type === 'wait.user_reply' ? 'timeout' : 'elapsed';

    enrollmentDoc.status = 'active';
    const result = await flowExecutorService.runEnrollment({
      enrollment: enrollmentDoc,
      flow,
      interaction,
      organizationId: enrollmentDoc.organization,
      resume: { reason }
    });

    this._applyResult(enrollmentDoc, result);
    await enrollmentDoc.save();
    await this._recordTerminalStats(flow._id, result.status);
    await this._markInteractionOwnership(enrollmentDoc.interaction, result.status);
  }

  _applyResult(enrollmentDoc, result) {
    enrollmentDoc.currentNodeId = result.currentNodeId;
    enrollmentDoc.status = result.status;
    enrollmentDoc.nextRunAt = result.nextRunAt;
    enrollmentDoc.lastError = result.lastError;
    enrollmentDoc.history = result.history;
    enrollmentDoc.variables = result.variables;
  }

  /**
   * Durable "a workflow owns this conversation" signal read by the AI fallback
   * gate (autoReplyScheduler / webhook). Set true while the enrollment is
   * active/waiting; cleared on a terminal status so AI can take over later.
   * @param {string|ObjectId} interactionId
   * @param {string} status  enrollment status after a run
   */
  async _markInteractionOwnership(interactionId, status) {
    if (!interactionId) return;
    const owns = status === 'active' || status === 'waiting';
    try {
      const Interaction = require('../../models/Interaction');
      await Interaction.updateOne(
        { _id: interactionId },
        { $set: { 'metadata.flowHandled': owns } }
      );
    } catch (err) {
      logger.warn('[FlowTriggerRouter] failed to set metadata.flowHandled', { error: err.message });
    }
  }

  async _recordTerminalStats(flowId, status) {
    if (status === 'completed') {
      await AutomationFlow.updateOne({ _id: flowId }, { $inc: { 'stats.completed': 1 } });
    } else if (status === 'failed') {
      await AutomationFlow.updateOne({ _id: flowId }, { $inc: { 'stats.failed': 1 } });
    }
  }
}

module.exports = new FlowTriggerRouter();
