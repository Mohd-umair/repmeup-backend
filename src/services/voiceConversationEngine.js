'use strict';

/**
 * Voice Conversation Engine.
 *
 * Orchestrates a single turn:
 *   user transcript → LLM (Sarvam or OpenAI) → optional tool_calls → assistant reply text
 *
 * Session state lives in Redis (`voice:session:{callSid}`) so that long calls
 * survive worker restarts and so we never hold large transcript arrays in memory.
 */

const sarvamService = require('../integrations/voice/sarvamService');
const openaiVoiceService = require('../integrations/voice/openaiVoiceService');
const voiceAiKeys = require('../integrations/voice/voiceAiKeys');
const callWorkflowService = require('./callWorkflowService');
const { getRedisClient } = require('../config/redis');
const logger = require('../config/logger');

const svcLogger = logger.createChild({ module: 'voiceConversationEngine' });

const SESSION_TTL_SECONDS = 60 * 60;
const MAX_TURNS_IN_CONTEXT = 24; // user+assistant pairs kept in the LLM window

function sessionKey(callSid) {
  return `voice:session:${callSid}`;
}

async function initSession(callSid, initial) {
  const redis = getRedisClient();
  const value = JSON.stringify(initial);
  await redis.set(sessionKey(callSid), value, { EX: SESSION_TTL_SECONDS });
}

async function loadSession(callSid) {
  const redis = getRedisClient();
  const raw = await redis.get(sessionKey(callSid));
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}

async function saveSession(callSid, sessionCtx) {
  const redis = getRedisClient();
  await redis.set(sessionKey(callSid), JSON.stringify(sessionCtx), { EX: SESSION_TTL_SECONDS });
}

async function clearSession(callSid) {
  try {
    const redis = getRedisClient();
    await redis.del(sessionKey(callSid));
  } catch (_) { /* ignore */ }
}

/**
 * Detect a hard handoff keyword in user transcript.
 * @param {string} transcript
 * @param {string[]} keywords
 */
function isHandoffRequest(transcript, keywords) {
  if (!transcript || !Array.isArray(keywords) || keywords.length === 0) return false;
  const lower = String(transcript).toLowerCase();
  return keywords.some((kw) => kw && lower.includes(String(kw).toLowerCase()));
}

/**
 * Run a single turn.
 *
 * @param {object} p
 * @param {string} p.callSid
 * @param {string} p.transcript           User's spoken text (post-STT)
 * @param {string|null} p.languageDetected
 * @param {object} p.agent                VoiceAgent
 * @param {object} p.session              CallSession doc (mongoose) — used for tool ctx
 * @param {object} p.credential           VoicePhoneCredential
 *
 * @returns {Promise<{ replyText: string, handoff: boolean, toolsInvoked: string[], languageOut: string }>}
 */
async function processTurn({ callSid, transcript, languageDetected, agent, session, credential }) {
  let ctx = await loadSession(callSid);
  if (!ctx) {
    ctx = {
      messages: [{ role: 'system', content: agent.systemPrompt }],
      language: languageDetected || agent.language || 'en-IN'
    };
  }

  ctx.messages.push({ role: 'user', content: transcript });
  if (languageDetected) ctx.language = languageDetected;

  const tools = callWorkflowService.buildToolsForAgent(agent);
  const toolsInvoked = [];
  let handoff = isHandoffRequest(transcript, agent.workflow?.humanHandoffKeywords);

  let replyText = '';
  try {
    const reply = await callChat({
      messages: trimContext(ctx.messages),
      tools,
      credential
    });

    if (reply.tool_calls && reply.tool_calls.length) {
      ctx.messages.push({
        role: 'assistant',
        content: reply.content || '',
        tool_calls: reply.tool_calls
      });

      for (const call of reply.tool_calls) {
        const toolName = call.function?.name;
        let args = {};
        try { args = JSON.parse(call.function?.arguments || '{}'); }
        catch (_) { args = {}; }

        const result = await callWorkflowService.executeTool({
          agent,
          session,
          toolName,
          args
        });
        toolsInvoked.push(toolName);
        if (toolName === 'transfer_to_human') handoff = true;

        ctx.messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: String(result || '')
        });
      }

      // Ask the LLM to produce a final spoken reply now that tool results are in
      const finalReply = await callChat({
        messages: trimContext(ctx.messages),
        tools: [],
        credential
      });
      replyText = String(finalReply.content || '').trim();
    } else {
      replyText = String(reply.content || '').trim();
    }
  } catch (err) {
    svcLogger.error('[voiceConversation] LLM turn failed', { error: err.message, callSid });
    replyText = 'Sorry, I had trouble understanding that. Could you please repeat?';
  }

  if (!replyText) {
    replyText = handoff
      ? 'Of course, please hold while I transfer you to a human agent.'
      : 'Could you please repeat that?';
  }

  ctx.messages.push({ role: 'assistant', content: replyText });
  await saveSession(callSid, ctx);

  return {
    replyText,
    handoff,
    toolsInvoked,
    languageOut: ctx.language
  };
}

function trimContext(messages) {
  // Keep the system message + the latest N turns (each user/assistant pair).
  if (messages.length <= MAX_TURNS_IN_CONTEXT + 1) return messages;
  const systemMsgs = messages.filter((m) => m.role === 'system').slice(0, 1);
  const tail = messages.filter((m) => m.role !== 'system').slice(-MAX_TURNS_IN_CONTEXT);
  return [...systemMsgs, ...tail];
}

/** Platform Sarvam first; optional platform OpenAI fallback. Org credential keys are not used. */
async function callChat({ messages, tools, credential }) {
  const sarvamKey = voiceAiKeys.getPlatformSarvamKey();
  if (sarvamKey) {
    try {
      return await sarvamService.chat({ messages, apiKey: sarvamKey, tools });
    } catch (err) {
      svcLogger.warn('[voiceConversation] Primary voice AI chat failed, trying fallback', { error: err.message });
    }
  }
  const openaiKey = voiceAiKeys.getPlatformOpenAiKey();
  if (openaiKey) {
    return await openaiVoiceService.chat({ messages, apiKey: openaiKey, tools });
  }
  throw new Error('No voice AI provider configured on platform');
}

module.exports = {
  initSession,
  loadSession,
  saveSession,
  clearSession,
  processTurn
};
