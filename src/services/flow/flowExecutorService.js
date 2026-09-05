const logger = require('../../config/logger');
const { isTriggerType } = require('../../config/flowNodeCatalog');
const { executeNodeHandler } = require('./flowNodeHandlers');

const TIMEOUT_BRANCHES = ['no_reply', 'timeout', 'expired', 'no'];
const REPLY_BRANCHES = ['reply', 'replied', 'yes', 'default'];
// The Flow Builder UI's edge-label chips for a `wait.user_reply` node are
// ['yes', 'no', 'reply', 'no_reply'] (see edgeBranchPresets in
// flow-builder.component.ts) — authors are free to label the two branches
// either structurally ("reply" / "no_reply") or with the literal answer
// ("yes" / "no"). Only the structural pair is exempt from content matching.
const STRUCTURAL_REPLY_LABELS = ['reply', 'no_reply', 'default'];

function edgeBranch(edge) {
  return String(edge?.label || edge?.condition?.branch || '').trim().toLowerCase();
}

/**
 * Choose the outgoing edge for a resumed wait node based on why it resumed.
 *
 * IMPORTANT: for a genuine reply (reason !== 'timeout'), this must not just grab
 * whichever edge happens to be labelled "yes"/"reply" — it has to reflect what the
 * contact actually said/tapped. Previously this always returned the first
 * REPLY_BRANCHES-labelled edge for *any* reply, so a `wait.user_reply` node with two
 * edges labelled "yes" and "no" (a very natural thing to build from the UI's own
 * "yes"/"no" chip presets) would silently route every reply — including an explicit
 * "No" — down the "yes" edge, because "yes" also serves as the generic
 * "a-reply-arrived" marker. Content matching below fixes that while leaving the
 * structural reply/no_reply scaffold (and single-edge flows) working exactly as before.
 * @param {string} [replyText] The contact's actual reply content (only meaningful when reason === 'reply').
 */
function resolveWaitEdge(edges, nodeType, reason, replyText = '') {
  if (!edges?.length) return null;
  if (nodeType !== 'wait.user_reply') return edges[0];

  if (reason === 'timeout') {
    const labeled = edges.find((e) => TIMEOUT_BRANCHES.includes(edgeBranch(e)));
    if (labeled) return labeled;
    // No edge explicitly means "timeout" — take whichever edge isn't the reply path.
    return edges.find((e) => !REPLY_BRANCHES.includes(edgeBranch(e))) || edges[edges.length - 1] || edges[0];
  }

  // reason === 'reply': prefer an edge whose label is literally what the contact
  // said/tapped (handles "yes"/"no"-style content labels and button titles).
  const text = String(replyText || '').trim().toLowerCase();
  if (text) {
    const contentMatch = edges.find((e) => {
      const label = edgeBranch(e);
      if (!label || STRUCTURAL_REPLY_LABELS.includes(label)) return false;
      return label === text || text.includes(label) || label.includes(text);
    });
    if (contentMatch) return contentMatch;
  }

  // No content match (ambiguous reply, or the author used the generic reply/no_reply
  // scaffold) — fall back to the structural "any reply" edge, same as before.
  const structural = edges.find((e) => REPLY_BRANCHES.includes(edgeBranch(e)));
  if (structural) return structural;
  return edges.find((e) => !edgeBranch(e)) || edges[0];
}

/**
 * Execute automation flow steps for an enrollment.
 */
class FlowExecutorService {
  /**
   * Run from current node until wait/end/failure or maxSteps.
   * @param {object} ctx
   * @param {{ reason: 'reply'|'timeout'|'elapsed' }} [ctx.resume] - set when resuming a parked wait node
   */
  async runEnrollment(ctx) {
    const { enrollment, flow, interaction, organizationId, dryRun = false } = ctx;
    const maxSteps = 25;
    let steps = 0;
    let currentId = enrollment.currentNodeId;
    let status = enrollment.status;
    let nextRunAt = enrollment.nextRunAt;
    let lastError = enrollment.lastError || '';
    let resume = ctx.resume || null;
    let converted = false;
    const history = [...(enrollment.history || [])];
    const variables = { ...(enrollment.variables || {}) };

    const nodeMap = new Map((flow.nodes || []).map((n) => [n.id, n]));
    const edgesFrom = (id) => (flow.edges || []).filter((e) => e.source === id);

    // Cycle guard: `control.jump` can point anywhere in the graph, including back to an
    // already-executed node. Without this, a jump loop could re-run a `send_text`/`send_media`
    // node several times before maxSteps (25) is hit — resending the same message to the
    // customer. Scoped to THIS single runEnrollment() call only: a legitimately parked
    // wait.user_reply node breaks out of the loop (status 'waiting') and resumes later via a
    // brand-new call with a fresh visited set, so normal wait/resume flows are unaffected.
    const visitedNodeIds = new Set();

    while (currentId && steps < maxSteps && status === 'active') {
      steps += 1;
      const node = nodeMap.get(currentId);
      if (!node) {
        status = 'failed';
        lastError = `Node not found: ${currentId}`;
        break;
      }

      if (isTriggerType(node.type)) {
        const out = edgesFrom(node.id);
        currentId = out[0]?.target || null;
        history.push({ nodeId: node.id, event: 'trigger_pass', at: new Date() });
        continue;
      }

      // Author-disabled node: pass straight through without executing.
      if (node.config?.__disabled === true) {
        const out = edgesFrom(node.id);
        history.push({ nodeId: node.id, event: 'skipped_disabled', at: new Date() });
        currentId = out[0]?.target || null;
        resume = null;
        if (!currentId) status = 'completed';
        continue;
      }

      // Resuming a parked wait node: the wait is satisfied — branch past it instead of re-waiting.
      if (resume && node.type.startsWith('wait.')) {
        // `interaction` is the fresh inbound reply when resume.reason === 'reply'
        // (set by flowTriggerRouter.resumeOnReply), so its content is safe to use
        // for answer-text branch matching. On a timeout resume it's the original
        // trigger interaction, but resolveWaitEdge ignores replyText for timeouts.
        const edge = resolveWaitEdge(edgesFrom(node.id), node.type, resume.reason, interaction?.content);
        history.push({ nodeId: node.id, event: `wait_resumed:${resume.reason || 'elapsed'}`, at: new Date() });
        resume = null;
        currentId = edge?.target || null;
        if (!currentId) status = 'completed';
        continue;
      }
      resume = null;

      // About to actually execute (not just pass through) this node. If we've already
      // executed it once in this same pass, a control.jump has looped back to it — stop
      // now, BEFORE calling the handler again, so any send/order/webhook side effect it has
      // cannot fire a second time for this one inbound message.
      if (visitedNodeIds.has(node.id)) {
        status = 'failed';
        lastError = `Flow loop detected at "${node.label || node.id}" — a control.jump revisits an already-executed node. Fix the jump target to avoid resending messages.`;
        history.push({ nodeId: node.id, event: 'loop_detected_stopped', at: new Date() });
        logger.warn('[FlowExecutor] loop detected — stopping before re-execution', {
          nodeId: node.id, flowId: String(flow._id), enrollmentId: String(enrollment._id)
        });
        break;
      }
      visitedNodeIds.add(node.id);

      history.push({ nodeId: node.id, event: 'execute', at: new Date() });

      try {
        const result = await executeNodeHandler({
          node,
          enrollment: { ...enrollment.toObject?.() || enrollment, variables },
          flow,
          interaction,
          organizationId,
          dryRun,
          edges: edgesFrom(node.id)
        });

        if (result.variables) Object.assign(variables, result.variables);
        if (result.converted) converted = true;

        // Non-fatal warnings (ai_reply failure, http_request timeout, etc.)
        // are recorded in history but do NOT stop the flow.
        if (result.warning) {
          history.push({ nodeId: node.id, event: 'warning', note: result.warning, at: new Date() });
          lastError = result.warning; // surface in UI without failing the enrollment
        }

        if (result.status === 'waiting') {
          status = 'waiting';
          nextRunAt = result.nextRunAt || new Date(Date.now() + (result.delaySec || 60) * 1000);
          currentId = node.id;
          break;
        }

        if (result.status === 'completed') {
          status = 'completed';
          currentId = null;
          break;
        }

        if (result.status === 'failed') {
          status = 'failed';
          lastError = result.error || 'Node execution failed';
          break;
        }

        currentId = result.nextNodeId ?? null;
        if (!currentId) {
          status = 'completed';
        }
      } catch (err) {
        if (err.fatal) {
          logger.error('[FlowExecutor] fatal node error — enrollment failed', { nodeId: node.id, error: err.message });
          status = 'failed';
          lastError = `[FATAL] ${err.message}`;
        } else {
          logger.error('[FlowExecutor] node error', { nodeId: node.id, error: err.message });
          status = 'failed';
          lastError = err.message;
        }
        break;
      }
    }

    if (steps >= maxSteps && status === 'active') {
      status = 'failed';
      lastError = 'Max execution steps exceeded';
    }

    return {
      currentNodeId: currentId || '',
      status,
      nextRunAt: status === 'waiting' ? nextRunAt : null,
      lastError,
      history,
      variables,
      converted
    };
  }

  /** First node after trigger edge. */
  getStartNodeId(flow) {
    const trigger = (flow.nodes || []).find((n) => isTriggerType(n.type));
    if (!trigger) return flow.entryNodeId || null;
    const edge = (flow.edges || []).find((e) => e.source === trigger.id);
    return edge?.target || flow.entryNodeId || null;
  }
}

module.exports = new FlowExecutorService();
