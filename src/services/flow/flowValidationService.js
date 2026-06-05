const { getNodeDef, isTriggerType } = require('../../config/flowNodeCatalog');

/**
 * Validate automation flow graph before save/publish.
 */
class FlowValidationService {
  validate(flow) {
    const errors = [];
    const nodes = flow.nodes || [];
    const edges = flow.edges || [];
    const nodeIds = new Set(nodes.map((n) => n.id));

    if (!flow.name?.trim()) {
      errors.push({ code: 'NAME_REQUIRED', message: 'Flow name is required.' });
    }

    if (!Array.isArray(flow.channels) || flow.channels.length === 0) {
      errors.push({ code: 'CHANNELS_REQUIRED', message: 'At least one channel is required.' });
    }

    const triggers = nodes.filter((n) => isTriggerType(n.type));
    if (triggers.length === 0) {
      errors.push({ code: 'NO_TRIGGER', message: 'Flow must have at least one trigger node.' });
    }
    if (triggers.length > 1) {
      errors.push({ code: 'MULTIPLE_TRIGGERS', message: 'Flow should have exactly one trigger node.' });
    }

    for (const node of nodes) {
      const def = getNodeDef(node.type);
      if (!def) {
        errors.push({ code: 'UNKNOWN_NODE', nodeId: node.id, message: `Unknown node type: ${node.type}` });
        continue;
      }
      const ch = flow.channels || [];
      if (!def.supportedChannels.some((c) => ch.includes(c))) {
        errors.push({
          code: 'CHANNEL_MISMATCH',
          nodeId: node.id,
          message: `Node "${node.label || node.type}" is not supported on selected channels.`
        });
      }
      for (const field of def.configFields || []) {
        if (field.required && !this._hasConfig(node.config, field.key)) {
          errors.push({
            code: 'CONFIG_REQUIRED',
            nodeId: node.id,
            field: field.key,
            message: `${field.label || field.key} is required on node "${node.label || node.type}".`
          });
        }
      }
    }

    for (const edge of edges) {
      if (!nodeIds.has(edge.source)) {
        errors.push({ code: 'ORPHAN_EDGE', edgeId: edge.id, message: `Edge source "${edge.source}" not found.` });
      }
      if (!nodeIds.has(edge.target)) {
        errors.push({ code: 'ORPHAN_EDGE', edgeId: edge.id, message: `Edge target "${edge.target}" not found.` });
      }
    }

    if (this._hasCycle(nodes, edges)) {
      errors.push({ code: 'CYCLE', message: 'Flow graph contains a cycle (infinite loop).' });
    }

    const entryId = flow.entryNodeId || triggers[0]?.id;
    if (entryId && !nodeIds.has(entryId)) {
      errors.push({ code: 'INVALID_ENTRY', message: 'Entry node id does not exist in graph.' });
    }

    const reachable = this._reachableFrom(entryId, edges);
    const orphans = nodes.filter((n) => n.id !== entryId && !reachable.has(n.id) && !isTriggerType(n.type));
    if (orphans.length) {
      errors.push({
        code: 'UNREACHABLE_NODES',
        nodeIds: orphans.map((n) => n.id),
        message: `${orphans.length} node(s) are not reachable from the trigger.`
      });
    }

    return { valid: errors.length === 0, errors };
  }

  _hasConfig(config, key) {
    if (!config || config[key] === undefined || config[key] === null) return false;
    if (Array.isArray(config[key]) && config[key].length === 0) return false;
    if (typeof config[key] === 'string' && !config[key].trim()) return false;
    return true;
  }

  _hasCycle(nodes, edges) {
    const adj = new Map();
    for (const n of nodes) adj.set(n.id, []);
    for (const e of edges) {
      if (adj.has(e.source)) adj.get(e.source).push(e.target);
    }
    const visited = new Set();
    const stack = new Set();

    const dfs = (id) => {
      if (stack.has(id)) return true;
      if (visited.has(id)) return false;
      visited.add(id);
      stack.add(id);
      for (const next of adj.get(id) || []) {
        if (dfs(next)) return true;
      }
      stack.delete(id);
      return false;
    };

    for (const n of nodes) {
      if (dfs(n.id)) return true;
    }
    return false;
  }

  _reachableFrom(startId, edges) {
    const reachable = new Set();
    if (!startId) return reachable;
    const queue = [startId];
    while (queue.length) {
      const id = queue.shift();
      if (reachable.has(id)) continue;
      reachable.add(id);
      for (const e of edges) {
        if (e.source === id && !reachable.has(e.target)) queue.push(e.target);
      }
    }
    return reachable;
  }
}

module.exports = new FlowValidationService();
