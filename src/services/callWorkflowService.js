'use strict';

/**
 * Executes the built-in tool actions that voice agents may invoke during a call.
 * Also exposes a buildToolsForAgent() helper that returns OpenAI/Sarvam tool schemas.
 *
 * Built-in actions:
 *   create_contact, log_call_interaction, send_whatsapp_followup,
 *   lookup_appointment, book_appointment, check_product_availability,
 *   transfer_to_human, custom_webhook
 */

const axios = require('axios');
const Contact = require('../models/Contact');
const Interaction = require('../models/Interaction');
const PlatformConnection = require('../models/PlatformConnection');
const CallSession = require('../models/CallSession');
const logger = require('../config/logger');
const { buildBuiltInToolDefinition } = require('../config/voiceAgentTemplates');

const svcLogger = logger.createChild({ module: 'callWorkflowService' });

/**
 * Build the full tools[] array for an agent (OpenAI tool-calling schema).
 *
 * @param {object} agent VoiceAgent doc/object
 * @returns {Array<object>}
 */
function buildToolsForAgent(agent) {
  if (!agent || !Array.isArray(agent.tools)) return [];
  return agent.tools
    .filter((t) => t && t.enabled !== false)
    .map((t) => {
      const builtIn = buildBuiltInToolDefinition(t.action);
      if (builtIn) {
        return {
          type: 'function',
          function: {
            name: t.name || builtIn.name,
            description: t.description || builtIn.description,
            parameters: t.parameters && Object.keys(t.parameters).length ? t.parameters : builtIn.parameters
          }
        };
      }
      return {
        type: 'function',
        function: {
          name: t.name,
          description: t.description || '',
          parameters: t.parameters || { type: 'object', properties: {} }
        }
      };
    });
}

/**
 * Execute a tool call returned by the LLM.
 *
 * @param {object} p
 * @param {object} p.agent     VoiceAgent
 * @param {object} p.session   CallSession (in-memory copy)
 * @param {string} p.toolName  function name from tool_call
 * @param {object} p.args      JSON-parsed arguments
 * @returns {Promise<string>}  Human-readable result string fed back to the LLM (`tool` role message)
 */
async function executeTool({ agent, session, toolName, args }) {
  const action = pickAction(agent, toolName);
  if (!action) {
    svcLogger.warn('[callWorkflow] Unknown tool requested', { toolName });
    return `The tool "${toolName}" is not available.`;
  }

  try {
    switch (action.action) {
      case 'create_contact':
        return await actionCreateContact(session, args);
      case 'log_call_interaction':
        return await actionLogInteraction(session, args);
      case 'send_whatsapp_followup':
        return await actionSendWhatsappFollowup(session, args);
      case 'lookup_appointment':
        return actionStubbed('Appointment lookup', args);
      case 'book_appointment':
        return actionStubbed('Appointment booking', args);
      case 'check_product_availability':
        return actionStubbed('Product availability check', args);
      case 'transfer_to_human':
        return await actionTransferToHuman(session, args);
      case 'custom_webhook':
        return await actionCustomWebhook(action, session, args);
      default:
        return `Tool "${toolName}" is not implemented yet.`;
    }
  } catch (err) {
    svcLogger.error('[callWorkflow] Tool execution error', {
      toolName,
      error: err.message,
      stack: err.stack
    });
    return `The "${toolName}" tool failed: ${err.message}`;
  }
}

function pickAction(agent, toolName) {
  if (!agent?.tools) return null;
  return agent.tools.find((t) => t.name === toolName) || null;
}

// ─── Action implementations ──────────────────────────────────────────────────

async function actionCreateContact(session, args) {
  const phone = session.callerNumber || '';
  if (!phone) return 'No caller number on this session, cannot save contact.';

  const update = {
    organization: session.organization,
    primaryPhone: phone,
    primaryName: args.name || 'Voice Caller',
    lastInteractionAt: new Date()
  };
  if (args.email) update.primaryEmail = String(args.email).toLowerCase().trim();
  if (args.notes) update.notes = args.notes;

  const contact = await Contact.findOneAndUpdate(
    { organization: session.organization, primaryPhone: phone, isDeleted: false },
    { $set: update, $addToSet: { channels: { platform: 'whatsapp', platformUserId: phone, name: args.name || 'Voice Caller' } } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  // Link to the call session so the post-call worker can pick it up
  await CallSession.updateOne(
    { _id: session._id },
    { $set: { linkedContact: contact._id } }
  );

  return `Contact saved as ${args.name || 'Voice Caller'} (${phone}).`;
}

async function actionLogInteraction(session, args) {
  const summary = String(args.summary || '').trim() || 'Call logged.';
  const interaction = await Interaction.create({
    organization: session.organization,
    platform: 'whatsapp', // existing enum closest to voice; UI labels differently
    type: 'dm',
    platformId: `voice_${session.twilioCallSid}`,
    content: summary,
    contentType: 'text',
    author: {
      platformId: session.callerNumber,
      name: 'Voice Caller',
      username: session.callerNumber
    },
    contact: session.linkedContact || null,
    metadata: {
      voice: true,
      callSessionId: session._id,
      callerNumber: session.callerNumber
    }
  }).catch((err) => {
    svcLogger.warn('[callWorkflow] Interaction.create failed (likely duplicate)', { error: err.message });
    return null;
  });

  if (interaction) {
    await CallSession.updateOne(
      { _id: session._id },
      { $set: { linkedInteraction: interaction._id } }
    );
  }
  return 'Call logged to the inbox.';
}

async function actionSendWhatsappFollowup(session, args) {
  const message = String(args.message || '').trim();
  if (!message) return 'No message provided.';
  const phone = session.callerNumber;
  if (!phone) return 'No caller number available.';

  const connection = await PlatformConnection.findOne({
    organization: session.organization,
    platform: 'whatsapp',
    isActive: true
  }).lean();

  if (!connection) return 'No active WhatsApp connection on this organization.';

  try {
    const whatsappService = require('../integrations/whatsapp/whatsappService');
    const svc = whatsappService.default || whatsappService;
    if (typeof svc.sendTextMessage === 'function') {
      await svc.sendTextMessage(connection, phone.replace(/^\+/, ''), message);
    } else if (typeof svc.sendMessage === 'function') {
      await svc.sendMessage(connection, phone.replace(/^\+/, ''), message);
    } else {
      return 'WhatsApp send method not available.';
    }
    await CallSession.updateOne({ _id: session._id }, { $set: { followUpSent: true } });
    return 'WhatsApp follow-up sent.';
  } catch (err) {
    svcLogger.warn('[callWorkflow] WhatsApp follow-up failed', { error: err.message });
    return `WhatsApp send failed: ${err.message}`;
  }
}

function actionStubbed(label, args) {
  return `${label} acknowledged. Details: ${JSON.stringify(args)}.`;
}

async function actionTransferToHuman(session, args) {
  await CallSession.updateOne(
    { _id: session._id },
    { $set: { humanHandoffTriggered: true } }
  );
  return `Connecting the caller to a human agent. Reason: ${args.reason || 'caller request'}.`;
}

async function actionCustomWebhook(toolDef, session, args) {
  if (!toolDef.webhookUrl) return 'Custom webhook URL is not configured.';
  try {
    const { data } = await axios.post(toolDef.webhookUrl, {
      callSessionId: session._id,
      organizationId: session.organization,
      callerNumber: session.callerNumber,
      args
    }, { timeout: 8000 });
    return typeof data === 'string' ? data : JSON.stringify(data).slice(0, 400);
  } catch (err) {
    return `Webhook failed: ${err.message}`;
  }
}

module.exports = {
  buildToolsForAgent,
  executeTool
};
