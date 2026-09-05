const AutomationFlow = require('../../models/AutomationFlow');
const FlowEnrollment = require('../../models/FlowEnrollment');
const Organization = require('../../models/Organization');
const Contact = require('../../models/Contact');
const flowExecutorService = require('./flowExecutorService');
const { isTriggerType } = require('../../config/flowNodeCatalog');
const logger = require('../../config/logger');

/** Keywords that signal a contact has opted out of automated messages (case-insensitive). */
const OPT_OUT_KEYWORDS = new Set(['stop', 'unsubscribe', 'cancel', 'quit', 'opt out', 'optout']);
const OPT_IN_KEYWORDS  = new Set(['start', 'subscribe', 'optin', 'opt in', 'yes']);

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
  'instagram.postback': ['trigger.ig_postback'],
  // Appointment lifecycle events emitted by the appointment system (Phase 4 reminders).
  'appointment.booked': ['trigger.appointment_event'],
  'appointment.reminder': ['trigger.appointment_event'],
  'appointment.cancelled': ['trigger.appointment_event']
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
  if (node.type === 'trigger.appointment_event' && config.event) {
    if (payload.appointmentEvent !== config.event) return false;
  }
  return true;
}

/**
 * Whether this inbound event is the contact's first message on this channel.
 *
 * WhatsApp / IG / FB DMs append every inbound message to a single thread
 * Interaction (`metadata.incomingMessages`). Counting Interaction documents
 * by `author.platformId` therefore always returns 0 and re-triggers welcome
 * flows on every reply.
 *
 * @returns {Promise<boolean>}
 */
async function isFirstContactMessage({ organizationId, platform, interaction }) {
  const platformUserId = interaction?.author?.platformId || '';
  if (!platformUserId) return false;

  const incoming = interaction?.metadata?.incomingMessages;
  if (Array.isArray(incoming)) {
    return incoming.length <= 1;
  }

  try {
    const Interaction = require('../../models/Interaction');
    const priorCount = await Interaction.countDocuments({
      organization: organizationId,
      platform,
      'author.platformId': platformUserId,
      _id: { $ne: interaction?._id }
    });
    return priorCount === 0;
  } catch (err) {
    logger.warn('[FlowTriggerRouter] isFirstContactMessage fallback failed (deny)', { error: err.message });
    return false;
  }
}

/**
 * Async qualifiers that require DB lookups (first contact / new lead detection).
 * Runs only after the cheap synchronous gate passes.
 *
 * @returns {Promise<boolean>}
 */
async function qualifiesTrigger(node, { organizationId, platform, interaction }) {
  if (node.type === 'trigger.first_message' || node.type === 'trigger.new_lead') {
    return isFirstContactMessage({ organizationId, platform, interaction });
  }
  return true;
}

/**
 * Build interpolation variables describing the order that just triggered the flow,
 * so blueprints (e.g. Checkout) can say "We've received your order: 2× X. Total ₹300."
 * Reads the CommerceOrder linked to this interaction. Non-fatal — returns {}.
 */
async function buildOrderVars(organizationId, interaction) {
  try {
    if (!interaction?._id) return {};
    const CommerceOrder = require('../../models/CommerceOrder');
    const { formatMoney } = require('../inbox/inboxOpsFormatters');
    const order = await CommerceOrder.findOne({
      organization: organizationId,
      sourceInteraction: interaction._id,
      status: { $nin: ['cancelled', 'refunded', 'returned', 'delivered'] }
    }).sort({ createdAt: -1 }).lean();
    if (!order || !(order.lineItems || []).length) return {};

    const items = order.lineItems.map((li) => `${li.qty || 1}× ${li.name || 'item'}`).join(', ');
    const total = order.totalAmount != null ? formatMoney(order.totalAmount, order.currency) : '';
    return {
      orderId: String(order._id),
      order_ref: order.displayRef || '',
      order_summary: items,
      order_total: total,
      // Ready-to-embed sentence (empty when there's no order, so copy still reads well).
      order_summary_line: `We’ve received your order: ${items}.${total ? ` Total ${total}.` : ''}`
    };
  } catch (err) {
    logger.debug('[FlowTriggerRouter] buildOrderVars failed (non-fatal)', { error: err.message });
    return {};
  }
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

      // Order-event flows (e.g. Checkout blueprint) get order details as variables.
      const orderVars = eventType === 'whatsapp.order'
        ? await buildOrderVars(organizationId, interaction)
        : {};

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
        }).sort({ updatedAt: -1 }); // most-recent conversation first
        const now = new Date();
        for (const enr of waiting) {
          const flow = flows.find((f) => String(f._id) === String(enr.flow));
          const waitNode = flow && (flow.nodes || []).find((n) => n.id === enr.currentNodeId);
          if (waitNode?.type !== 'wait.user_reply') continue;

          // Expiry guard: a reply that arrives AFTER the wait's own timeout window
          // (nextRunAt) is not the awaited reply — the customer abandoned the flow
          // and is starting a new conversation. Release the stale enrollment so the
          // new message starts fresh instead of resuming the old flow. This runs on
          // the inbound-message path, so it's robust even when the worker / flow-tick
          // never fired the timeout. Tune the abandonment window via the wait node's
          // "Timeout (seconds)".
          if (enr.nextRunAt && enr.nextRunAt <= now) {
            enr.status = 'dropped';
            enr.nextRunAt = null;
            await enr.save();
            await this._markInteractionOwnership(interaction?._id, 'dropped').catch(() => {});
            logger.info('[FlowTriggerRouter] stale wait released (abandoned flow)', {
              enrollmentId: String(enr._id), flow: String(enr.flow)
            });
            continue; // do NOT resume; let fresh trigger matching run below
          }

          // Resume ONLY the most-recent waiting flow — the conversation the customer
          // is actually in — so one reply never fires several parked flows at once.
          await this.resumeOnReply(enr, flow, interaction, organizationId);
          resumedFlowIds.add(String(flow._id));
          enrollments.push(enr);
          break;
        }
      }

      // ── Opt-out / opt-in keyword detection ────────────────────────────────
      // Check the inbound message for STOP/UNSUBSCRIBE/START before attempting
      // any fresh trigger matching. This runs even when no flows were resumed.
      if (platformUserIdTop && interaction?.content) {
        const msgLower = String(interaction.content).trim().toLowerCase();
        const isOptOut = OPT_OUT_KEYWORDS.has(msgLower);
        const isOptIn  = OPT_IN_KEYWORDS.has(msgLower);
        if (isOptOut || isOptIn) {
          // Find contact by platform + platformUserId
          const contactDoc = interaction?.contact
            ? await Contact.findById(interaction.contact).select('_id flowsOptedOut').lean()
            : await Contact.findOne({
                organization: organizationId,
                'channels.platform': platform,
                'channels.platformUserId': platformUserIdTop
              }).select('_id flowsOptedOut').lean();
          if (contactDoc) {
            await Contact.updateOne(
              { _id: contactDoc._id },
              isOptOut
                ? { flowsOptedOut: true,  flowsOptedOutAt: new Date() }
                : { flowsOptedOut: false, flowsOptedOutAt: null }
            );
            logger.info('[FlowTriggerRouter] contact opt-out updated', {
              contactId: String(contactDoc._id), optedOut: isOptOut
            });
          }
          // STOP means: cancel all waiting enrollments for this contact too.
          if (isOptOut) {
            await FlowEnrollment.updateMany(
              { organization: organizationId, platform, platformUserId: platformUserIdTop, status: { $in: ['active', 'waiting'] } },
              { status: 'dropped', lastError: 'Contact opted out (STOP)', nextRunAt: null }
            );
            return { handled: true, enrollments: [], optedOut: true };
          }
        }
      }

      // If a parked flow resumed, it owns this reply — don't ALSO start other flows
      // on the same message (that's what produced multiple replies at once).
      const skipFreshTriggers = enrollments.length > 0;

      for (const flow of flows) {
        if (skipFreshTriggers) break;
        if (resumedFlowIds.has(String(flow._id))) continue;
        const triggerNode = (flow.nodes || []).find((n) => matchesTrigger(n, eventType, { ...payload, content: interaction?.content, text: interaction?.content }));
        if (!triggerNode) continue;

        // Async qualifiers (first message / new lead detection).
        const qualifies = await qualifiesTrigger(triggerNode, { organizationId, platform, interaction });
        if (!qualifies) continue;

        const startNodeId = flowExecutorService.getStartNodeId(flow);
        if (!startNodeId) continue;

        const platformUserId = interaction?.author?.platformId || payload.platformUserId || '';
        const isOneShotTrigger =
          triggerNode.type === 'trigger.first_message' || triggerNode.type === 'trigger.new_lead';
        // Best-effort business guard: don't stack a second run of this flow on top of one
        // that's already in progress for this contact. (This alone is a check-then-create
        // race under heavy concurrency — the triggerMid upsert below is the hard backstop
        // that makes duplicate creation impossible regardless of timing.)
        const existing = await FlowEnrollment.findOne(
          isOneShotTrigger
            ? { organization: organizationId, flow: flow._id, platformUserId }
            : {
                organization: organizationId,
                flow: flow._id,
                platformUserId,
                status: { $in: ['active', 'waiting'] }
              }
        );

        if (existing) {
          // One-shot triggers never re-enroll the same contact. Other flows only block
          // while an enrollment is still active or waiting on a timer/reply.
          enrollments.push(existing);
          continue;
        }

        // Frequency cap: skip enrollment if the contact already received too many
        // enrollments from this flow within the configured window.
        const capExceeded = await this.checkFrequencyCap(flow, platformUserId, organizationId);
        if (capExceeded) {
          logger.info('[FlowTriggerRouter] frequency cap exceeded — skipping enrollment', {
            flowId: String(flow._id), platformUserId
          });
          continue;
        }

        // Opt-out guard: never enroll a contact who has sent STOP.
        if (interaction?.contact) {
          const contactOptedOut = await Contact.findById(interaction.contact).select('flowsOptedOut').lean();
          if (contactOptedOut?.flowsOptedOut) {
            logger.info('[FlowTriggerRouter] skipping opted-out contact', {
              flowId: String(flow._id), contactId: String(interaction.contact)
            });
            continue;
          }
        }

        // Hard idempotency backstop: atomic upsert keyed on the exact triggering message
        // (flow + platformUserId + triggerMid), enforced by a unique DB index. If two
        // concurrent requests somehow reach this point for the SAME inbound message (e.g. a
        // webhook retry that slipped past the queue/dedup layers upstream, or a future code
        // path we haven't audited yet), only one can win — the loser gets the winner's
        // enrollment back instead of creating and running a second one.
        const triggerMid = payload.mid || interaction?.metadata?.lastMid || '';
        let enrollment;
        let isNewEnrollment = true;

        if (triggerMid) {
          let upsertResult;
          try {
            upsertResult = await FlowEnrollment.findOneAndUpdate(
              { organization: organizationId, flow: flow._id, platformUserId, triggerMid },
              {
                $setOnInsert: {
                  organization: organizationId,
                  flow: flow._id,
                  flowVersion: flow.version || 1,
                  platform,
                  platformUserId,
                  contact: interaction?.contact,
                  interaction: interaction?._id,
                  currentNodeId: startNodeId,
                  variables: { triggerEvent: eventType, ...orderVars },
                  status: 'active',
                  triggerMid
                }
              },
              { upsert: true, new: true, includeResultMetadata: true }
            );
          } catch (raceErr) {
            if (raceErr?.code === 11000) {
              // Lost the insert race to a concurrent request — fetch the winner's doc.
              upsertResult = null;
            } else {
              throw raceErr;
            }
          }

          if (!upsertResult) {
            const winner = await FlowEnrollment.findOne({ organization: organizationId, flow: flow._id, platformUserId, triggerMid });
            if (winner) enrollments.push(winner);
            continue;
          }

          enrollment = upsertResult.value;
          isNewEnrollment = upsertResult.lastErrorObject?.updatedExisting !== true;
          if (!isNewEnrollment) {
            // This exact message already has an enrollment — do NOT run the flow again
            // (that would resend whatever the flow sends). Just report the existing one.
            logger.warn('[FlowTriggerRouter] duplicate triggerMid caught by upsert guard — not re-running', {
              flowId: String(flow._id), platformUserId, triggerMid
            });
            enrollments.push(enrollment);
            continue;
          }
        } else {
          // No mid available (non-message trigger, e.g. an appointment lifecycle event) —
          // the triggerMid guard doesn't apply; fall back to a plain insert.
          enrollment = await FlowEnrollment.create({
            organization: organizationId,
            flow: flow._id,
            flowVersion: flow.version || 1,
            platform,
            platformUserId,
            contact: interaction?.contact,
            interaction: interaction?._id,
            currentNodeId: startNodeId,
            variables: { triggerEvent: eventType, ...orderVars },
            status: 'active'
          });
        }

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
        if (result.converted) {
          await AutomationFlow.updateOne({ _id: flow._id }, { $inc: { 'stats.converted': 1 } });
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
    if (result.converted) {
      await AutomationFlow.updateOne({ _id: flow._id }, { $inc: { 'stats.converted': 1 } });
    }
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
    if (result.converted) {
      await AutomationFlow.updateOne({ _id: flow._id }, { $inc: { 'stats.converted': 1 } });
    }
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

  /**
   * Check if the contact has exceeded the frequency cap configured on this flow.
   * Returns true (cap exceeded — skip enrollment) when the contact already has
   * >= frequencyCap completed/active/waiting enrollments in the cap window.
   *
   * @param {object} flow  lean AutomationFlow document
   * @param {string} platformUserId
   * @param {string|ObjectId} organizationId
   * @returns {Promise<boolean>} true = skip enrollment
   */
  async checkFrequencyCap(flow, platformUserId, organizationId) {
    try {
      const cap = flow?.settings?.frequencyCap;
      const windowDays = flow?.settings?.frequencyCapWindowDays || 1;

      // 0 or missing = no cap
      if (!cap || cap <= 0) return false;
      if (!platformUserId) return false;

      const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);

      const count = await FlowEnrollment.countDocuments({
        organization: organizationId,
        flow: flow._id,
        platformUserId,
        status: { $in: ['active', 'waiting', 'completed'] },
        createdAt: { $gte: since }
      });

      return count >= cap;
    } catch (err) {
      logger.warn('[FlowTriggerRouter] checkFrequencyCap failed (non-fatal, allowing enrollment)', { error: err.message });
      return false;
    }
  }
}

const flowTriggerRouter = new FlowTriggerRouter();

module.exports = flowTriggerRouter;
module.exports.isFirstContactMessage = isFirstContactMessage;
module.exports.qualifiesTrigger = qualifiesTrigger;
