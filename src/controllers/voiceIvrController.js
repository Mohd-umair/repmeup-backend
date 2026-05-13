'use strict';
const VoiceAgent = require('../models/VoiceAgent');
const PhoneNumber = require('../models/PhoneNumber');
const CallSession = require('../models/CallSession');
const VoicePhoneCredential = require('../models/VoicePhoneCredential');
const VoiceAnalyticsSummary = require('../models/VoiceAnalyticsSummary');

const twilioService = require('../integrations/voice/twilioService');
const voiceAiKeys = require('../integrations/voice/voiceAiKeys');
const { TEMPLATES, buildBuiltInToolDefinition } = require('../config/voiceAgentTemplates');
const logger = require('../config/logger');
const { emitToOrg } = require('../utils/socketEmitter');

const ctrlLogger = logger.createChild({ module: 'voiceIvrController' });

// ─── Helpers ─────────────────────────────────────────────────────────────────

function sanitizeCredential(doc) {
  if (!doc) return null;
  const mask = (v) => (v ? `••••${String(v).slice(-4)}` : '');
  const mode = doc.telephonyMode === 'managed' ? 'managed' : 'byow';
  return {
    _id: doc._id,
    telephonyMode: mode,
    twilioAccountSid: mode === 'managed' ? '' : (doc.twilioAccountSid || ''),
    twilioAuthToken: mode === 'managed' ? mask(doc.twilioSubaccountAuthToken) : mask(doc.twilioAuthToken),
    managedTelephonyReady: mode === 'managed' ? !!(doc.twilioSubaccountSid && doc.twilioSubaccountAuthToken) : false,
    publicBaseUrl: mode === 'managed'
      ? (doc.publicBaseUrl || process.env.PUBLIC_API_BASE_URL || '')
      : (doc.publicBaseUrl || ''),
    isActive: doc.isActive,
    voiceAiEnabled: !!(voiceAiKeys.getPlatformSarvamKey() || voiceAiKeys.getPlatformOpenAiKey()),
    updatedAt: doc.updatedAt
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// TWILIO WEBHOOKS (public — Twilio signature validated inside)
// ═════════════════════════════════════════════════════════════════════════════

/** Twilio voice URL — returns TwiML that opens a media stream to our WS gateway. */
exports.incomingCallWebhook = async (req, res, next) => {
  try {
    const body = req.body || {};
    const callSid = body.CallSid;
    const from = body.From;
    const to = body.To;
    const direction = body.Direction === 'outbound-api' ? 'outbound' : 'inbound';

    if (!callSid) return res.status(400).send('Missing CallSid');

    // Find the phone number to resolve the org + assigned agent
    const candidate = direction === 'inbound' ? to : from;
    const phoneNumber = await PhoneNumber.findOne({ number: candidate, isActive: true })
      .populate('assignedAgent')
      .lean();

    // For outbound calls, agentId may be in the query string
    let agent = phoneNumber?.assignedAgent || null;
    let organizationId = phoneNumber?.organization || null;
    if (!agent && req.query.agentId) {
      agent = await VoiceAgent.findById(req.query.agentId).lean();
      organizationId = agent?.organization;
    }

    if (!agent || !organizationId) {
      ctrlLogger.warn('[voice/webhook] No agent for call', { callSid, candidate });
      return res
        .type('text/xml')
        .send('<?xml version="1.0" encoding="UTF-8"?><Response><Say>This number is not configured. Goodbye.</Say><Hangup/></Response>');
    }

    // Verify Twilio signature if we can (BYOW or subaccount token)
    const authToken = await twilioService.getWebhookAuthToken(organizationId);
    if (authToken && process.env.NODE_ENV === 'production') {
      const ok = twilioService.validateWebhookSignature(req, authToken);
      if (!ok) {
        ctrlLogger.warn('[voice/webhook] Invalid Twilio signature', { callSid });
        return res.status(403).send('Forbidden');
      }
    }

    // Create the CallSession row
    await CallSession.findOneAndUpdate(
      { twilioCallSid: callSid },
      {
        $setOnInsert: {
          twilioCallSid: callSid,
          organization: organizationId,
          agent: agent._id,
          phoneNumber: phoneNumber?._id || null,
          direction,
          callerNumber: from,
          calledNumber: to,
          startedAt: new Date(),
          status: 'ringing'
        }
      },
      { upsert: true, new: true }
    );

    const credential = await VoicePhoneCredential.findOne({ organization: organizationId }).lean();
    const base = twilioService.resolvePublicBaseUrl(credential || {}).replace(/\/$/, '');
    const wsUrl = base
      ? `${base.replace(/^http/, 'ws')}/voice/stream`
      : `wss://${req.get('host')}/voice/stream`;

    const twiml = twilioService.buildStreamTwiml({
      wsUrl,
      greeting: agent.greetingMessage,
      callSid,
      agentId: String(agent._id)
    });
    res.type('text/xml').send(twiml);
  } catch (err) {
    ctrlLogger.error('[voice/webhook] incoming error', { error: err.message, stack: err.stack });
    res
      .type('text/xml')
      .send('<?xml version="1.0" encoding="UTF-8"?><Response><Say>Sorry, something went wrong.</Say><Hangup/></Response>');
  }
};

/** Twilio call status callback — updates status + duration. */
exports.callStatusWebhook = async (req, res) => {
  try {
    const body = req.body || {};
    const callSid = body.CallSid;
    const status = body.CallStatus; // queued|initiated|ringing|in-progress|completed|busy|no-answer|failed|canceled
    if (!callSid) return res.status(400).send('Missing CallSid');

    const update = { status };
    if (body.CallDuration) update.durationSeconds = parseInt(body.CallDuration, 10);
    if (['completed', 'failed', 'no-answer', 'busy', 'canceled'].includes(status)) {
      update.endedAt = new Date();
    }
    if (body.RecordingUrl) update.recordingUrl = body.RecordingUrl;

    await CallSession.updateOne({ twilioCallSid: callSid }, { $set: update });
    res.status(200).send('ok');
  } catch (err) {
    ctrlLogger.error('[voice/webhook] status error', { error: err.message });
    res.status(200).send('ok'); // never fail Twilio callbacks
  }
};

/** Optional recording callback. */
exports.recordingWebhook = async (req, res) => {
  try {
    const body = req.body || {};
    if (body.CallSid && body.RecordingUrl) {
      await CallSession.updateOne(
        { twilioCallSid: body.CallSid },
        { $set: { recordingUrl: body.RecordingUrl } }
      );
    }
    res.status(200).send('ok');
  } catch (err) {
    res.status(200).send('ok');
  }
};

// ═════════════════════════════════════════════════════════════════════════════
// CREDENTIALS
// ═════════════════════════════════════════════════════════════════════════════

exports.getCredentials = async (req, res, next) => {
  try {
    const doc = await VoicePhoneCredential.findOne({ organization: req.user.organization._id }).lean();
    res.json({ success: true, data: sanitizeCredential(doc) });
  } catch (err) { next(err); }
};

exports.updateCredentials = async (req, res, next) => {
  try {
    const {
      telephonyMode,
      twilioAccountSid,
      twilioAuthToken,
      publicBaseUrl,
      isActive
    } = req.body || {};
    const orgId = req.user.organization._id;

    const existing = await VoicePhoneCredential.findOne({ organization: orgId });
    let mode;
    if (telephonyMode === 'managed') mode = 'managed';
    else if (telephonyMode === 'byow') mode = 'byow';
    else mode = existing?.telephonyMode === 'managed' ? 'managed' : 'byow';

    if (existing && existing.telephonyMode === 'managed' && mode === 'byow') {
      await twilioService.closeManagedSubaccountIfAny(existing);
    }

    const set = { telephonyMode: mode };
    if (isActive !== undefined) set.isActive = !!isActive;

    if (mode === 'managed') {
      set.twilioAccountSid = '';
      set.twilioAuthToken = '';
      if (publicBaseUrl !== undefined) set.publicBaseUrl = String(publicBaseUrl).trim();
    } else {
      if (twilioAccountSid !== undefined) set.twilioAccountSid = String(twilioAccountSid).trim();
      if (twilioAuthToken !== undefined && twilioAuthToken && !/^•+/.test(twilioAuthToken)) {
        set.twilioAuthToken = String(twilioAuthToken).trim();
      }
      if (publicBaseUrl !== undefined) set.publicBaseUrl = String(publicBaseUrl).trim();
    }

    const updateOp = { $set: set, $setOnInsert: { organization: orgId } };
    if (mode === 'byow') {
      updateOp.$unset = { twilioSubaccountSid: '', twilioSubaccountAuthToken: '' };
    }

    let doc = await VoicePhoneCredential.findOneAndUpdate(
      { organization: orgId },
      updateOp,
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    const shouldProvision = mode === 'managed' && (doc.isActive !== false);
    if (shouldProvision) {
      try {
        await twilioService.ensureManagedSubaccount(orgId);
        doc = await VoicePhoneCredential.findOne({ organization: orgId });
      } catch (provErr) {
        ctrlLogger.error('[voice/credentials] Managed telephony provision failed', { error: provErr.message });
        return res.status(provErr.statusCode || 500).json({
          success: false,
          error: provErr.message || 'Could not provision telephony'
        });
      }
    }

    res.json({ success: true, data: sanitizeCredential(doc) });
  } catch (err) { next(err); }
};

exports.deleteCredentials = async (req, res, next) => {
  try {
    const existing = await VoicePhoneCredential.findOne({ organization: req.user.organization._id });
    if (existing) await twilioService.closeManagedSubaccountIfAny(existing);
    await VoicePhoneCredential.deleteOne({ organization: req.user.organization._id });
    res.json({ success: true });
  } catch (err) { next(err); }
};

// ═════════════════════════════════════════════════════════════════════════════
// PHONE NUMBERS
// ═════════════════════════════════════════════════════════════════════════════

exports.listPhoneNumbers = async (req, res, next) => {
  try {
    const list = await PhoneNumber.find({ organization: req.user.organization._id })
      .populate('assignedAgent', 'name industry')
      .sort({ createdAt: -1 })
      .lean();
    res.json({ success: true, data: list });
  } catch (err) { next(err); }
};

exports.searchAvailableNumbers = async (req, res, next) => {
  try {
    const { country = 'US', areaCode, contains, limit = 20 } = req.body || {};
    const numbers = await twilioService.searchAvailableNumbers(req.user.organization._id, {
      country, areaCode, contains, limit
    });
    res.json({ success: true, data: numbers });
  } catch (err) {
    res.status(err.statusCode || 500).json({ success: false, error: err.message });
  }
};

exports.purchasePhoneNumber = async (req, res, next) => {
  try {
    const { phoneNumber, friendlyName, assignedAgent } = req.body || {};
    if (!phoneNumber) return res.status(400).json({ success: false, error: 'phoneNumber is required' });

    const twilioResult = await twilioService.purchaseNumber(req.user.organization._id, phoneNumber);
    const doc = await PhoneNumber.create({
      organization: req.user.organization._id,
      twilioSid: twilioResult.sid,
      number: twilioResult.phoneNumber,
      friendlyName: friendlyName || twilioResult.friendlyName || phoneNumber,
      assignedAgent: assignedAgent || null,
      capabilities: {
        voice: !!twilioResult.capabilities?.voice,
        sms: !!twilioResult.capabilities?.SMS
      },
      isActive: true
    });
    res.status(201).json({ success: true, data: doc });
  } catch (err) {
    res.status(err.statusCode || 500).json({ success: false, error: err.message });
  }
};

exports.updatePhoneNumber = async (req, res, next) => {
  try {
    const { friendlyName, assignedAgent, isActive } = req.body || {};
    const update = {};
    if (friendlyName !== undefined) update.friendlyName = friendlyName;
    if (assignedAgent !== undefined) update.assignedAgent = assignedAgent || null;
    if (isActive !== undefined) update.isActive = !!isActive;

    const doc = await PhoneNumber.findOneAndUpdate(
      { _id: req.params.id, organization: req.user.organization._id },
      { $set: update },
      { new: true }
    );
    if (!doc) return res.status(404).json({ success: false, error: 'Number not found' });
    res.json({ success: true, data: doc });
  } catch (err) { next(err); }
};

exports.releasePhoneNumber = async (req, res, next) => {
  try {
    const doc = await PhoneNumber.findOne({
      _id: req.params.id,
      organization: req.user.organization._id
    });
    if (!doc) return res.status(404).json({ success: false, error: 'Number not found' });

    try {
      await twilioService.releaseNumber(req.user.organization._id, doc.twilioSid);
    } catch (err) {
      ctrlLogger.warn('[voice/release] Twilio release failed (continuing local delete)', { error: err.message });
    }
    await doc.deleteOne();
    res.json({ success: true });
  } catch (err) { next(err); }
};

// ═════════════════════════════════════════════════════════════════════════════
// AGENTS
// ═════════════════════════════════════════════════════════════════════════════

exports.listAgents = async (req, res, next) => {
  try {
    const agents = await VoiceAgent.find({ organization: req.user.organization._id })
      .sort({ updatedAt: -1 })
      .lean();
    res.json({ success: true, data: agents });
  } catch (err) { next(err); }
};

exports.getAgentTemplates = (req, res) => {
  res.json({ success: true, data: TEMPLATES });
};

exports.getAgent = async (req, res, next) => {
  try {
    const agent = await VoiceAgent.findOne({
      _id: req.params.id,
      organization: req.user.organization._id
    }).lean();
    if (!agent) return res.status(404).json({ success: false, error: 'Agent not found' });
    res.json({ success: true, data: agent });
  } catch (err) { next(err); }
};

exports.createAgent = async (req, res, next) => {
  try {
    const body = req.body || {};
    const tools = (body.tools || []).map(normalizeToolInput);
    const doc = await VoiceAgent.create({
      organization: req.user.organization._id,
      createdBy: req.user._id,
      name: body.name || 'Untitled Agent',
      industry: body.industry || 'custom',
      systemPrompt: body.systemPrompt || 'You are a helpful assistant.',
      greetingMessage: body.greetingMessage || 'Hello! How can I help?',
      language: body.language || 'en-IN',
      voiceId: body.voiceId || 'meera',
      tools,
      workflow: body.workflow || {},
      isActive: body.isActive !== false,
      linkedPhoneNumbers: body.linkedPhoneNumbers || []
    });
    res.status(201).json({ success: true, data: doc });
  } catch (err) { next(err); }
};

exports.updateAgent = async (req, res, next) => {
  try {
    const body = req.body || {};
    const update = {};
    [
      'name', 'industry', 'systemPrompt', 'greetingMessage', 'language',
      'voiceId', 'isActive', 'linkedPhoneNumbers', 'workflow'
    ].forEach((k) => {
      if (body[k] !== undefined) update[k] = body[k];
    });
    if (Array.isArray(body.tools)) update.tools = body.tools.map(normalizeToolInput);

    const doc = await VoiceAgent.findOneAndUpdate(
      { _id: req.params.id, organization: req.user.organization._id },
      { $set: update },
      { new: true }
    );
    if (!doc) return res.status(404).json({ success: false, error: 'Agent not found' });
    res.json({ success: true, data: doc });
  } catch (err) { next(err); }
};

exports.deleteAgent = async (req, res, next) => {
  try {
    const result = await VoiceAgent.findOneAndDelete({
      _id: req.params.id,
      organization: req.user.organization._id
    });
    if (!result) return res.status(404).json({ success: false, error: 'Agent not found' });
    // Detach any phone numbers
    await PhoneNumber.updateMany(
      { organization: req.user.organization._id, assignedAgent: req.params.id },
      { $set: { assignedAgent: null } }
    );
    res.json({ success: true });
  } catch (err) { next(err); }
};

function normalizeToolInput(t) {
  const builtIn = buildBuiltInToolDefinition(t.action);
  return {
    name: t.name || builtIn?.name || t.action,
    description: t.description || builtIn?.description || '',
    parameters: t.parameters && Object.keys(t.parameters).length ? t.parameters : (builtIn?.parameters || {}),
    action: t.action,
    webhookUrl: t.webhookUrl || '',
    enabled: t.enabled !== false
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// CALLS
// ═════════════════════════════════════════════════════════════════════════════

exports.listCalls = async (req, res, next) => {
  try {
    const {
      agentId,
      status,
      direction,
      from,
      to,
      page = 1,
      limit = 25
    } = req.query;

    const filter = { organization: req.user.organization._id };
    if (agentId) filter.agent = agentId;
    if (status) filter.status = status;
    if (direction) filter.direction = direction;
    if (from || to) {
      filter.startedAt = {};
      if (from) filter.startedAt.$gte = new Date(from);
      if (to) filter.startedAt.$lte = new Date(to);
    }

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 25));
    const skip = (pageNum - 1) * limitNum;

    const [items, total] = await Promise.all([
      CallSession.find(filter)
        .select('-transcript')
        .populate('agent', 'name industry')
        .populate('phoneNumber', 'number')
        .sort({ startedAt: -1 })
        .skip(skip)
        .limit(limitNum)
        .lean(),
      CallSession.countDocuments(filter)
    ]);

    res.json({ success: true, data: { items, total, page: pageNum, limit: limitNum } });
  } catch (err) { next(err); }
};

exports.getCall = async (req, res, next) => {
  try {
    const call = await CallSession.findOne({
      _id: req.params.id,
      organization: req.user.organization._id
    })
      .populate('agent', 'name industry')
      .populate('phoneNumber', 'number')
      .populate('linkedContact', 'primaryName primaryPhone primaryEmail')
      .populate('linkedInteraction', 'chatRef')
      .lean();
    if (!call) return res.status(404).json({ success: false, error: 'Call not found' });
    res.json({ success: true, data: call });
  } catch (err) { next(err); }
};

exports.createOutboundCall = async (req, res, next) => {
  try {
    const { to, fromNumberId, agentId } = req.body || {};
    if (!to || !fromNumberId || !agentId) {
      return res.status(400).json({ success: false, error: 'to, fromNumberId, agentId are required' });
    }
    const fromNumber = await PhoneNumber.findOne({
      _id: fromNumberId,
      organization: req.user.organization._id,
      isActive: true
    }).lean();
    if (!fromNumber) return res.status(404).json({ success: false, error: 'fromNumber not found' });

    const agent = await VoiceAgent.findOne({
      _id: agentId,
      organization: req.user.organization._id
    }).lean();
    if (!agent) return res.status(404).json({ success: false, error: 'agent not found' });

    const call = await twilioService.createOutboundCall(req.user.organization._id, {
      from: fromNumber.number,
      to,
      agentId: String(agent._id)
    });

    await CallSession.create({
      organization: req.user.organization._id,
      agent: agent._id,
      phoneNumber: fromNumber._id,
      twilioCallSid: call.sid,
      direction: 'outbound',
      callerNumber: fromNumber.number,
      calledNumber: to,
      status: call.status,
      startedAt: new Date()
    });

    res.status(201).json({ success: true, data: call });
  } catch (err) {
    res.status(err.statusCode || 500).json({ success: false, error: err.message });
  }
};

// ═════════════════════════════════════════════════════════════════════════════
// ANALYTICS
// ═════════════════════════════════════════════════════════════════════════════

exports.analyticsSummary = async (req, res, next) => {
  try {
    const orgId = req.user.organization._id;
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const sevenDaysAgo = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000);

    const [todayStats, weekStats, activeCount] = await Promise.all([
      VoiceAnalyticsSummary.findOne({ organization: orgId, date: today }).lean(),
      VoiceAnalyticsSummary.aggregate([
        { $match: { organization: orgId, date: { $gte: sevenDaysAgo } } },
        {
          $group: {
            _id: null,
            totalCalls: { $sum: '$totalCalls' },
            answeredCalls: { $sum: '$answeredCalls' },
            totalDurationSeconds: { $sum: '$totalDurationSeconds' },
            humanHandoffs: { $sum: '$humanHandoffs' },
            followUpsSent: { $sum: '$followUpsSent' }
          }
        }
      ]),
      CallSession.countDocuments({ organization: orgId, status: 'in-progress' })
    ]);

    const week = weekStats[0] || { totalCalls: 0, answeredCalls: 0, totalDurationSeconds: 0, humanHandoffs: 0, followUpsSent: 0 };
    const answerRate7d = week.totalCalls > 0 ? Math.round((week.answeredCalls / week.totalCalls) * 100) : 0;
    const avgDuration7d = week.totalCalls > 0 ? Math.round(week.totalDurationSeconds / week.totalCalls) : 0;

    res.json({
      success: true,
      data: {
        today: {
          totalCalls: todayStats?.totalCalls || 0,
          answeredCalls: todayStats?.answeredCalls || 0,
          avgDurationSeconds: todayStats?.avgDurationSeconds || 0,
          humanHandoffs: todayStats?.humanHandoffs || 0
        },
        last7Days: {
          totalCalls: week.totalCalls,
          answerRatePct: answerRate7d,
          avgDurationSeconds: avgDuration7d,
          humanHandoffs: week.humanHandoffs,
          followUpsSent: week.followUpsSent
        },
        activeCalls: activeCount,
        topIntents: todayStats?.byIntent || [],
        topSentiments: todayStats?.bySentiment || []
      }
    });
  } catch (err) { next(err); }
};

exports.analyticsTrends = async (req, res, next) => {
  try {
    const orgId = req.user.organization._id;
    const days = Math.min(90, Math.max(7, parseInt(req.query.days, 10) || 30));
    const from = new Date();
    from.setUTCHours(0, 0, 0, 0);
    from.setUTCDate(from.getUTCDate() - (days - 1));

    const rows = await VoiceAnalyticsSummary.find({
      organization: orgId,
      date: { $gte: from }
    })
      .sort({ date: 1 })
      .lean();

    res.json({ success: true, data: rows });
  } catch (err) { next(err); }
};
