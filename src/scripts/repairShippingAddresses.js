'use strict';

/**
 * Data repair: clear corrupted delivery addresses that are actually quick-reply
 * button titles (e.g. "✅ Yes, ship here") saved by the old flow before the
 * address-validation fix. Scrubs Contacts + CommerceOrders so the next order
 * routes to the "ask for address" path instead of re-confirming garbage.
 *
 * Idempotent. Scoped per organization.
 *   node src/scripts/repairShippingAddresses.js <orgId>
 *   node src/scripts/repairShippingAddresses.js --all
 */

require('dotenv').config();
const mongoose = require('mongoose');
const Contact = require('../models/Contact');
const CommerceOrder = require('../models/CommerceOrder');

// Conservative: only clear values that are clearly quick-reply button titles
// (the corruption we introduced), NOT merely incomplete addresses — so we never
// delete a real address a customer/agent entered.
const BUTTON_TITLES = [
  'yes, ship here', 'yes ship here', 'new address', 'use a new address',
  'use new address', 'ship here'
];
function isCorrupt(addr) {
  const t = String(addr || '').trim();
  if (!t) return false;
  const norm = t.toLowerCase().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();
  return BUTTON_TITLES.includes(norm);
}

async function repairOrg(orgId) {
  let contactsFixed = 0;
  let ordersFixed = 0;

  const contacts = await Contact.find({ organization: orgId, shippingAddress: { $ne: null } })
    .select('shippingAddress').lean();
  for (const c of contacts) {
    if (isCorrupt(c.shippingAddress)) {
      await Contact.updateOne({ _id: c._id }, { $unset: { shippingAddress: 1, shipping: 1, shippingUpdatedAt: 1 } });
      contactsFixed++;
    }
  }

  const orders = await CommerceOrder.find({ organization: orgId, shippingAddress: { $ne: null } })
    .select('shippingAddress shipping displayRef').lean();
  for (const o of orders) {
    const corruptFree = isCorrupt(o.shippingAddress);
    const corruptLine1 = o.shipping?.line1 && isCorrupt(o.shipping.line1);
    if (corruptFree || corruptLine1) {
      await CommerceOrder.updateOne({ _id: o._id }, { $unset: { shippingAddress: 1, shipping: 1 } });
      ordersFixed++;
      console.log(`    cleared bad address on ${o.displayRef || o._id} ("${String(o.shippingAddress).slice(0, 30)}")`);
    }
  }

  console.log(`  org ${orgId}: cleared ${contactsFixed} contact(s), ${ordersFixed} order(s)`);
  return { contactsFixed, ordersFixed };
}

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  try {
    const arg = process.argv[2];
    if (!arg) { console.error('Usage: node src/scripts/repairShippingAddresses.js <orgId> | --all'); process.exitCode = 1; return; }

    if (arg === '--all') {
      const Organization = require('../models/Organization');
      const orgs = await Organization.find({}).select('_id').lean();
      console.log(`Repairing ${orgs.length} organizations…`);
      for (const o of orgs) await repairOrg(o._id);
    } else {
      console.log('Repairing org', arg);
      await repairOrg(arg);
    }
    console.log('Done.');
  } catch (err) {
    console.error('ERROR:', err.message);
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
  }
})();
