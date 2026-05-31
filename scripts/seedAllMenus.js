/**
 * Full menu reseed — restores all sidebar menus.
 *   node scripts/seedAllMenus.js
 *   node scripts/seedAllMenus.js --force
 */
const mongoose = require('mongoose');
require('dotenv').config();

const Menu = require('../src/models/Menu');
const {
  DEFAULT_SUBMENU_PACKS,
  TOP_LEVEL_MENUS,
  AUTOMATION_MENUS,
  CAMPAIGNS_MENUS
} = require('./lib/seedAllMenusData');

const force = process.argv.includes('--force');

async function attachSubmenus(parentRoute, parents) {
  const pack = DEFAULT_SUBMENU_PACKS.find((p) => p.parentRoute === parentRoute);
  if (!pack) return [];
  const parent = parents.find((m) => m.route === parentRoute);
  if (!parent) return [];
  return Menu.insertMany(
    pack.children.map((c) => ({ ...c, group: parent.group || 'main', parentId: parent._id, isActive: true }))
  );
}

async function run() {
  try {
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/orm');

    const count = await Menu.countDocuments();
    if (count > 0 && !force) {
      console.log(`⚠️  ${count} menu(s) exist. Use --force to wipe and reseed.`);
      return;
    }
    if (force && count > 0) {
      await Menu.deleteMany({});
      console.log(`🗑  Deleted ${count} menu(s).`);
    }

    const topLevel = await Menu.insertMany(TOP_LEVEL_MENUS);
    const automation = await Menu.insertMany(AUTOMATION_MENUS.map((m) => ({ ...m, isActive: true })));
    const campaigns = await Menu.insertMany(CAMPAIGNS_MENUS.map((m) => ({ ...m, isActive: true })));

    let submenus = 0;
    for (const pack of DEFAULT_SUBMENU_PACKS) {
      const created = await attachSubmenus(pack.parentRoute, topLevel);
      submenus += created.length;
    }

    const total = await Menu.countDocuments();
    console.log(`✅ Reseeded ${total} menus (${topLevel.length} top + ${automation.length} automation + ${campaigns.length} campaigns + ${submenus} submenus).`);
  } catch (err) {
    console.error('❌ Error:', err.message);
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
  }
}

run();
