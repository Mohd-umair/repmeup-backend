/**
 * Read-only diagnostic for the duplicate-flow-message investigation.
 * Does NOT modify any data. Prints:
 *   1. All active, non-blueprint flows per org that have a trigger.keyword node,
 *      grouped so overlapping keywords across flows are obvious.
 *   2. For flows with suspiciously high stats.triggered vs stats.completed,
 *      recent FlowEnrollment records grouped by (flow, platformUserId) so we can
 *      see whether duplicates are the SAME flow firing many times (webhook race)
 *      or MANY DIFFERENT flows firing once each (overlapping keywords).
 *   3. Any flow whose graph contains a control.jump edge that points backward
 *      to an already-visited node reachable from a trigger (potential infinite
 *      loop / repeated-send risk).
 *
 * Usage:
 *   node backend/scripts/diagnoseDuplicateFlow.js
 *   node backend/scripts/diagnoseDuplicateFlow.js --org=<organizationId>
 */
require('dotenv').config();
const mongoose = require('mongoose');
const AutomationFlow = require('../src/models/AutomationFlow');
const FlowEnrollment = require('../src/models/FlowEnrollment');

const orgArg = process.argv.find((a) => a.startsWith('--org='));
const ORG_FILTER = orgArg ? orgArg.split('=')[1] : null;

function extractKeywords(flow) {
  const out = [];
  for (const node of flow.nodes || []) {
    if (node.type === 'trigger.keyword') {
      out.push({ nodeId: node.id, keywords: (node.config?.keywords || []).map((k) => String(k).toLowerCase()) });
    }
  }
  return out;
}

function keywordsOverlap(a, b) {
  // Empty keyword list on trigger.keyword matches EVERYTHING (see flowTriggerRouter.matchesTrigger).
  if (a.length === 0 || b.length === 0) return true;
  return a.some((k1) => b.some((k2) => k1.includes(k2) || k2.includes(k1)));
}

/** Detect a control.jump edge/config that can revisit a node already reachable earlier in the graph (cycle). */
function findJumpCycles(flow) {
  const nodeMap = new Map((flow.nodes || []).map((n) => [n.id, n]));
  const edgesFrom = (id) => (flow.edges || []).filter((e) => e.source === id);
  const trigger = (flow.nodes || []).find((n) => n.type?.startsWith('trigger.'));
  if (!trigger) return [];

  const cycles = [];
  const visitedGlobal = new Set();

  function walk(nodeId, pathSet, depth) {
    if (depth > 50) return; // safety cap for the diagnostic itself
    if (pathSet.has(nodeId)) {
      cycles.push([...pathSet, nodeId].join(' -> '));
      return;
    }
    const node = nodeMap.get(nodeId);
    if (!node) return;
    const newPath = new Set(pathSet);
    newPath.add(nodeId);
    visitedGlobal.add(nodeId);

    if (node.type === 'control.jump') {
      const target = node.config?.targetNodeId;
      if (target) walk(target, newPath, depth + 1);
      return;
    }
    for (const edge of edgesFrom(nodeId)) {
      if (edge.target) walk(edge.target, newPath, depth + 1);
    }
  }

  walk(trigger.id, new Set(), 0);
  return cycles;
}

async function main() {
  if (!process.env.MONGODB_URI) {
    console.error('MONGODB_URI is not set');
    process.exit(1);
  }
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('[diagnose] connected to MongoDB\n');

  const query = { status: 'active', isBlueprint: false };
  if (ORG_FILTER) query.organization = ORG_FILTER;

  const flows = await AutomationFlow.find(query)
    .select('organization name status nodes edges stats channels')
    .lean();

  console.log(`[diagnose] ${flows.length} active, non-blueprint flow(s) found${ORG_FILTER ? ` for org ${ORG_FILTER}` : ' (all orgs)'}\n`);

  // Group by organization to compare keyword overlap within the same org.
  const byOrg = new Map();
  for (const f of flows) {
    const key = String(f.organization);
    if (!byOrg.has(key)) byOrg.set(key, []);
    byOrg.get(key).push(f);
  }

  console.log('========== 1. KEYWORD OVERLAP CHECK ==========');
  for (const [orgId, orgFlows] of byOrg) {
    const withKeywords = orgFlows
      .map((f) => ({ flow: f, triggers: extractKeywords(f) }))
      .filter((x) => x.triggers.length > 0);

    if (withKeywords.length < 2) continue; // need 2+ to overlap

    for (let i = 0; i < withKeywords.length; i++) {
      for (let j = i + 1; j < withKeywords.length; j++) {
        const A = withKeywords[i];
        const B = withKeywords[j];
        const sameChannel = (A.flow.channels || []).some((c) => (B.flow.channels || []).includes(c));
        if (!sameChannel) continue;

        for (const ta of A.triggers) {
          for (const tb of B.triggers) {
            if (keywordsOverlap(ta.keywords, tb.keywords)) {
              console.log(
                `OVERLAP  org=${orgId}\n` +
                `  Flow A: "${A.flow.name}" (${A.flow._id}) keywords=${JSON.stringify(ta.keywords)} triggered=${A.flow.stats?.triggered ?? 0} completed=${A.flow.stats?.completed ?? 0}\n` +
                `  Flow B: "${B.flow.name}" (${B.flow._id}) keywords=${JSON.stringify(tb.keywords)} triggered=${B.flow.stats?.triggered ?? 0} completed=${B.flow.stats?.completed ?? 0}\n`
              );
            }
          }
        }
      }
    }
  }

  console.log('\n========== 2. HIGH triggered-vs-completed RATIO (possible webhook race) ==========');
  for (const f of flows) {
    const triggered = f.stats?.triggered || 0;
    const completed = f.stats?.completed || 0;
    if (triggered > 5 && completed > 0) {
      console.log(`Flow "${f.name}" (${f._id}) org=${f.organization} triggered=${triggered} completed=${completed} failed=${f.stats?.failed ?? 0}`);
    }
  }

  console.log('\n========== 3. DUPLICATE ENROLLMENTS PER (flow, platformUserId) IN A SHORT WINDOW ==========');
  const dupWindowMs = 5 * 60 * 1000; // 5 minutes
  for (const f of flows) {
    const enrollments = await FlowEnrollment.find({ flow: f._id })
      .select('platformUserId createdAt status')
      .sort({ createdAt: 1 })
      .lean();
    if (enrollments.length < 2) continue;

    const byUser = new Map();
    for (const e of enrollments) {
      const key = e.platformUserId || 'unknown';
      if (!byUser.has(key)) byUser.set(key, []);
      byUser.get(key).push(e);
    }

    for (const [platformUserId, list] of byUser) {
      if (list.length < 2) continue;
      // Find clusters within dupWindowMs of each other.
      let clusterStart = 0;
      for (let k = 1; k <= list.length; k++) {
        const gap = k < list.length ? new Date(list[k].createdAt) - new Date(list[k - 1].createdAt) : Infinity;
        if (gap > dupWindowMs) {
          const clusterSize = k - clusterStart;
          if (clusterSize >= 3) {
            console.log(
              `Flow "${f.name}" (${f._id}) platformUserId=${platformUserId}: ${clusterSize} enrollments within ~5min ` +
              `(${list[clusterStart].createdAt.toISOString()} .. ${list[k - 1].createdAt.toISOString()}) — statuses=${list.slice(clusterStart, k).map((e) => e.status).join(',')}`
            );
          }
          clusterStart = k;
        }
      }
    }
  }

  console.log('\n========== 4. control.jump CYCLE CHECK ==========');
  for (const f of flows) {
    const hasJump = (f.nodes || []).some((n) => n.type === 'control.jump');
    if (!hasJump) continue;
    const cycles = findJumpCycles(f);
    if (cycles.length) {
      console.log(`Flow "${f.name}" (${f._id}) org=${f.organization} has ${cycles.length} cycle path(s):`);
      cycles.forEach((c) => console.log('  ' + c));
    } else {
      console.log(`Flow "${f.name}" (${f._id}) has control.jump but no cycle back to itself (OK)`);
    }
  }

  await mongoose.disconnect();
  console.log('\n[diagnose] done');
}

main().catch((err) => {
  console.error('[diagnose] error', err);
  process.exit(1);
});
