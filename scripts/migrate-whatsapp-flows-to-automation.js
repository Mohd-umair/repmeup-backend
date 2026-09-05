/**
 * One-time migration: WhatsAppFlow → AutomationFlow (draft copies per org).
 * Run: npm run migrate:wa-flows [--dry-run] [--org=<organizationId>]
 */
require('dotenv').config();
const mongoose = require('mongoose');
const WhatsAppFlow = require('../src/models/WhatsAppFlow');
const AutomationFlow = require('../src/models/AutomationFlow');

const TRIGGER_MAP = {
  keyword: 'trigger.keyword',
  first_message: 'trigger.first_message',
  new_lead: 'trigger.new_lead',
  manual: 'trigger.manual',
  webhook: 'trigger.webhook',
  appointment: 'trigger.keyword',
  order: 'trigger.order_event'
};

function mapTrigger(waFlow) {
  const t = waFlow.trigger?.type || 'keyword';
  const type = TRIGGER_MAP[t] || 'trigger.keyword';
  const config = {};
  if (type === 'trigger.keyword') config.keywords = waFlow.trigger?.value ? [waFlow.trigger.value] : [];
  if (type === 'trigger.order_event') config.event = 'created';
  return {
    id: 'trigger_1',
    type,
    label: 'Trigger',
    position: { x: 80, y: 100 },
    config,
    supportedChannels: ['whatsapp']
  };
}

function mapStepsToNodes(steps = []) {
  return steps.map((step, i) => {
    const id = `step_${i + 1}`;
    const type = step.templateId ? 'action.send_template' : 'action.send_text';
    const config = step.templateId
      ? { templateId: String(step.templateId), variables: {} }
      : { text: step.messageText || '' };
    return {
      id,
      type,
      label: step.label || `Step ${i + 1}`,
      position: { x: 80 + (i + 1) * 220, y: 100 },
      config,
      supportedChannels: ['whatsapp']
    };
  });
}

function mapEdges(triggerNode, stepNodes) {
  const edges = [];
  if (!stepNodes.length) return edges;
  edges.push({ id: 'edge_trigger_1', source: triggerNode.id, target: stepNodes[0].id, label: '' });
  for (let i = 0; i < stepNodes.length - 1; i += 1) {
    edges.push({
      id: `edge_${stepNodes[i].id}_${stepNodes[i + 1].id}`,
      source: stepNodes[i].id,
      target: stepNodes[i + 1].id,
      label: ''
    });
  }
  const last = stepNodes[stepNodes.length - 1];
  const endId = 'end_1';
  edges.push({ id: `edge_${last.id}_end`, source: last.id, target: endId, label: '' });
  return edges;
}

function convertWaFlow(waFlow) {
  const triggerNode = mapTrigger(waFlow);
  const stepNodes = mapStepsToNodes(waFlow.steps || []);
  const endNode = {
    id: 'end_1',
    type: 'control.end',
    label: 'End',
    position: { x: 80 + (stepNodes.length + 1) * 220, y: 100 },
    config: {},
    supportedChannels: ['whatsapp']
  };
  const nodes = [triggerNode, ...stepNodes, endNode];
  const edges = mapEdges(triggerNode, stepNodes);
  return {
    organization: waFlow.organization,
    createdBy: waFlow.createdBy,
    name: waFlow.name,
    description: waFlow.description || `Migrated from WhatsApp Flow ${waFlow._id}`,
    channels: ['whatsapp'],
    status: waFlow.status === 'active' ? 'paused' : waFlow.status,
    version: 1,
    entryNodeId: triggerNode.id,
    nodes,
    edges,
    stats: waFlow.stats || {},
    isBlueprint: false
  };
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const orgArg = process.argv.find((a) => a.startsWith('--org='));
  const orgFilter = orgArg ? orgArg.split('=')[1] : null;

  await mongoose.connect(process.env.MONGODB_URI);
  console.log('MongoDB connected');

  const filter = { isBlueprint: { $ne: true } };
  if (orgFilter) filter.organization = orgFilter;

  const waFlows = await WhatsAppFlow.find(filter).lean();
  console.log(`Found ${waFlows.length} WhatsApp flow(s) to migrate.`);

  let migrated = 0;
  let skipped = 0;

  for (const wa of waFlows) {
    const exists = await AutomationFlow.findOne({
      organization: wa.organization,
      name: wa.name,
      description: { $regex: /Migrated from WhatsApp Flow/ }
    }).lean();

    if (exists) {
      skipped += 1;
      continue;
    }

    const payload = convertWaFlow(wa);
    if (dryRun) {
      console.log(`[dry-run] Would migrate: ${wa.name} (${wa._id}) → ${payload.nodes.length} nodes`);
    } else {
      await AutomationFlow.create(payload);
      console.log(`Migrated: ${wa.name} (${wa._id})`);
    }
    migrated += 1;
  }

  console.log(`Done. Migrated: ${migrated}, skipped (already exists): ${skipped}${dryRun ? ' (dry-run)' : ''}.`);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
