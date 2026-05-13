'use strict';

/**
 * Post-call worker:
 *  - Generate summary, intent, sentiment via the LLM
 *  - Update or create the linked Contact/Interaction in the CRM
 *  - Send WhatsApp follow-up if the agent's workflow requests it
 *  - Upsert today's VoiceAnalyticsSummary row
 *  - Emit a Socket.IO event so the dashboard refreshes
 */

const CallSession = require('../models/CallSession');
const VoiceAgent = require('../models/VoiceAgent');
const VoiceAnalyticsSummary = require('../models/VoiceAnalyticsSummary');
const Contact = require('../models/Contact');
const Interaction = require('../models/Interaction');
const PlatformConnection = require('../models/PlatformConnection');

const sarvamService = require('../integrations/voice/sarvamService');
const openaiVoiceService = require('../integrations/voice/openaiVoiceService');
const voiceAiKeys = require('../integrations/voice/voiceAiKeys');
const { emitToOrg } = require('../utils/socketEmitter');
const logger = require('../config/logger');

const jobLogger = logger.createChild({ module: 'processVoiceCall' });

module.exports = async function processVoiceCall(job) {
  const { callSessionId } = job.data || {};
  if (!callSessionId) return { success: false, error: 'callSessionId missing' };

  const session = await CallSession.findById(callSessionId);
  if (!session) return { success: false, error: 'CallSession not found' };

  const agent = session.agent ? await VoiceAgent.findById(session.agent) : null;

  // 1. Summary / intent / sentiment
  if (voiceAiKeys.getPlatformSarvamKey() || voiceAiKeys.getPlatformOpenAiKey()) {
    try {
      const analysis = await analyzeCall(session);
      session.summary = analysis.summary;
      session.intent = analysis.intent;
      session.sentiment = analysis.sentiment;
      await session.save();
    } catch (err) {
      jobLogger.warn('[voiceCall] Analysis failed', { error: err.message });
    }
  }

  // 2. CRM linkage (if not done during the call)
  try {
    if (agent?.workflow?.createContact && !session.linkedContact && session.callerNumber) {
      const contact = await Contact.findOneAndUpdate(
        { organization: session.organization, primaryPhone: session.callerNumber, isDeleted: false },
        {
          $set: {
            organization: session.organization,
            primaryPhone: session.callerNumber,
            primaryName: 'Voice Caller',
            lastInteractionAt: new Date()
          }
        },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );
      session.linkedContact = contact._id;
    }
    if (agent?.workflow?.createInboxInteraction && !session.linkedInteraction) {
      const interaction = await Interaction.create({
        organization: session.organization,
        platform: 'whatsapp',
        type: 'dm',
        platformId: `voice_${session.twilioCallSid}`,
        content: session.summary || `Voice call (${session.durationSeconds || 0}s)`,
        contentType: 'text',
        author: {
          platformId: session.callerNumber,
          name: 'Voice Caller',
          username: session.callerNumber
        },
        contact: session.linkedContact || null,
        sentiment: session.sentiment ? { label: session.sentiment } : undefined,
        metadata: {
          voice: true,
          callSessionId: session._id,
          callerNumber: session.callerNumber,
          intent: session.intent
        }
      }).catch(() => null);
      if (interaction) session.linkedInteraction = interaction._id;
    }
    await session.save();
  } catch (err) {
    jobLogger.warn('[voiceCall] CRM upsert failed', { error: err.message });
  }

  // 3. WhatsApp follow-up
  try {
    if (agent?.workflow?.sendWhatsappFollowUp && session.callerNumber && !session.followUpSent) {
      const conn = await PlatformConnection.findOne({
        organization: session.organization,
        platform: 'whatsapp',
        isActive: true
      }).lean();
      if (conn) {
        const message = buildFollowUpMessage(session);
        const whatsappService = require('../integrations/whatsapp/whatsappService');
        const svc = whatsappService.default || whatsappService;
        if (typeof svc.sendTextMessage === 'function') {
          await svc.sendTextMessage(conn, session.callerNumber.replace(/^\+/, ''), message);
        } else if (typeof svc.sendMessage === 'function') {
          await svc.sendMessage(conn, session.callerNumber.replace(/^\+/, ''), message);
        }
        session.followUpSent = true;
        await session.save();
      }
    }
  } catch (err) {
    jobLogger.warn('[voiceCall] WhatsApp follow-up failed', { error: err.message });
  }

  // 4. Daily analytics aggregate
  try {
    await rollupAnalytics(session, agent);
  } catch (err) {
    jobLogger.warn('[voiceCall] Analytics rollup failed', { error: err.message });
  }

  // 5. Notify UI
  emitToOrg(String(session.organization), 'voice_call_finalized', {
    callSessionId: session._id,
    intent: session.intent,
    sentiment: session.sentiment,
    durationSeconds: session.durationSeconds
  });

  return { success: true };
};

function buildFollowUpMessage(session) {
  const lines = [
    'Hi! Thanks for calling us.',
    session.summary ? `Summary of our chat: ${session.summary}` : null,
    'If you have any more questions, just reply here.'
  ].filter(Boolean);
  return lines.join('\n\n');
}

async function analyzeCall(session) {
  const transcript = (session.transcript || [])
    .map((t) => `${t.role.toUpperCase()}: ${t.text}`)
    .join('\n');
  if (!transcript) return { summary: '', intent: '', sentiment: 'neutral' };

  const messages = [
    {
      role: 'system',
      content:
        'You analyze customer phone calls. Reply with strict JSON only: ' +
        '{"summary": string (max 60 words), "intent": one of [inquiry, support, sales, complaint, booking, other], "sentiment": one of [positive, neutral, negative]}.'
    },
    { role: 'user', content: `Transcript:\n${transcript}` }
  ];

  let raw;
  const sarvamKey = voiceAiKeys.getPlatformSarvamKey();
  if (sarvamKey) {
    raw = await sarvamService.chat({ messages, apiKey: sarvamKey }).catch(() => null);
  }
  if (!raw) {
    const openaiKey = voiceAiKeys.getPlatformOpenAiKey();
    if (openaiKey) {
      raw = await openaiVoiceService.chat({ messages, apiKey: openaiKey }).catch(() => null);
    }
  }
  if (!raw?.content) return { summary: '', intent: '', sentiment: 'neutral' };

  try {
    const match = raw.content.match(/\{[\s\S]*\}/);
    const json = JSON.parse(match ? match[0] : raw.content);
    return {
      summary: String(json.summary || '').slice(0, 600),
      intent: String(json.intent || 'other').toLowerCase(),
      sentiment: ['positive', 'neutral', 'negative'].includes(String(json.sentiment || '').toLowerCase())
        ? String(json.sentiment).toLowerCase()
        : 'neutral'
    };
  } catch (_) {
    return { summary: raw.content.slice(0, 400), intent: 'other', sentiment: 'neutral' };
  }
}

async function rollupAnalytics(session, agent) {
  const day = new Date(session.startedAt);
  day.setUTCHours(0, 0, 0, 0);

  await VoiceAnalyticsSummary.findOneAndUpdate(
    { organization: session.organization, date: day },
    {
      $setOnInsert: { organization: session.organization, date: day },
      $inc: {
        totalCalls: 1,
        answeredCalls: session.status === 'completed' ? 1 : 0,
        failedCalls: ['failed', 'no-answer', 'busy', 'canceled'].includes(session.status) ? 1 : 0,
        totalDurationSeconds: session.durationSeconds || 0,
        humanHandoffs: session.humanHandoffTriggered ? 1 : 0,
        followUpsSent: session.followUpSent ? 1 : 0
      }
    },
    { upsert: true, new: true }
  );

  // Recompute avg + by-agent/by-intent/by-sentiment in a second pass (cheap because we just upserted)
  const summary = await VoiceAnalyticsSummary.findOne({
    organization: session.organization,
    date: day
  });
  if (!summary) return;
  summary.avgDurationSeconds = summary.totalCalls > 0
    ? Math.round(summary.totalDurationSeconds / summary.totalCalls)
    : 0;

  if (agent) {
    const idx = (summary.byAgent || []).findIndex((a) => String(a.agentId) === String(agent._id));
    if (idx >= 0) {
      summary.byAgent[idx].count += 1;
      summary.byAgent[idx].avgDurationSeconds = Math.round(
        ((summary.byAgent[idx].avgDurationSeconds || 0) * (summary.byAgent[idx].count - 1)
          + (session.durationSeconds || 0)) / summary.byAgent[idx].count
      );
    } else {
      summary.byAgent.push({
        agentId: agent._id,
        agentName: agent.name,
        count: 1,
        avgDurationSeconds: session.durationSeconds || 0
      });
    }
  }

  if (session.intent) {
    const i = (summary.byIntent || []).findIndex((x) => x.intent === session.intent);
    if (i >= 0) summary.byIntent[i].count += 1;
    else summary.byIntent.push({ intent: session.intent, count: 1 });
  }
  if (session.sentiment) {
    const i = (summary.bySentiment || []).findIndex((x) => x.sentiment === session.sentiment);
    if (i >= 0) summary.bySentiment[i].count += 1;
    else summary.bySentiment.push({ sentiment: session.sentiment, count: 1 });
  }
  await summary.save();
}
