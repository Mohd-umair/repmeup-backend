/**
 * One-time migration: insert the "Number Reports" item into the campaigns sidebar group.
 * Run with: node scripts/addReportsMenu.js
 */
const mongoose = require('mongoose');
require('dotenv').config();

mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/orm');

const Menu = require('../src/models/Menu');

const ITEM = {
  label: 'Number Reports',
  icon: 'fas fa-chart-bar',
  route: '/app/reports',
  order: 52,
  group: 'campaigns',
  requiredPermissions: ['analytics.read'],
  description: 'Per-number analytics: messages, campaigns, templates, sentiment'
};

async function run() {
  try {
    const existing = await Menu.findOne({ route: ITEM.route });
    if (existing) {
      console.log('✅ Number Reports menu item already exists — skipping.');
      return;
    }
    await Menu.create(ITEM);
    console.log('✅ Number Reports menu item inserted.');
  } catch (err) {
    console.error('❌ Error:', err.message);
  } finally {
    await mongoose.disconnect();
  }
}

run();
