'use strict';

/**
 * Seed the global flow blueprints (Checkout, …) defined in config/flowBlueprintCatalog.
 *
 * Global blueprints (`organization: null, isBlueprint: true`) appear in EVERY org's
 * "Blueprints" tab and can be imported via duplicateFlow. Idempotent — safe to re-run;
 * it upserts by (name, isBlueprint:true, organization:null).
 *
 * Usage:
 *   node src/scripts/seedCheckoutBlueprint.js                 # seed/refresh global blueprints
 *   node src/scripts/seedCheckoutBlueprint.js --install <orgId>
 *        ↑ also install an ACTIVE copy of the Checkout blueprint into <orgId> so it
 *          runs immediately (the org still needs WhatsApp automation mode = workflow_only or hybrid).
 *   node src/scripts/seedCheckoutBlueprint.js --install-comment-dm <orgId>
 *        ↑ install an ACTIVE copy of the Comment-to-DM blueprint into <orgId>
 *          (the org still needs Instagram automation mode = workflow_only or hybrid).
 */

require('dotenv').config();
const mongoose = require('mongoose');
const AutomationFlow = require('../models/AutomationFlow');
const { BLUEPRINTS, CHECKOUT_BLUEPRINT, COMMENT_TO_DM_BLUEPRINT } = require('../config/flowBlueprintCatalog');
const logger = require('../config/logger');

async function seedGlobalBlueprints() {
  const results = [];
  for (const bp of BLUEPRINTS) {
    const filter = { isBlueprint: true, organization: null, name: bp.name };
    const update = {
      $set: {
        organization: null,
        isBlueprint: true,
        seeded: true,
        name: bp.name,
        description: bp.description,
        channels: bp.channels,
        entryNodeId: bp.entryNodeId,
        nodes: bp.nodes,
        edges: bp.edges,
        status: 'active',
        version: 1
      }
    };
    const res = await AutomationFlow.findOneAndUpdate(filter, update, { upsert: true, new: true });
    results.push(res);
    console.log(`  ✓ blueprint "${bp.name}" → ${res._id} (global, ${bp.nodes.length} nodes)`);
  }
  return results;
}

async function installActiveCopy(orgId, blueprint, nameRegex) {
  const bpShape = {
    description: blueprint.description,
    channels: blueprint.channels,
    entryNodeId: blueprint.entryNodeId,
    nodes: blueprint.nodes,
    edges: blueprint.edges
  };

  // Refresh an existing copy to the latest node graph (so flows imported before a
  // node change get the fix), and ensure it's active.
  const existing = await AutomationFlow.findOne({
    organization: orgId, isBlueprint: false, name: { $regex: nameRegex }
  });
  if (existing) {
    Object.assign(existing, bpShape, { status: 'active', version: (existing.version || 1) + 1 });
    await existing.save();
    console.log(`  ✓ refreshed existing flow "${existing.name}" in org ${orgId} → ${existing._id} (now ${existing.nodes.length} nodes, active)`);
    return existing;
  }

  const copy = await AutomationFlow.create({
    organization: orgId,
    name: blueprint.name,
    ...bpShape,
    status: 'active',
    version: 1,
    isBlueprint: false
  });
  console.log(`  ✓ installed ACTIVE flow "${blueprint.name}" into org ${orgId} → ${copy._id}`);
  return copy;
}

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  try {
    console.log('Seeding global flow blueprints…');
    await seedGlobalBlueprints();

    const installIdx = process.argv.indexOf('--install');
    if (installIdx !== -1 && process.argv[installIdx + 1]) {
      const orgId = process.argv[installIdx + 1];
      console.log(`Installing active Checkout copy for org ${orgId}…`);
      await installActiveCopy(orgId, CHECKOUT_BLUEPRINT, '^Checkout');
    }

    const installCdmIdx = process.argv.indexOf('--install-comment-dm');
    if (installCdmIdx !== -1 && process.argv[installCdmIdx + 1]) {
      const orgId = process.argv[installCdmIdx + 1];
      console.log(`Installing active Comment-to-DM copy for org ${orgId}…`);
      await installActiveCopy(orgId, COMMENT_TO_DM_BLUEPRINT, '^Comment to DM');
    }
    console.log('Done.');
  } catch (err) {
    logger.error('[seedCheckoutBlueprint] failed', { error: err.message });
    console.error('ERROR:', err.message);
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
  }
})();
