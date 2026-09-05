/**
 * Seed the WhatsApp conversation rate card (India) from src/config/whatsappRates.js.
 *
 * Rates are effective-dated. Re-running with a CHANGED rate does not edit the old row —
 * it closes it (`effectiveTo = now`) and inserts a new one, so charges already billed
 * keep the rate they were billed at and history stays auditable.
 *
 *   node scripts/seedWhatsAppRates.js
 *   node scripts/seedWhatsAppRates.js --dry-run
 */
require('dotenv').config();
const mongoose = require('mongoose');
const { WHATSAPP_RATES_INR_PAISE } = require('../src/config/whatsappRates');

const DRY_RUN = process.argv.includes('--dry-run');
const COUNTRY = 'IN';

/**
 * Meta prices authentication the same as utility in India, and our config groups them
 * under one "Utility / authentication" row — so expand it into both categories.
 */
function expandCategories(row) {
  if (row.category === 'utility') return ['utility', 'authentication'];
  return [row.category];
}

(async () => {
  const uri = process.env.MONGODB_URI;
  if (!uri) { console.error('MONGODB_URI not set'); process.exit(1); }
  await mongoose.connect(uri);

  const WhatsAppRateCard = require('../src/models/WhatsAppRateCard');
  const now = new Date();

  console.log(`\nSeeding WhatsApp rate card (${COUNTRY})${DRY_RUN ? ' — DRY RUN' : ''}\n`);

  let created = 0;
  let unchanged = 0;
  let superseded = 0;

  for (const configRow of WHATSAPP_RATES_INR_PAISE) {
    for (const category of expandCategories(configRow)) {
      const current = await WhatsAppRateCard.findOne({
        country: COUNTRY,
        category,
        effectiveTo: null
      }).sort({ effectiveFrom: -1 });

      if (current && current.rateInr === configRow.ratePaise) {
        unchanged += 1;
        console.log(`  ${category.padEnd(20)} ${configRow.display.padEnd(34)} unchanged`);
        continue;
      }

      if (!DRY_RUN) {
        if (current) {
          // Close the old row rather than overwrite it — history must stay intact.
          current.effectiveTo = now;
          await current.save();
          superseded += 1;
        }
        await WhatsAppRateCard.create({
          country: COUNTRY,
          currency: 'INR',
          category,
          rateInr: configRow.ratePaise,
          effectiveFrom: current ? now : new Date(0),
          notes: configRow.label
        });
      }

      created += 1;
      console.log(
        `  ${category.padEnd(20)} ${configRow.display.padEnd(34)} `
        + `${current ? `superseded ${current.rateInr}p → ${configRow.ratePaise}p` : 'created'}`
      );
    }
  }

  console.log(`\n${created} rate(s) written, ${superseded} superseded, ${unchanged} unchanged.\n`);
  await mongoose.disconnect();
  process.exit(0);
})().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
