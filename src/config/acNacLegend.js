/**
 * The AC / NAC legend printed above the pricing comparison table.
 * Copy is verbatim from the published pricing sheet — keep it in sync with
 * the `metering` field on featureCatalog rows, which is what the table reads.
 */
const AC_NAC_LEGEND = Object.freeze([
  Object.freeze({
    code: 'AC',
    description:
      'Counted or credit-based — has a number that scales by plan, or is powered by an AI '
      + 'agent (Active Contacts, AI conversations, automations, broadcasts, users, channels, '
      + 'Intent Bucket)'
  }),
  Object.freeze({
    code: 'NAC',
    description:
      'Not counted — a flat capability, present or absent, same mechanic regardless of tier '
      + 'or volume'
  })
]);

module.exports = { AC_NAC_LEGEND };
