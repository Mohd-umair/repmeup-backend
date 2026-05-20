/**
 * One-time migration: insert the "WhatsApp Campaigns" sidebar item.
 * Run with: node scripts/addCampaignsMenu.js
 */
const mongoose = require('mongoose');
require('dotenv').config();

mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/orm');

const Menu = require('../src/models/Menu');

const ITEMS = [
  {
    label: 'WhatsApp Campaigns',
    icon: 'fab fa-whatsapp',
    route: '/app/campaigns',
    order: 30,
    group: 'campaigns',
    requiredPermissions: ['settings.read'],
    description: 'Send broadcast campaigns to your audience using approved WhatsApp templates'
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
    console.log('\n✅ Campaigns menu migration complete.');
  } catch (err) {
    console.error('❌ Error:', err.message);
  } finally {
    await mongoose.disconnect();
  }
}

run();
