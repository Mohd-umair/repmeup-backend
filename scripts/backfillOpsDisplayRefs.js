'use strict';

/**
 * Backfill ORD/CMP/REV display refs for existing records.
 * Usage: node scripts/backfillOpsDisplayRefs.js [--dry-run]
 */

require('dotenv').config();
const mongoose = require('mongoose');

const Organization = require('../src/models/Organization');
const CommerceOrder = require('../src/models/CommerceOrder');
const Interaction = require('../src/models/Interaction');
const { generateOpsRef } = require('../src/utils/opsRefHelper');

const DRY = process.argv.includes('--dry-run');

async function backfillOrders(orgId) {
  const missing = await CommerceOrder.find({
    organization: orgId,
    $or: [{ displayRef: { $exists: false } }, { displayRef: null }, { displayRef: '' }]
  })
    .select('_id')
    .lean();

  for (const row of missing) {
    const { number, displayRef } = await generateOpsRef(orgId, 'order');
    if (!DRY) {
      await CommerceOrder.updateOne({ _id: row._id }, { $set: { orderNumber: number, displayRef } });
    }
    console.log(`  order ${row._id} → ${displayRef}`);
  }
  return missing.length;
}

async function backfillComplaints(orgId) {
  const rows = await Interaction.find({
    organization: orgId,
    intent: 'complaint',
    $or: [
      { complaint: { $exists: false } },
      { 'complaint.displayRef': { $exists: false } },
      { 'complaint.displayRef': null },
      { 'complaint.displayRef': '' }
    ]
  })
    .select('_id content sentiment priority')
    .lean();

  for (const row of rows) {
    const { displayRef } = await generateOpsRef(orgId, 'complaint');
    const issueSummary = String(row.content || '').trim().substring(0, 280);
    const priority = row.sentiment === 'negative' ? 'high' : row.priority || 'medium';
    if (!DRY) {
      await Interaction.updateOne(
        { _id: row._id },
        {
          $set: {
            complaint: {
              displayRef,
              status: 'open',
              issueSummary: issueSummary || 'Customer complaint',
              priority,
              timeline: [{ event: 'Complaint raised (backfill)', at: new Date() }]
            },
            ...(priority === 'high' ? { priority: 'high' } : {})
          }
        }
      );
    }
    console.log(`  complaint ${row._id} → ${displayRef}`);
  }
  return rows.length;
}

async function backfillReviews(orgId) {
  const rows = await Interaction.find({
    organization: orgId,
    type: 'review',
    $or: [
      { 'metadata.reviewDisplayRef': { $exists: false } },
      { 'metadata.reviewDisplayRef': null },
      { 'metadata.reviewDisplayRef': '' }
    ]
  })
    .select('_id')
    .lean();

  for (const row of rows) {
    const { displayRef } = await generateOpsRef(orgId, 'review');
    if (!DRY) {
      await Interaction.updateOne(
        { _id: row._id },
        { $set: { 'metadata.reviewDisplayRef': displayRef } }
      );
    }
    console.log(`  review ${row._id} → ${displayRef}`);
  }
  return rows.length;
}

async function main() {
  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/orm');
  const orgs = await Organization.find({}).select('_id name').lean();
  let total = 0;

  for (const org of orgs) {
    console.log(`\nOrg: ${org.name} (${org._id})`);
    total += await backfillOrders(org._id);
    total += await backfillComplaints(org._id);
    total += await backfillReviews(org._id);
  }

  console.log(`\n${DRY ? '[dry-run] ' : ''}Done. ${total} record(s) processed.`);
  await mongoose.disconnect();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
