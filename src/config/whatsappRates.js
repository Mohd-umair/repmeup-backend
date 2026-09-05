/**
 * WhatsApp pass-through message costs (India).
 *
 * These are Meta's conversation charges billed straight through — identical on every
 * plan, so they sit beside the pricing table rather than inside it.
 *
 * Rates are stored in PAISE so no float arithmetic ever touches money. Phase 6 moves
 * the authoritative rates into the WhatsAppRateCard collection (so a Meta price change
 * is a new effective-dated row, and historical charges keep the rate they were billed
 * at); this file stays as the seed source and the fallback when no card is loaded.
 */

const WHATSAPP_RATES_INR_PAISE = Object.freeze([
  Object.freeze({
    category: 'marketing',
    label: 'Marketing messages',
    ratePaise: 142,
    display: '₹1.42 / message'
  }),
  Object.freeze({
    category: 'utility',
    label: 'Utility / authentication messages',
    ratePaise: 19,
    display: '₹0.19 / message'
  }),
  Object.freeze({
    category: 'service',
    label: 'Service messages',
    ratePaise: 0,
    display: 'Free, unlimited, within 24-hr window'
  })
]);

const WHATSAPP_RATES_NOTE =
  'Pass-through cost, identical on every plan — not a plan differentiator.';

module.exports = { WHATSAPP_RATES_INR_PAISE, WHATSAPP_RATES_NOTE };
