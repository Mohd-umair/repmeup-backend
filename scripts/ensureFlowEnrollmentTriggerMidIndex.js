/**
 * One-time / idempotent: ensure the new partial-unique index on FlowEnrollment
 * ({ flow, platformUserId, triggerMid }) exists in production without waiting for
 * a full app restart (Mongoose auto-creates indexes on connect, but running this
 * explicitly lets us confirm it succeeded right away and see any conflicts).
 *
 * Safe to run any time — creating an index that already exists is a no-op, and the
 * partial filter (`triggerMid` must be a string) means no legacy document (none of
 * which have `triggerMid` yet) can violate it.
 *
 * Usage: node backend/scripts/ensureFlowEnrollmentTriggerMidIndex.js
 */
require('dotenv').config();
const mongoose = require('mongoose');
const FlowEnrollment = require('../src/models/FlowEnrollment');

async function main() {
  if (!process.env.MONGODB_URI) {
    console.error('MONGODB_URI is not set');
    process.exit(1);
  }
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('[ensure-index] connected — creating indexes for FlowEnrollment...');
  // createIndexes() (not syncIndexes()) — additive only, never drops an existing index.
  await FlowEnrollment.createIndexes();
  const indexes = await FlowEnrollment.collection.indexes();
  console.log('[ensure-index] current indexes:');
  indexes.forEach((idx) => console.log(' -', idx.name, JSON.stringify(idx.key), idx.unique ? '(unique)' : '', idx.partialFilterExpression ? JSON.stringify(idx.partialFilterExpression) : ''));
  await mongoose.disconnect();
  console.log('[ensure-index] done');
}

main().catch((err) => {
  console.error('[ensure-index] error', err);
  process.exit(1);
});
