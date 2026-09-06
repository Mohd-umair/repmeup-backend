'use strict';

/**
 * Lightweight, code-level kill switches for features that are too new/risky
 * to gate through the billing `featureCatalog` (which represents *paid plan
 * entitlements*, not operational rollout state). These are operator-only
 * emergency switches — flip an env var and restart, no DB/deploy needed.
 *
 * See plan "Reference-Powered Product Shoot" §6: "Add feature flag/canary
 * controls, kill switch, per-org rollout... and fallback to existing
 * reference generation if the new orchestration is unavailable."
 *
 * Deliberately fail OPEN (enabled) by default — this only exists so an
 * operator can turn the feature OFF quickly if something goes wrong in
 * production, not to gate a slow opt-in rollout.
 */

/** Emergency kill switch for the whole "Product Shoot" upload + generation path. */
function isProductShootEnabled() {
  return process.env.PRODUCT_SHOOT_KILL_SWITCH !== 'true';
}

module.exports = { isProductShootEnabled };
