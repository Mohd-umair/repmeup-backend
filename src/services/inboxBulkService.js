/**
 * Inbox Bulk Service
 *
 * Business logic for bulk operations on Interaction documents.
 * Keeps inboxController.js focused on HTTP concerns.
 *
 * All methods invalidate the inbox cache after mutating data.
 *
 * Exports:
 *   bulkAssign({ interactionIds, userId, assignedBy, organizationId })
 *   bulkUpdateStatus({ interactionIds, status, organizationId })
 *   bulkAddLabel({ interactionIds, labelId, organizationId })
 */

const Interaction = require('../models/Interaction');
const Label = require('../models/Label');
const User = require('../models/User');
const cacheService = require('./cacheService');

/**
 * Assign multiple interactions to an agent.
 *
 * @param {{ interactionIds: string[], userId: string, assignedBy: string, organizationId: string }}
 * @returns {Promise<{ updated: number, agentName: string }>}
 * @throws When agent not found
 */
async function bulkAssign({ interactionIds, userId, assignedBy, organizationId }) {
  const agent = await User.findById(userId);
  if (!agent) {
    const err = new Error('Agent not found');
    err.statusCode = 404;
    throw err;
  }

  const assignedAt = new Date();
  const result = await Interaction.updateMany(
    { _id: { $in: interactionIds }, organization: organizationId },
    {
      $set: {
        assignedTo: userId,
        assignedBy,
        assignedAt,
        assignmentReason: 'manual',
        status: 'assigned'
      },
      $push: {
        assignmentHistory: { assignedTo: userId, assignedBy, assignedAt, reason: 'manual' }
      }
    }
  );

  await cacheService.invalidateInteractionCaches(organizationId).catch(() => {});

  return {
    updated: result.modifiedCount,
    agentName: `${agent.firstName} ${agent.lastName}`
  };
}

const VALID_STATUSES = ['unread', 'read', 'replied', 'resolved', 'archived', 'spam'];

/**
 * Update the status of multiple interactions.
 *
 * @param {{ interactionIds: string[], status: string, organizationId: string }}
 * @returns {Promise<{ updated: number }>}
 * @throws When status is invalid
 */
async function bulkUpdateStatus({ interactionIds, status, organizationId }) {
  if (!VALID_STATUSES.includes(status)) {
    const err = new Error(`status must be one of: ${VALID_STATUSES.join(', ')}`);
    err.statusCode = 400;
    throw err;
  }

  const update = { status };
  if (status === 'resolved') update.resolvedAt = new Date();

  const result = await Interaction.updateMany(
    { _id: { $in: interactionIds }, organization: organizationId },
    { $set: update }
  );

  await cacheService.invalidateInteractionCaches(organizationId).catch(() => {});

  return { updated: result.modifiedCount };
}

/**
 * Add a label to multiple interactions (skips duplicates).
 *
 * @param {{ interactionIds: string[], labelId: string, organizationId: string }}
 * @returns {Promise<{ updated: number }>}
 * @throws When label not found
 */
async function bulkAddLabel({ interactionIds, labelId, organizationId }) {
  const label = await Label.findById(labelId);
  if (!label) {
    const err = new Error('Label not found');
    err.statusCode = 404;
    throw err;
  }

  const interactions = await Interaction.find({
    _id: { $in: interactionIds },
    organization: organizationId
  });

  let updated = 0;
  for (const interaction of interactions) {
    if (!interaction.labels.includes(labelId)) {
      interaction.labels.push(labelId);
      await interaction.save();
      await label.incrementUsage();
      updated++;
    }
  }

  await cacheService.invalidateInteractionCaches(organizationId).catch(() => {});

  return { updated };
}

module.exports = { bulkAssign, bulkUpdateStatus, bulkAddLabel };
