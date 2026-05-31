'use strict';

const Interaction = require('../../models/Interaction');
const { generateOpsRef } = require('../../utils/opsRefHelper');
const logger = require('../../config/logger');

/**
 * Create complaint subdocument when AI detects complaint intent (idempotent).
 * @param {import('mongoose').Document|object} interaction
 * @param {string} intent
 */
async function ensureComplaintFromIntent(interaction, intent) {
  if (intent !== 'complaint' || !interaction?._id) return;

  const existing = interaction.complaint?.displayRef;
  if (existing) return;

  const orgId = interaction.organization?._id || interaction.organization;
  if (!orgId) return;

  try {
    const { displayRef } = await generateOpsRef(orgId, 'complaint');
    const issueSummary = String(interaction.content || '')
      .trim()
      .replace(/\s+/g, ' ')
      .substring(0, 280);

    const priority =
      interaction.sentiment === 'negative' || interaction.urgency === 'urgent'
        ? 'high'
        : interaction.priority || 'medium';

    const now = new Date();
    const complaint = {
      displayRef,
      status: 'open',
      issueSummary: issueSummary || 'Customer complaint',
      priority,
      timeline: [
        {
          event: 'Complaint raised',
          at: now,
          note: issueSummary || undefined
        }
      ]
    };

    const update = { complaint };
    if (priority === 'high') {
      update.priority = 'high';
    }

    await Interaction.findByIdAndUpdate(interaction._id, { $set: update });
  } catch (err) {
    logger.warn('[complaintAutoCreate] failed (non-fatal)', {
      interactionId: interaction._id?.toString?.(),
      error: err.message
    });
  }
}

module.exports = { ensureComplaintFromIntent };
