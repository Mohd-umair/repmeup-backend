/**
 * Fix Catalog sidebar menu when parentId points to a deleted/missing parent.
 * Clears parentId so Catalog is a top-level item under the Main sidebar section.
 *
 * Run: node scripts/fixCatalogMenuParent.js
 */
const mongoose = require('mongoose');
require('dotenv').config();

mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/orm');

const Menu = require('../src/models/Menu');

async function run() {
  try {
    const catalog = await Menu.findOne({ route: '/app/catalog' });
    if (!catalog) {
      console.log('No Catalog menu found — run scripts/addCatalogMenu.js first.');
      return;
    }

    const parentExists = catalog.parentId
      ? await Menu.exists({ _id: catalog.parentId, isActive: true })
      : null;

    if (!catalog.parentId && catalog.group === 'main') {
      console.log('✅ Catalog is already a top-level Main menu item. Nothing to fix.');
      return;
    }

    if (parentExists) {
      console.log('✅ Catalog parent is valid. Nothing to fix.');
      return;
    }

    catalog.parentId = undefined;
    catalog.group = 'main';
    catalog.order = catalog.order || 13;
    await catalog.save();
    console.log('✅ Catalog is now a top-level item under Main (parentId cleared).');
  } catch (err) {
    console.error('❌ Error:', err.message);
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
  }
}

run();
