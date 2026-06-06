'use strict';

/**
 * Reply Engine policy — the single source of truth for "which engine replies?".
 *
 * Product hierarchy: the Workflow (Flow) Builder is the core engine. AI is
 * subordinate — it runs as nodes inside flows and as a FALLBACK only when no
 * workflow took ownership of a conversation.
 *
 * Mode is resolved PER CHANNEL from `organization.automationModeByChannel`,
 * with back-compat fallback to the deprecated org-wide `automationFlowMode`.
 *
 *   workflow_only : only flows run; never an AI fallback
 *   ai_only       : flows skipped; AI auto-reply handles messages
 *   hybrid        : flows run; AI fills the gap only when no flow took the conversation
 */

const VALID_MODES = ['workflow_only', 'ai_only', 'hybrid'];
const SUPPORTED_CHANNELS = ['whatsapp', 'instagram', 'facebook'];

/** Map the deprecated org-wide automationFlowMode to a per-channel mode. */
function legacyModeToChannelMode(legacy) {
  switch (legacy) {
    case 'legacy': return 'ai_only';
    case 'flows_only': return 'workflow_only';
    case 'hybrid': return 'hybrid';
    default: return 'hybrid';
  }
}

/**
 * Resolve the automation mode for a given channel.
 * @param {object} organization  Organization doc or lean object
 * @param {string} platform      'whatsapp' | 'instagram' | 'facebook'
 * @returns {'workflow_only'|'ai_only'|'hybrid'}
 */
function getChannelMode(organization, platform) {
  if (!organization) return 'hybrid';
  const ch = String(platform || '').toLowerCase();

  const byChannel = organization.automationModeByChannel;
  if (byChannel && SUPPORTED_CHANNELS.includes(ch)) {
    const mode = byChannel[ch];
    if (VALID_MODES.includes(mode)) return mode;
  }

  // Back-compat: fall back to the deprecated org-wide field.
  return legacyModeToChannelMode(organization.automationFlowMode);
}

/**
 * Decide which engines run for an inbound message.
 * @param {object}  params
 * @param {object}  params.organization
 * @param {string}  params.platform
 * @param {boolean} [params.flowHandled=false]  True once a flow has taken ownership
 * @returns {{ mode: string, runFlows: boolean, runAiFallback: boolean }}
 */
function decide({ organization, platform, flowHandled = false }) {
  const mode = getChannelMode(organization, platform);

  switch (mode) {
    case 'workflow_only':
      return { mode, runFlows: true, runAiFallback: false };
    case 'ai_only':
      return { mode, runFlows: false, runAiFallback: true };
    case 'hybrid':
    default:
      // AI only fills the gap when no workflow owned the conversation.
      return { mode, runFlows: true, runAiFallback: !flowHandled };
  }
}

module.exports = {
  getChannelMode,
  decide,
  VALID_MODES,
  SUPPORTED_CHANNELS
};
