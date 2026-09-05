/**
 * One-time migration: insert "Bucket Board" sidebar menu (separate from Inbox list).
 * Run with: node scripts/addBucketInboxMenu.js
 */
const mongoose = require('mongoose');
require('dotenv').config();

mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/orm');

const Menu = require('../src/models/Menu');

async function run() {
  try {
    const existing = await Menu.findOne({ route: '/app/inbox/buckets' });
    if (existing) {
      console.log('✅ Bucket Board menu item already exists. Nothing to do.');
      return;
    }

    await Menu.create({
      label: 'Bucket Board',
      icon: 'fas fa-columns',
      route: '/app/inbox/buckets',
      order: 4,
      group: 'main',
      requiredRoles: ['admin', 'manager', 'agent'],
      requiredPermissions: ['inbox.read'],
      isActive: true,
      description: 'Intent bucket kanban board for conversations'
    });

    console.log('✅ Bucket Board menu item added successfully.');
  } catch (err) {
    console.error('❌ Error:', err.message);
  } finally {
    await mongoose.disconnect();
  }
}

run();
