/**
 * Backfill: create CRM Leads from historical ContactInquiry (website contact
 * form + demo bookings) and GrowthAudit lead captures.
 *
 * Idempotent — a source doc already present in a lead's captures is skipped,
 * and duplicate submitters (same email/phone) merge into one lead.
 *
 *   node src/scripts/backfillCrmLeads.js
 */
require('dotenv').config();
const mongoose = require('mongoose');

(async () => {
  const uri = process.env.MONGODB_URI;
  if (!uri) { console.error('MONGODB_URI not set'); process.exit(1); }
  await mongoose.connect(uri);

  const leadCaptureService = require('../services/crm/leadCaptureService');

  console.log('Backfilling CRM leads from ContactInquiry + GrowthAudit...');
  const counts = await leadCaptureService.backfill();
  console.log(
    `Done. created=${counts.created} merged=${counts.merged} skipped=${counts.skipped} error=${counts.error || 0}`
  );

  await mongoose.disconnect();
  process.exit(0);
})().catch((err) => {
  console.error('Backfill failed:', err);
  process.exit(1);
});
