/**
 * Seed global AutomationFlow blueprints for the unified Flow Builder.
 * Run: npm run seed:flow-blueprints
 */
require('dotenv').config();
const mongoose = require('mongoose');
const AutomationFlow = require('../src/models/AutomationFlow');

const connectDB = async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('MongoDB connected');
};

function node(id, type, label, x, y, config = {}, channels = []) {
  return { id, type, label, position: { x, y }, config, supportedChannels: channels };
}

function e(id, source, target, label = '') {
  return { id, source, target, label };
}

const BLUEPRINTS = [
  {
    name: 'Comment-to-DM + Sales',
    description: 'Convert Instagram comments into DMs with keyword matching and product details.',
    channels: ['instagram'],
    nodes: [
      node('t1', 'trigger.ig_comment', 'IG comment', 60, 100, { keywords: ['price', 'buy', 'order'] }, ['instagram']),
      node('c1', 'condition.keyword_match', 'Keyword match', 280, 100, { keywords: ['price', 'buy', 'order'] }, ['instagram']),
      node('a1', 'action.reply_public_comment', 'Public reply', 500, 60, { text: 'Hi {{username}}! Check your DM for details.' }, ['instagram']),
      node('a2', 'action.send_text', 'Product DM', 500, 180, { text: 'Thanks for your interest! Here are the details…' }, ['instagram']),
      node('x1', 'control.end', 'End', 720, 120, {}, ['instagram'])
    ],
    edges: [e('e1', 't1', 'c1'), e('e2', 'c1', 'a1', 'match'), e('e3', 'c1', 'a2', 'match'), e('e4', 'a1', 'x1'), e('e5', 'a2', 'x1')],
    entryNodeId: 't1'
  },
  {
    name: 'Story-to-DM',
    description: 'Auto-reply when someone responds to your Instagram story.',
    channels: ['instagram'],
    nodes: [
      node('t1', 'trigger.ig_story_reply', 'Story reply', 80, 120, {}, ['instagram']),
      node('a1', 'action.send_generic_template', 'Welcome card', 340, 120, { title: 'Thanks for replying!', subtitle: 'Tap below to shop.', imageUrl: '' }, ['instagram']),
      node('x1', 'control.end', 'End', 600, 120, {}, ['instagram'])
    ],
    edges: [e('e1', 't1', 'a1'), e('e2', 'a1', 'x1')],
    entryNodeId: 't1'
  },
  {
    name: 'Follow Invite',
    description: 'Send a follow CTA when users comment on your posts.',
    channels: ['instagram'],
    nodes: [
      node('t1', 'trigger.ig_comment', 'Comment', 80, 100, {}, ['instagram']),
      node('a1', 'action.send_generic_template', 'Follow card', 340, 100, { title: 'Thanks for commenting!', subtitle: 'Follow us for updates.', buttons: [{ label: 'Follow us', type: 'web_url', url: '' }] }, ['instagram']),
      node('x1', 'control.end', 'End', 600, 100, {}, ['instagram'])
    ],
    edges: [e('e1', 't1', 'a1'), e('e2', 'a1', 'x1')],
    entryNodeId: 't1'
  },
  {
    name: 'WhatsApp Appointment',
    description: 'Keyword-triggered WhatsApp flow for booking appointments.',
    channels: ['whatsapp'],
    nodes: [
      node('t1', 'trigger.keyword', 'Keyword', 60, 100, { keywords: ['book', 'appointment', 'schedule'] }, ['whatsapp']),
      node('a1', 'action.send_text', 'Ask date', 300, 100, { text: 'Great! What date works for you?' }, ['whatsapp']),
      node('w1', 'wait.user_reply', 'Wait reply', 540, 100, { timeoutSec: 86400 }, ['whatsapp']),
      node('a2', 'action.send_text', 'Confirm', 780, 100, { text: 'Your appointment is noted. We will confirm shortly.' }, ['whatsapp']),
      node('x1', 'control.end', 'End', 1020, 100, {}, ['whatsapp'])
    ],
    edges: [e('e1', 't1', 'a1'), e('e2', 'a1', 'w1'), e('e3', 'w1', 'a2'), e('e4', 'a2', 'x1')],
    entryNodeId: 't1'
  },
  {
    name: 'WhatsApp Order Review',
    description: 'Request a review after order delivery on WhatsApp.',
    channels: ['whatsapp'],
    nodes: [
      node('t1', 'trigger.order_event', 'Order delivered', 80, 100, { event: 'delivered' }, ['whatsapp']),
      node('w1', 'wait.delay', 'Wait 2 days', 320, 100, { seconds: 172800 }, ['whatsapp']),
      node('a1', 'action.send_template', 'Review request', 560, 100, { templateId: '', variables: {} }, ['whatsapp']),
      node('x1', 'control.end', 'End', 800, 100, {}, ['whatsapp'])
    ],
    edges: [e('e1', 't1', 'w1'), e('e2', 'w1', 'a1'), e('e3', 'a1', 'x1')],
    entryNodeId: 't1'
  },
  {
    name: 'Retargeting Sequence',
    description: 'Multi-step follow-up for leads who did not convert.',
    channels: ['whatsapp', 'instagram'],
    nodes: [
      node('t1', 'trigger.new_lead', 'New lead', 60, 120, {}, ['whatsapp', 'instagram']),
      node('w1', 'wait.delay', 'Wait 1 day', 280, 120, { seconds: 86400 }, ['whatsapp', 'instagram']),
      node('a1', 'action.send_text', 'Follow-up 1', 500, 80, { text: 'Still interested? Here is a reminder.' }, ['whatsapp', 'instagram']),
      node('w2', 'wait.delay', 'Wait 3 days', 720, 120, { seconds: 259200 }, ['whatsapp', 'instagram']),
      node('a2', 'action.send_text', 'Follow-up 2', 940, 120, { text: 'Last chance — reply if you need help.' }, ['whatsapp', 'instagram']),
      node('x1', 'control.end', 'End', 1160, 120, {}, ['whatsapp', 'instagram'])
    ],
    edges: [e('e1', 't1', 'w1'), e('e2', 'w1', 'a1'), e('e3', 'a1', 'w2'), e('e4', 'w2', 'a2'), e('e5', 'a2', 'x1')],
    entryNodeId: 't1'
  },
  {
    name: 'AI-First Reply',
    description: 'Instant AI reply with human escalation fallback.',
    channels: ['whatsapp', 'instagram', 'facebook'],
    nodes: [
      node('t1', 'trigger.ig_dm', 'Inbound message', 80, 100, {}, ['instagram', 'whatsapp', 'facebook']),
      node('a1', 'action.ai_reply', 'AI reply', 340, 100, { tone: 'friendly' }, ['instagram', 'whatsapp', 'facebook']),
      node('c1', 'condition.sentiment', 'Negative?', 600, 100, { value: 'negative' }, ['instagram', 'whatsapp', 'facebook']),
      node('a2', 'action.escalate_human', 'Escalate', 860, 60, { reason: 'Negative sentiment' }, ['instagram', 'whatsapp', 'facebook']),
      node('x1', 'control.end', 'End', 860, 160, {}, ['instagram', 'whatsapp', 'facebook'])
    ],
    edges: [e('e1', 't1', 'a1'), e('e2', 'a1', 'c1'), e('e3', 'c1', 'a2', 'negative'), e('e4', 'c1', 'x1', 'default'), e('e5', 'a2', 'x1')],
    entryNodeId: 't1'
  },
  {
    name: 'Abandoned Cart',
    description: 'Remind customers who left items in cart via WhatsApp.',
    channels: ['whatsapp'],
    nodes: [
      node('t1', 'trigger.webhook', 'Cart abandoned', 80, 100, { secret: '' }, ['whatsapp']),
      node('w1', 'wait.delay', 'Wait 1 hour', 320, 100, { seconds: 3600 }, ['whatsapp']),
      node('a1', 'action.send_text', 'Reminder', 560, 100, { text: 'You left items in your cart. Complete your order here.' }, ['whatsapp']),
      node('x1', 'control.end', 'End', 800, 100, {}, ['whatsapp'])
    ],
    edges: [e('e1', 't1', 'w1'), e('e2', 'w1', 'a1'), e('e3', 'a1', 'x1')],
    entryNodeId: 't1'
  },
  {
    name: 'First Message Welcome',
    description: 'Greet new WhatsApp contacts on their first message.',
    channels: ['whatsapp'],
    nodes: [
      node('t1', 'trigger.first_message', 'First message', 80, 100, {}, ['whatsapp']),
      node('a1', 'action.send_text', 'Welcome', 340, 100, { text: 'Welcome! How can we help you today?' }, ['whatsapp']),
      node('x1', 'control.end', 'End', 600, 100, {}, ['whatsapp'])
    ],
    edges: [e('e1', 't1', 'a1'), e('e2', 'a1', 'x1')],
    entryNodeId: 't1'
  }
];

async function seed() {
  await connectDB();
  let created = 0;
  let updated = 0;

  for (const bp of BLUEPRINTS) {
    const existing = await AutomationFlow.findOne({ isBlueprint: true, organization: null, name: bp.name });
    const doc = {
      organization: null,
      name: bp.name,
      description: bp.description,
      channels: bp.channels,
      nodes: bp.nodes,
      edges: bp.edges,
      entryNodeId: bp.entryNodeId,
      status: 'draft',
      version: 1,
      isBlueprint: true
    };
    if (existing) {
      await AutomationFlow.updateOne({ _id: existing._id }, { $set: doc });
      updated += 1;
    } else {
      await AutomationFlow.create(doc);
      created += 1;
    }
  }

  console.log(`Flow blueprints: ${created} created, ${updated} updated (${BLUEPRINTS.length} total).`);
  await mongoose.disconnect();
}

seed().catch((err) => {
  console.error(err);
  process.exit(1);
});
