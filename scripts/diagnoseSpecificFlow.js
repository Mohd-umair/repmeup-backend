/**
 * Deep, read-only diagnostic for ONE flow + ONE contact — no writes.
 * Usage: node backend/scripts/diagnoseSpecificFlow.js <flowId> <platformUserId>
 */
require('dotenv').config();
const mongoose = require('mongoose');
const AutomationFlow = require('../src/models/AutomationFlow');
const FlowEnrollment = require('../src/models/FlowEnrollment');
const Interaction = require('../src/models/Interaction');

const flowId = process.argv[2];
const platformUserId = process.argv[3];

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);

  const flow = await AutomationFlow.findById(flowId).lean();
  console.log('=== FLOW ===');
  console.log('name:', flow.name, '| status:', flow.status, '| channels:', flow.channels);
  console.log('stats:', JSON.stringify(flow.stats));
  console.log('nodes:', flow.nodes.map((n) => `${n.id}(${n.type})`).join(', '));
  console.log('edges:', flow.edges.map((e) => `${e.source}->${e.target}${e.label ? `[${e.label}]` : ''}`).join(', '));
  const triggerNodes = flow.nodes.filter((n) => n.type.startsWith('trigger.'));
  console.log('trigger nodes config:', JSON.stringify(triggerNodes.map((n) => ({ id: n.id, type: n.type, config: n.config }))));

  console.log('\n=== ALL ENROLLMENTS FOR THIS FLOW+CONTACT ===');
  const enrollments = await FlowEnrollment.find({ flow: flowId, platformUserId })
    .sort({ createdAt: 1 })
    .lean();
  for (const e of enrollments) {
    console.log(
      `id=${e._id} createdAt=${e.createdAt.toISOString()} updatedAt=${e.updatedAt.toISOString()} status=${e.status} ` +
      `currentNodeId=${e.currentNodeId} interaction=${e.interaction} variables=${JSON.stringify(e.variables)}`
    );
    console.log('  history:', JSON.stringify(e.history));
  }

  console.log('\n=== ALL ENROLLMENTS FOR THIS CONTACT ACROSS ALL FLOWS (same org) ===');
  const allOrgEnrollments = await FlowEnrollment.find({ organization: flow.organization, platformUserId })
    .sort({ createdAt: 1 })
    .lean();
  const flowIds = [...new Set(allOrgEnrollments.map((e) => String(e.flow)))];
  const flowNames = await AutomationFlow.find({ _id: { $in: flowIds } }).select('name status').lean();
  const nameMap = new Map(flowNames.map((f) => [String(f._id), `${f.name} (${f.status})`]));
  for (const e of allOrgEnrollments) {
    console.log(`flow=${nameMap.get(String(e.flow))} createdAt=${e.createdAt.toISOString()} status=${e.status} interaction=${e.interaction}`);
  }

  console.log('\n=== INTERACTION THREAD (incomingMessages around that time) ===');
  if (enrollments.length) {
    const interactionId = enrollments[0].interaction;
    const interaction = await Interaction.findById(interactionId).lean();
    if (interaction) {
      console.log('platformId:', interaction.platformId, '| lastMid:', interaction.metadata?.lastMid);
      const incoming = interaction.metadata?.incomingMessages || [];
      console.log(`incomingMessages count: ${incoming.length}`);
      incoming.slice(-15).forEach((m) => console.log(`  mid=${m.mid} text=${JSON.stringify(m.text).slice(0, 60)} ts=${m.timestamp}`));
    } else {
      console.log('No interaction doc found for id', interactionId);
    }
  }

  await mongoose.disconnect();
}

main().catch((err) => { console.error(err); process.exit(1); });
