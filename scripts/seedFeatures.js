/**
 * Seed / refresh the Feature catalog from the canonical code-defined list.
 *
 *   node backend/scripts/seedFeatures.js
 *
 * Idempotent: each row is upserted by `key`. Existing labels/descriptions/units are
 * updated so admins always see fresh wording, but `active` flags are preserved.
 */

require('dotenv').config();
const mongoose = require('mongoose');
const Feature = require('../src/models/Feature');
const { CATALOG } = require('../src/config/featureCatalog');

async function connect() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('✅ MongoDB connected');
}

async function seedFeatures() {
  let upserted = 0;
  let updated = 0;

  for (const row of CATALOG) {
    const existing = await Feature.findOne({ key: row.key });
    if (!existing) {
      await Feature.create({ ...row, active: true });
      upserted += 1;
      continue;
    }
    Object.assign(existing, {
      label: row.label,
      description: row.description ?? existing.description ?? '',
      category: row.category,
      kind: row.kind,
      defaultValue: row.defaultValue,
      unit: row.unit ?? null,
      resetPeriod: row.resetPeriod || existing.resetPeriod || 'none',
      enumOptions: row.enumOptions || existing.enumOptions || [],
      sortOrder: row.sortOrder ?? existing.sortOrder ?? 100
    });
    await existing.save();
    updated += 1;
  }

  console.log(`✨ Feature catalog: ${upserted} created, ${updated} refreshed (total ${CATALOG.length}).`);
}

(async () => {
  try {
    await connect();
    await seedFeatures();
    process.exit(0);
  } catch (err) {
    console.error('❌ seedFeatures failed:', err);
    process.exit(1);
  }
})();
