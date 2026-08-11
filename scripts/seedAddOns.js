/**
 * Seed the purchasable add-on catalogue from src/config/addOnCatalog.js.
 *
 * Same pattern as seedFeatures.js: engineers define SKUs in a reviewed code change,
 * admins tune price and availability afterwards from the panel. Re-running refreshes
 * definitions and pricing but preserves `isActive` / `isPublic` toggles.
 *
 *   node scripts/seedAddOns.js
 *   node scripts/seedAddOns.js --dry-run
 */
require('dotenv').config();
const mongoose = require('mongoose');
const { ADD_ON_CATALOG } = require('../src/config/addOnCatalog');

const DRY_RUN = process.argv.includes('--dry-run');

/** Config carries whole rupees for readability; the DB stores paise. */
const toPaise = (rupees) => (rupees == null ? null : Math.round(Number(rupees) * 100));

function buildDoc(row) {
  return {
    name: row.name,
    description: row.description || '',
    quantityLabel: row.quantityLabel || 'units',
    grantUnit: row.grantUnit || null,
    perUnitLabel: row.perUnitLabel || null,
    kind: row.kind,
    grant: { featureKey: row.grant.featureKey, mode: row.grant.mode },
    displayOrder: row.displayOrder ?? 100,
    pricing: row.pricing.map((p) => ({
      planId: p.planId,
      priceInr: toPaise(p.amountRupees),
      grantAmount: p.grantAmount ?? null,
      minQuantity: p.minQuantity ?? 1,
      maxQuantity: p.maxQuantity ?? 1,
      minPriceInr: toPaise(p.minRupees),
      maxPriceInr: toPaise(p.maxRupees)
    }))
  };
}

(async () => {
  const uri = process.env.MONGODB_URI;
  if (!uri) { console.error('MONGODB_URI not set'); process.exit(1); }
  await mongoose.connect(uri);

  const AddOn = require('../src/models/AddOn');

  console.log(`\nSeeding add-on catalogue${DRY_RUN ? ' (DRY RUN)' : ''}\n`);

  let created = 0;
  let updated = 0;
  const needsConfig = [];

  for (const row of ADD_ON_CATALOG) {
    const doc = buildDoc(row);
    const existing = await AddOn.findOne({ addOnId: row.addOnId });

    if (!DRY_RUN) {
      await AddOn.findOneAndUpdate(
        { addOnId: row.addOnId },
        // isActive/isPublic are admin-owned once the row exists.
        { $set: doc, $setOnInsert: { addOnId: row.addOnId, isActive: true, isPublic: true } },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );
    }

    existing ? (updated += 1) : (created += 1);
    console.log(`  ${row.addOnId.padEnd(28)} ${existing ? 'updated' : 'created'}  (${row.kind})`);
    for (const p of doc.pricing) {
      const grant = p.grantAmount == null ? 'grantAmount NOT SET' : `+${p.grantAmount}`;
      console.log(`     ${p.planId.padEnd(10)} ₹${p.priceInr / 100} → ${grant}`);
      if (p.grantAmount == null) needsConfig.push(`${row.addOnId} / ${p.planId}`);
    }
  }

  console.log(`\n${created} created, ${updated} updated.`);

  if (needsConfig.length) {
    console.log('\n!  These SKUs are seeded but NOT purchasable — no grant amount is set:');
    for (const n of needsConfig) console.log(`     ${n}`);
    console.log('   The pricing sheet publishes the ₹ band for these, but not how much');
    console.log('   one unit buys. Set it in the admin add-ons screen before selling.');
  }

  await mongoose.disconnect();
  console.log('');
  process.exit(0);
})().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
