/**
 * Seed / refresh the Feature catalog from the canonical code-defined list.
 *
 *   node backend/scripts/seedFeatures.js
 *
 * Idempotent: each row is upserted by `key`. Existing labels/descriptions/units are
 * updated so admins always see fresh wording, but `active` flags are preserved.
 *
 * Also migrates legacy lowercase feature keys (from old Feature schema) and
 * normalizes Plan.entitlements keys to canonical catalog casing.
 */

require('dotenv').config();
const mongoose = require('mongoose');
const Feature = require('../src/models/Feature');
const Plan = require('../src/models/Plan');
const { CATALOG, normalizeFeatureKeyForLookup } = require('../src/config/featureCatalog');

const LOWER_TO_CANONICAL = new Map(
  CATALOG.map((row) => [normalizeFeatureKeyForLookup(row.key), row.key])
);

async function connect() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('✅ MongoDB connected');
}

async function migrateFeatureKeyCasing() {
  const rows = await Feature.find({}).lean();
  let renamed = 0;
  let removed = 0;

  for (const row of rows) {
    const canonical = LOWER_TO_CANONICAL.get(normalizeFeatureKeyForLookup(row.key));
    if (!canonical || row.key === canonical) continue;

    const existingCanonical = await Feature.findOne({ key: canonical });
    if (existingCanonical && String(existingCanonical._id) !== String(row._id)) {
      await Feature.deleteOne({ _id: row._id });
      removed += 1;
      console.log(`  🗑️  Removed duplicate feature key ${row.key} (kept ${canonical})`);
      continue;
    }

    await Feature.updateOne({ _id: row._id }, { $set: { key: canonical } });
    renamed += 1;
    console.log(`  🔤 Renamed feature ${row.key} → ${canonical}`);
  }

  return { renamed, removed };
}

async function migratePlanEntitlementKeys() {
  const plans = await Plan.find({}).select('planId entitlements').lean();
  let updated = 0;

  for (const plan of plans) {
    const ent = plan.entitlements && typeof plan.entitlements === 'object' ? { ...plan.entitlements } : {};
    let changed = false;

    for (const [k, v] of Object.entries(ent)) {
      const canonical = LOWER_TO_CANONICAL.get(normalizeFeatureKeyForLookup(k));
      if (!canonical || k === canonical) continue;
      if (ent[canonical] === undefined) ent[canonical] = v;
      delete ent[k];
      changed = true;
    }

    if (changed) {
      await Plan.updateOne({ _id: plan._id }, { $set: { entitlements: ent } });
      updated += 1;
      console.log(`  📋 Normalized entitlements for plan "${plan.planId}"`);
    }
  }

  return updated;
}

async function seedFeatures() {
  let upserted = 0;
  let updated = 0;

  for (const row of CATALOG) {
    const existing = await Feature.findOne({
      $or: [{ key: row.key }, { key: normalizeFeatureKeyForLookup(row.key) }]
    });
    if (!existing) {
      await Feature.create({ ...row, active: true });
      upserted += 1;
      continue;
    }
    if (existing.key !== row.key) {
      existing.key = row.key;
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
      metering: row.metering,
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
    console.log('\n🔤 Migrating feature key casing…');
    const featureMigration = await migrateFeatureKeyCasing();
    console.log(`   ${featureMigration.renamed} renamed, ${featureMigration.removed} duplicates removed`);
    console.log('\n📋 Migrating plan entitlement keys…');
    const plansUpdated = await migratePlanEntitlementKeys();
    console.log(`   ${plansUpdated} plan(s) updated`);
    console.log('\n🌱 Seeding feature catalog…');
    await seedFeatures();
    process.exit(0);
  } catch (err) {
    console.error('❌ seedFeatures failed:', err);
    process.exit(1);
  }
})();
