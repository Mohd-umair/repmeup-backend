/**
 * One-time migration: insert the "Automation" sidebar group with 7 child items.
 * Run with: node scripts/addAutomationMenu.js
 */
const mongoose = require('mongoose');
require('dotenv').config();

mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/orm');

const Menu = require('../src/models/Menu');

const ITEMS = [
  {
    label: 'Automation Hub',
    icon: 'fas fa-robot',
    route: '/app/automation',
    order: 20,
    group: 'automation',
    requiredPermissions: ['settings.read'],
    description: 'Automation dashboard — all your automations at a glance'
  },
  {
    label: 'AI Auto Replies',
    icon: 'fas fa-comment-dots',
    route: '/app/automation/ai-replies',
    order: 21,
    group: 'automation',
    requiredPermissions: ['settings.read'],
    description: 'Configure AI-powered auto replies across channels'
  },
  {
    label: 'Growth Automation',
    icon: 'fas fa-seedling',
    route: '/app/automation/growth',
    order: 22,
    group: 'automation',
    requiredPermissions: ['settings.read'],
    description: 'Comment-to-DM, Follow-Invite, and Sales Flow automations'
  },
  {
    label: 'WhatsApp Flows',
    icon: 'fab fa-whatsapp',
    route: '/app/automation/whatsapp-flows',
    order: 23,
    group: 'automation',
    requiredPermissions: ['settings.read'],
    description: 'Automate WhatsApp conversations with flows and templates'
  },
  {
    label: 'Review Collection',
    icon: 'fas fa-star',
    route: '/app/automation/reviews',
    order: 24,
    group: 'automation',
    requiredPermissions: ['settings.read'],
    description: 'Automatically request reviews after purchases or support'
  },
  {
    label: 'Retargeting',
    icon: 'fas fa-bullseye',
    route: '/app/automation/retargeting',
    order: 25,
    group: 'automation',
    requiredPermissions: ['settings.read'],
    description: 'Re-engage leads and customers with multi-channel campaigns'
  },
  {
    label: 'Human Escalation',
    icon: 'fas fa-headset',
    route: '/app/automation/escalation',
    order: 26,
    group: 'automation',
    requiredPermissions: ['settings.read'],
    description: 'Route complex conversations to the right human agent'
  }
];

async function run() {
  try {
    for (const item of ITEMS) {
      const existing = await Menu.findOne({ route: item.route });
      if (existing) {
        console.log(`✅ Already exists: ${item.label}`);
        continue;
      }
      await Menu.create({ ...item, isActive: true, requiredRoles: ['admin', 'manager'] });
      console.log(`✅ Created: ${item.label}`);
    }
    console.log('\n✅ Automation menu migration complete.');
  } catch (err) {
    console.error('❌ Error:', err.message);
  } finally {
    await mongoose.disconnect();
  }
}

run();
