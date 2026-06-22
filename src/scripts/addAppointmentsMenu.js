'use strict';

/**
 * Add the global "Appointments" sidebar menu item to an already-seeded install.
 *
 * Menus are GLOBAL (no per-org scoping) and `seedMenus` won't re-run once menus
 * exist, so new menu entries must be inserted with this idempotent one-off.
 *
 * Usage:  node src/scripts/addAppointmentsMenu.js
 */

require('dotenv').config();
const mongoose = require('mongoose');
const Menu = require('../models/Menu');
const logger = require('../config/logger');

const APPOINTMENTS_MENU = {
  label: 'Appointments',
  icon: 'fas fa-calendar-check',
  route: '/app/appointments',
  order: 7,
  group: 'management',
  requiredRoles: ['admin', 'manager'],
  isActive: true
};

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  try {
    const existing = await Menu.findOne({ route: APPOINTMENTS_MENU.route });
    if (existing) {
      // Keep it visible/correct if it was previously disabled or mis-grouped.
      await Menu.updateOne({ _id: existing._id }, {
        $set: { isActive: true, group: 'management', label: 'Appointments', icon: APPOINTMENTS_MENU.icon }
      });
      console.log(`✓ Appointments menu already present → ${existing._id} (ensured active)`);
    } else {
      const created = await Menu.create(APPOINTMENTS_MENU);
      console.log(`✓ Appointments menu created → ${created._id}`);
    }
    console.log('Done. Reload the app (hard refresh) — it appears under "Management" for admin/manager.');
  } catch (err) {
    logger.error('[addAppointmentsMenu] failed', { error: err.message });
    console.error('ERROR:', err.message);
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
  }
})();
