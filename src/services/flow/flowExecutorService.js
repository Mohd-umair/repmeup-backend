const logger = require('../../config/logger');
const { isTriggerType } = require('../../config/flowNodeCatalog');
const { executeNodeHandler } = require('./flowNodeHandlers');

const TIMEOUT_BRANCHES = ['no_reply', 'timeout', 'expired', 'no'];
const REPLY_BRANCHES = ['reply', 'replied', 'yes', 'default'];

function edgeBranch(edge) {
  return String(edge?.label || edge?.condition?.branch || '').trim().toLowerCase();
}

/** Choose the outgoing edge for a resumed wait node based on why it resumed. */
function resolveWaitEdge(edges, nodeType, reason) {
  if (!edges?.length) return null;
  if (nodeType === 'wait.user_reply') {
    const wanted = reason === 'timeout' ? TIMEOUT_BRANCHES : REPLY_BRANCHES;
    const labeled = edges.find((e) => wanted.includes(edgeBranch(e)));
    if (labeled) return labeled;
    // Fallback by order: first edge = reply path, an edge labeled timeout = timeout path.
    if (reason === 'timeout') {
      return edges.find((e) => TIMEOUT_BRANCHES.includes(edgeBranch(e))) || edges[1] || edges[0];
    }
    return edges.find((e) => !edgeBranch(e)) || edges[0];
  }
  return edges[0];
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
        const edge = resolveWaitEdge(edgesFrom(node.id), node.type, resume.reason);
        history.push({ nodeId: node.id, event: `wait_resumed:${resume.reason || 'elapsed'}`, at: new Date() });
        resume = null;
        currentId = edge?.target || null;
        if (!currentId) status = 'completed';
        continue;
      }
      resume = null;

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
