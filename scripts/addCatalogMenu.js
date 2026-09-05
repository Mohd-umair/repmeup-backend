/**
 * One-time migration: insert the "Catalog" sidebar menu item if it does not yet exist.
 * Run with: node scripts/addCatalogMenu.js
 */
const mongoose = require('mongoose');
require('dotenv').config();

mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/orm');

const Menu = require('../src/models/Menu');

async function run() {
  try {
    const existing = await Menu.findOne({ route: '/app/catalog' });
    if (existing) {
      console.log('✅ Catalog menu item already exists. Nothing to do.');
      return;
    }

    await Menu.create({
      label: 'Catalog',
      icon: 'fas fa-store',
      route: '/app/catalog',
      order: 12,
      group: 'main',
      requiredRoles: ['admin', 'manager'],
      requiredPermissions: ['settings.read'],
      isActive: true,
      description: 'Manage products and Instagram comment-to-DM automation'
    });

    console.log('✅ Catalog menu item added successfully.');
  } catch (err) {
    console.error('❌ Error:', err.message);
  } finally {
    await mongoose.disconnect();
  }
}

run();
