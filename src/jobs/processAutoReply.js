const Interaction = require('../models/Interaction');
const Organization = require('../models/Organization');
const IntentBucket = require('../models/IntentBucket');
const aiService = require('../services/aiService');
const cacheService = require('../services/cacheService');
const escalationService = require('../services/escalationService');
const logger = require('../config/logger');
const logEvents = require('../utils/logEvents');
const { isThreadStyleDm } = require('../utils/interactionThreadDm');
const { emitToOrg } = require('../utils/socketEmitter');
const { classifyMessage, countPreviousFallbacks, isInternalAiPayload, isPleasantriesMessage, detectBotConversationLoop } = require('../utils/messageIntentClassifier');
const { updateAIInsights } = require('../services/contactService');
const { shouldSkipAiProcessingForSyncedInteraction } = require('../utils/syncInteractionBackfillGuard');
const { isAgentRecentlyActive, resolveHoldMinutes } = require('../utils/agentActivity');

// ─── Policy enforcement helpers ──────────────────────────────────────────────

/**
 * Persists a user-facing skip reason onto the interaction (fire-and-forget).
 * Only the 5 reasons that are meaningful to show a user in the UI are stored.
 */
const USER_FACING_SKIP_REASONS = new Set([
  'quiet_hours', 'blocked_keyword', 'whatsapp_24h_window_closed',
  'agent_recently_active', 'max_auto_replies_reached'
]);
function persistSkipReason(interactionId, reason) {
  if (!interactionId || !USER_FACING_SKIP_REASONS.has(reason)) return;
  Interaction.updateOne({ _id: interactionId }, { $set: { aiSkipReason: reason } })
    .catch(err => logger.debug('[Auto-reply] Failed to persist skip reason', { err: err.message }));
}

/**
 * Returns true when the current time falls inside the org's quiet-hours window.
 * Quiet hours are compared in the org's configured timezone using a simple
 * HH:MM string comparison (no DST correction needed for ±1h accuracy).
 */
function isInsideQuietHours(quietHours) {
  if (!quietHours?.enabled) return false;
  try {
    const tz = quietHours.timezone || 'Asia/Kolkata';
    const now = new Date();
    const localStr = now.toLocaleTimeString('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false });
    const [hh, mm] = localStr.split(':').map(Number);
    const currentMins = hh * 60 + mm;

    const parseHHMM = (s) => {
      const parts = String(s || '').split(':');
      return (Number(parts[0]) || 0) * 60 + (Number(parts[1]) || 0);
    };
    const startMins = parseHHMM(quietHours.start || '22:00');
    const endMins   = parseHHMM(quietHours.end   || '08:00');

    if (startMins < endMins) {
      // Same-day window (e.g. 02:00–06:00)
      return currentMins >= startMins && currentMins < endMins;
    }
    // Overnight window (e.g. 22:00–08:00)
    return currentMins >= startMins || currentMins < endMins;
  } catch (e) {
    logger.debug('[policy] quiet hours check error (non-fatal)', { error: e.message });
    return false;
  }
}

/**
 * Returns true when the message text contains any of the org's skip keywords.
 */
function containsSkipKeyword(text, skipKeywords) {
  if (!skipKeywords?.length || !text) return false;
  const lower = String(text).toLowerCase();
  return skipKeywords.some((kw) => lower.includes(String(kw).toLowerCase().trim()));
}

/**
 * WhatsApp 24-hour customer-care window check.
 * Meta only allows free-form messages within 24 hours of the last customer inbound.
 * Outside this window autonomous sends are blocked (should use approved templates).
 * Returns true when we are OUTSIDE the window and should not send free-form text.
 */
function isOutsideWhatsApp24hWindow(interaction) {
  if (interaction.platform !== 'whatsapp') return false;
  const lastInboundAt = interaction.metadata?.lastInboundAt;
  if (!lastInboundAt) return false;
  const ageMs = Date.now() - new Date(lastInboundAt).getTime();
  return ageMs > 23.5 * 60 * 60 * 1000; // 23.5h safety margin
}

// ─── Image intent detection ──────────────────────────────────────────────────

const IMAGE_INTENT_RE = /\b(image|images|photo|photos|pic|pics|picture|pictures|catalog|catalogue|tasveer|tasveere|design|designs|show me|dikhao|dikha|bhejo|send me)\b/i;

function isImageRequest(text) {
  return IMAGE_INTENT_RE.test(text || '');
}

// ─── Address text heuristic ──────────────────────────────────────────────────
// Rough classifier: a delivery address is medium-length, not a greeting, not a
// single word. We only capture it when WhatsAppAiState says we are expecting one.

const GREETING_RE = /^\s*(hello|hi|hey|salam|salaam|hola|hy|hii|hanji|ji|ok|okay|thanks|thankyou|thank you|fine|good|great|sure|yes|no|nope|kk|hmm|k)\s*[!.]*\s*$/i;

function looksLikeAddress(text) {
  if (!text) return false;
  const trimmed = text.trim();
  if (trimmed.length < 10) return false;
  if (GREETING_RE.test(trimmed)) return false;
  // Must have at least 2 words (rules out single product names)
  const wordCount = trimmed.split(/\s+/).filter(Boolean).length;
  return wordCount >= 2;
}

// ─── Fallback tone rotation pool ─────────────────────────────────────────────
// Primary message comes from fallbackSettings.message (user-configured).
// These are used as natural-sounding alternatives / repeat-fallback messages.
const FALLBACK_VARIANTS = [
  "Thanks for your message! Our team will take it from here 😊",
  "Got it 👍 I've passed this along to our team — someone will be in touch shortly.",
  "We've received your request — our team will reach out to you soon.",
  "Our team is on it! You'll hear back from us shortly 🙌",
];
const REPEAT_FALLBACK_MSG = "Our team is already looking into this — you'll hear from us soon 😊";

// ─── Human-handoff promise detection (OUTBOUND AI reply) ─────────────────────
// When the AI's own reply tells the customer a human / agent / team will follow
// up ("I've escalated this", "our priority team will reach out", "connecting you
// with a team member", "we'll arrange the pickup"), we MUST actually escalate and
// assign a human — otherwise the AI makes a promise the system never keeps.
// The escalation SCORER only reads the customer's message, so it cannot catch this;
// these patterns read the AI reply that is about to be (or was just) sent.
const HUMAN_HANDOFF_REPLY_PATTERNS = [
  /escalat/i,                                                   // escalate / escalated / escalation
  /priority team/i,
  /someone (will|should|from (our|the) team) .{0,40}?(reach out|reaches out|contact|get back|be in touch|call|assist|help|follow up)/i,
  /(reach out|reaches out|get back|be in touch|contact|follow up with) (to )?you .{0,25}?(shortly|soon|as soon|right away|asap|within \d)/i,
  /(connect|connecting|put you in touch|transfer(?:ring)?) (you )?(with|to) .{0,25}?(team|agent|human|colleague|representative|specialist|member|expert)/i,
  /(our|a) (agent|team member|representative|specialist|colleague|human agent|support (?:agent|team)) .{0,30}?(will|to|is going to|can) .{0,25}?(reach out|contact|get back|be in touch|call|assist|help|follow up|look into)/i,
  /(passed|passing|forwarded|forwarding|raised|escalated) .{0,40}?(this|it|your (?:request|message|query|refund|issue|order|concern|complaint)) .{0,25}?(along|on|to (?:our|the) team|with (?:our|the) team|to (?:a )?(?:team|specialist|agent))/i,
  /(team|agent|someone) .{0,25}?(will|to) .{0,15}?(arrange|arranges|arrange the) .{0,10}?pickup/i,
  /arrange (the|a|your) (pickup|return|refund|replacement)/i,
  /our team will (reach out|contact you|get back|be in touch|take it from here|look into|follow up)/i,
  /if you (don['’]?t|do not|haven['’]?t|have not) hear.{0,12}from us/i,   // customer left waiting on the business
];

/**
 * True when an outbound AI reply promises a human/agent/team will follow up.
 * Used to guarantee a real human is assigned so the AI's promise is kept.
 */
function replyPromisesHumanHandoff(text) {
  if (!text || typeof text !== 'string') return false;
  return HUMAN_HANDOFF_REPLY_PATTERNS.some((re) => re.test(text));
}

/**
 * Route an interaction to the org's designated fallback bucket (isFallback=true).
 * No-op if no such bucket exists — never throws.
 */
async function routeToFallbackBucket(interaction, organizationId) {
  try {
    const bucket = await IntentBucket.findOne({
      organization: organizationId,
      isFallback: true,
      isActive: true
    }).select('_id').lean();
    if (bucket) {
      interaction.intentBucket = bucket._id;
      interaction.bucketAssignedBy = 'ai';
      await interaction.save();
    }
  } catch (err) {
    logger.warn('[Auto-reply] routeToFallbackBucket error (non-fatal)', { error: err.message });
  }
}

/**
 * Guarantee a real human agent is assigned + notified for this interaction.
 *
 * Called when the AI reply promised a human follow-up. `escalateInteraction` only
 * auto-assigns when `escalationSettings.autoAssign` is on; this closes the gap so
 * the promise is kept even when auto-assign is off (forceFallback bypasses the
 * 'manual' assignment restriction). No-op if a human is already assigned — never throws.
 */
async function ensureHumanAssigned(interaction, organization) {
  try {
    const already = await Interaction.findById(interaction._id).select('assignedTo').lean();
    if (already?.assignedTo) return; // escalateInteraction (autoAssign) already handled it

    const agent = await escalationService.assignToAgent(interaction, organization, { forceFallback: true });
    if (agent) {
      const notify =
        organization.autoReplySettings?.fallbackSettings?.notifyByEmail ??
        organization.escalationSettings?.notifyAgents ?? true;
      if (notify) {
        await escalationService.notifyAgent(agent, interaction, organization);
      }
      logger.info('[Auto-reply] Guaranteed human assignment after AI handoff promise', {
        interactionId: interaction._id?.toString(),
        agent: agent._id?.toString()
      });
    } else {
      // requiresHumanResponse is still set (via escalateInteraction), so it shows in the
      // "needs human" queue even if there is no agent in the pool to receive it.
      logger.warn('[Auto-reply] AI promised a human but no agent available to assign', {
        interactionId: interaction._id?.toString()
      });
    }
  } catch (e) {
    logger.warn('[Auto-reply] ensureHumanAssigned error (non-fatal)', { error: e.message });
  }
}

/**
 * Pick the appropriate fallback message based on how many times a fallback
 * has already been sent in this conversation.
 *
 * @param {string} primaryMsg - user-configured fallback message
 * @param {Array}  replies    - interaction.replies array
 * @returns {{ message: string, shouldSend: boolean }}
 */
function selectFallbackMessage(primaryMsg, replies = []) {
  const previousCount = countPreviousFallbacks(replies, primaryMsg);
  if (previousCount === 0) {
    return { message: primaryMsg || FALLBACK_VARIANTS[0], shouldSend: true };
  }
  if (previousCount === 1) {
    return { message: REPEAT_FALLBACK_MSG, shouldSend: true };
  }
  // Already sent twice — don't spam the customer
  return { message: null, shouldSend: false };
}

/**
 * Process auto-reply job
 * This job handles generating and optionally sending auto-replies
 */
module.exports = async function processAutoReply(job) {
  const { type, organizationId, interactionId } = job.data;
  const jobLogger = logger.createChild({ 
    module: 'processAutoReply', 
    jobId: job.id,
    orgId: organizationId,
    type
  });
  
  try {
    // Get organization settings
    const organization = await Organization.findById(organizationId);
    
    if (!organization || !organization.autoReplySettings.enabled) {
      jobLogger.info('Auto-reply disabled for organization');
      return { success: false, reason: 'Auto-reply disabled' };
    }

    // Check daily limit
    const today = new Date().toDateString();
    const lastReset = organization.autoReplySettings.lastReplyResetDate 
      ? new Date(organization.autoReplySettings.lastReplyResetDate).toDateString()
      : null;

    if (lastReset !== today) {
      organization.autoReplySettings.repliesCountToday = 0;
      organization.autoReplySettings.lastReplyResetDate = new Date();
    }

    if (organization.autoReplySettings.repliesCountToday >= organization.autoReplySettings.maxRepliesPerDay) {
      jobLogger.info('Daily auto-reply limit reached', { 
        limit: organization.autoReplySettings.maxRepliesPerDay 
      });
      return { success: false, reason: 'Daily limit reached' };
    }

    let processedCount = 0;
    let sentCount = 0;
    let skippedCount = 0;

    if (type === 'single' && interactionId) {
      // Process single interaction (webhook-triggered)
      const result = await processSingleInteraction(interactionId, organization, job.data);
      if (result.sent) sentCount++;
      else if (result.skipped) skippedCount++;
      else processedCount++;
    } else if (type === 'scheduled') {
      // Process batch of eligible interactions (scheduled)
      const result = await processBatchInteractions(organizationId, organization);
      processedCount = result.processed;
      sentCount = result.sent;
      skippedCount = result.skipped;
    }

    // Update organization
    organization.autoReplySettings.repliesCountToday += sentCount;
    if (type === 'scheduled') {
      organization.autoReplySettings.lastScheduledRun = new Date();
    }
    await organization.save();

    await cacheService.invalidateInteractionCaches(organizationId);

    // Only log at info level if something was sent or processed
    // Use debug level for skipped-only jobs to reduce log spam
    if (sentCount > 0 || processedCount > 0) {
      jobLogger.info('Auto-reply job completed', {
        sent: sentCount,
        processed: processedCount,
        skipped: skippedCount,
        todayTotal: organization.autoReplySettings.repliesCountToday,
        dailyLimit: organization.autoReplySettings.maxRepliesPerDay
      });
    } else {
      jobLogger.debug('Auto-reply job completed (all skipped)', {
        type,
        skipped: skippedCount
      });
    }

    return {
      success: true,
      processed: processedCount,
      sent: sentCount,
      skipped: skippedCount
    };

  } catch (error) {
    jobLogger.error('Auto-reply job error', { 
      error: error.message,
      stack: error.stack
    });
    throw error;
  }
};

/**
 * Process a single interaction (webhook-triggered or recent sync)
 */
async function processSingleInteraction(interactionId, organization, jobData = {}) {
  try {
    const interaction = await Interaction.findById(interactionId)
      .populate('platformConnection');

    if (!interaction) {
      return { skipped: true, reason: 'Interaction not found' };
    }

    // Safety-net guard: never auto-reply to historical or old synced interactions.
    // Primary guard is in platformSyncService.syncPlatform; this catches queued jobs
    // or code paths that bypass that check (e.g. stale jobs, duplicate queue).
    if (shouldSkipAiProcessingForSyncedInteraction(interaction, interaction.platformConnection)) {
      const msgDate = interaction.platformCreatedAt || interaction.createdAt;
      const conn = interaction.platformConnection;
      return {
        skipped: true,
        reason: `Synced historical/old interaction (msgDate=${msgDate}, connectedAt=${conn?.connectedAt}, createdAt=${conn?.createdAt})`
      };
    }

    const threadDm = isThreadStyleDm(interaction);

    if (!threadDm && interaction.replies && interaction.replies.length > 0) {
      return { skipped: true, reason: 'Already has replies' };
    }

    // Thread DMs: a new inbound message sets status to unread via webhook; if we still see
    // replied/resolved, a human (or prior send) already handled this turn — skip delayed job.
    if (interaction.status === 'replied' || interaction.status === 'resolved') {
      return { skipped: true, reason: `Status is ${interaction.status}` };
    }

    // IMPORTANT: Don't reply to replies that are replies to our own replies
    // Check 1: If this interaction has a parentId, check if the parent has a system reply
    if (interaction.parentId) {
      // Find the parent interaction
      // Note: parentId is a platform ID (e.g., YouTube comment ID), not a MongoDB ObjectId
      // So we only search by platformId, not _id
      const parentInteraction = await Interaction.findOne({
        platformId: interaction.parentId,
        organization: organization._id
      });

      if (parentInteraction) {
        // Check if parent has a system-generated reply
        if (parentInteraction.replies && parentInteraction.replies.length > 0) {
          const hasSystemReply = parentInteraction.replies.some(reply => reply.wasAutoGenerated === true);
          if (hasSystemReply) {
            return { skipped: true, reason: 'Parent comment already has system reply' };
          }
        }

        // Check if the parent's author is the same as the platform connection's user
        // This would indicate the parent is a reply from the system itself
        if (interaction.platformConnection && parentInteraction.author) {
          const platformConnection = interaction.platformConnection;
          // For YouTube: Check if parent author matches the channel
          if (interaction.platform === 'youtube' && platformConnection.platformData?.channelId) {
            if (parentInteraction.author.platformId === platformConnection.platformData.channelId) {
              return { skipped: true, reason: 'Parent comment is from our own account' };
            }
          }
          // For Instagram: Check if parent author matches the business account
          if (interaction.platform === 'instagram' && platformConnection.platformData?.businessAccountId) {
            if (parentInteraction.author.platformId === platformConnection.platformData.businessAccountId) {
              return { skipped: true, reason: 'Parent comment is from our own account' };
            }
          }
        }
      }
    }

    // Check 2: Don't reply to interactions that are from our own account
    if (interaction.platformConnection && interaction.author) {
      const platformConnection = interaction.platformConnection;
      // For YouTube: Check if author matches the channel
      if (interaction.platform === 'youtube' && platformConnection.platformData?.channelId) {
        if (interaction.author.platformId === platformConnection.platformData.channelId) {
          return { skipped: true, reason: 'Interaction is from our own account' };
        }
      }
      // For Instagram: Check if author matches the business account
      if (interaction.platform === 'instagram' && platformConnection.platformData?.businessAccountId) {
        if (interaction.author.platformId === platformConnection.platformData.businessAccountId) {
          return { skipped: true, reason: 'Interaction is from our own account' };
        }
      }
    }

    // Evaluate escalation rules now so we know whether to route to human,
    // but DO NOT skip the reply — customers should always receive an acknowledgment.
    const escalationCheck = await escalationService.shouldEscalate(
      interaction,
      organization
    );

    // Reload interaction so sentiment / intent from processAI match org filters
    const interactionForReply = await Interaction.findById(interactionId)
      .populate('platformConnection');
    if (!interactionForReply) {
      // Nothing to reply to — still escalate if needed
      if (escalationCheck.shouldEscalate) {
        await escalationService.escalateInteraction(
          interaction, organization,
          escalationCheck.reasons, escalationCheck.type, escalationCheck.metadata
        );
      }
      return { skipped: true, reason: 'Interaction not found' };
    }
    const threadDmReply = isThreadStyleDm(interactionForReply);

    const expectedLastMid = jobData.expectedLastMid;
    if (
      threadDmReply &&
      expectedLastMid &&
      interactionForReply.metadata?.lastMid != null &&
      String(interactionForReply.metadata.lastMid) !== String(expectedLastMid)
    ) {
      logger.info('[Auto-reply] Skipped — stale job (newer inbound message in thread)', {
        interactionId: interactionForReply._id?.toString(),
        expectedLastMid: String(expectedLastMid),
        currentLastMid: String(interactionForReply.metadata.lastMid)
      });
      return { skipped: true, reason: 'Stale auto-reply job (newer inbound message)' };
    }

    if (!threadDmReply && interactionForReply.replies && interactionForReply.replies.length > 0) {
      if (escalationCheck.shouldEscalate) {
        await escalationService.escalateInteraction(
          interactionForReply, organization,
          escalationCheck.reasons, escalationCheck.type, escalationCheck.metadata
        );
      }
      return { skipped: true, reason: 'Already has replies' };
    }
    if (interactionForReply.status === 'replied' || interactionForReply.status === 'resolved') {
      if (escalationCheck.shouldEscalate) {
        await escalationService.escalateInteraction(
          interactionForReply, organization,
          escalationCheck.reasons, escalationCheck.type, escalationCheck.metadata
        );
      }
      return { skipped: true, reason: `Status is ${interactionForReply.status}` };
    }

    // ─── POLICY GATE: quiet hours ─────────────────────────────────────────────
    if (isInsideQuietHours(organization.autoReplySettings?.quietHours)) {
      logger.info('[Auto-reply] Skipped — quiet hours active', {
        interactionId: interactionForReply._id?.toString(),
        quietHours: organization.autoReplySettings.quietHours
      });
      persistSkipReason(interactionForReply._id, 'quiet_hours');
      return { skipped: true, reason: 'quiet_hours' };
    }

    // ─── POLICY GATE: skip negative keywords ────────────────────────────────
    const skipKws = organization.autoReplySettings?.skipNegativeKeywords;
    if (containsSkipKeyword(interactionForReply.content, skipKws)) {
      logger.info('[Auto-reply] Skipped — message contains a blocked keyword', {
        interactionId: interactionForReply._id?.toString()
      });
      persistSkipReason(interactionForReply._id, 'blocked_keyword');
      return { skipped: true, reason: 'blocked_keyword' };
    }

    // ─── POLICY GATE: WhatsApp 24-hour customer-care window ─────────────────
    // Meta prohibits free-form messages after the 24h window closes. Outside this
    // window the AI must stay silent (use approved templates manually instead).
    if (isOutsideWhatsApp24hWindow(interactionForReply)) {
      logger.info('[Auto-reply] Skipped — outside WhatsApp 24h customer-care window', {
        interactionId: interactionForReply._id?.toString(),
        lastInboundAt: interactionForReply.metadata?.lastInboundAt
      });
      persistSkipReason(interactionForReply._id, 'whatsapp_24h_window_closed');
      return { skipped: true, reason: 'whatsapp_24h_window_closed' };
    }

    // Hold the AI back while a human agent is actively handling this chat.
    // Fires when an agent OPENED (readAt/readBy) or manually REPLIED to the thread
    // within `agentActiveHoldMinutes` (default 5). Unlike the old `isRead` check,
    // these signals survive a new inbound (which resets isRead=false), so it also
    // catches a mid-conversation agent who is typing but hasn't re-opened the new
    // message. Time-based, so the chat auto-recovers if the agent walks away.
    const holdMinutes = resolveHoldMinutes(organization.autoReplySettings);
    const agentHold = isAgentRecentlyActive(interactionForReply, holdMinutes);
    if (agentHold.active) {
      logger.info('[Auto-reply] Skipped — human agent recently active (agent_active_hold)', {
        interactionId: interactionForReply._id?.toString(),
        source: agentHold.source,
        lastActivityAt: agentHold.at,
        ageMs: agentHold.ageMs,
        holdMinutes
      });
      // Still escalate if rules triggered, but do not generate an AI reply.
      if (escalationCheck.shouldEscalate) {
        await escalationService.escalateInteraction(
          interactionForReply, organization,
          escalationCheck.reasons, escalationCheck.type, escalationCheck.metadata
        );
      }
      persistSkipReason(interactionForReply._id, 'agent_recently_active');
      return { skipped: true, reason: 'agent_recently_active' };
    } ────────────────────────────────
    // Classify the message BEFORE spending AI credits. This handles:
    //   - Closing / satisfied messages → mark resolved, no reply
    //   - Small talk (hi, hello) → always handle with AI, skip no-KB fallback
    //   - Gibberish → send fallback immediately, no AI call
    const msgType = classifyMessage(interactionForReply.content);
    const isSmallTalk = msgType === 'small_talk';

    if (msgType === 'closing') {
      logger.info('[Auto-reply] Layer 0: closing message detected — resolving conversation silently', {
        interactionId: interactionForReply._id?.toString(),
        content: interactionForReply.content?.slice(0, 50)
      });
      await Interaction.updateOne(
        { _id: interactionForReply._id },
        { $set: { status: 'resolved', resolvedAt: new Date(), chatOpen: false } }
      );
      try {
        const fresh = await Interaction.findById(interactionForReply._id).lean();
        if (fresh) emitToOrg(organization._id.toString(), 'interaction_updated', { interaction: fresh });
      } catch (_e) {}
      return { skipped: true, reason: 'conversation_closing_resolved' };
    }

    if (msgType === 'gibberish') {
      logger.info('[Auto-reply] Layer 0: gibberish message — immediate fallback without AI call', {
        interactionId: interactionForReply._id?.toString()
      });
      const fallback = organization.autoReplySettings?.fallbackSettings;
      if (fallback?.enabled) {
        const { message: fbMsg, shouldSend } = selectFallbackMessage(
          fallback.message, interactionForReply.replies
        );
        if (shouldSend && fbMsg) {
          if (organization.autoReplySettings.enabled) {
            await sendReplyToPlatform(interactionForReply, fbMsg, organization);
          }
          try {
            await interactionForReply.escalateToHuman(['Gibberish / unreadable message'], 'ai_fallback', {});
          } catch (_e) {}
          if (fallback.assignToAgent) {
            try {
              const agent = await escalationService.assignToAgent(interactionForReply, organization, { forceFallback: true });
              if (agent && fallback.notifyByEmail) {
                await escalationService.notifyAgent(agent, interactionForReply, organization);
              }
            } catch (_e) {}
          }
        }
        try {
          const fresh = await Interaction.findById(interactionForReply._id).lean();
          if (fresh) emitToOrg(organization._id.toString(), 'interaction_updated', { interaction: fresh });
        } catch (_e) {}
        return { sent: shouldSend, escalated: true, reason: 'gibberish_fallback' };
      }
      return { skipped: true, reason: 'gibberish_no_fallback_configured' };
    }

    // ─── LAYER 0.5: Bot-to-bot pleasantries loop detection ────────────────────
    // Detects automated ping-pong loops where the other side is also a bot replying
    // with polite closings. Resolves the conversation silently without any reply or
    // AI credit spend. Must run BEFORE Layer 1 / Layer 3 / AI call.
    if (isPleasantriesMessage(interactionForReply.content) || detectBotConversationLoop(interactionForReply)) {
      logger.info('[Auto-reply] Layer 0.5: pleasantries/bot loop detected — resolving silently', {
        interactionId: interactionForReply._id?.toString(),
        content: interactionForReply.content?.slice(0, 60)
      });
      await Interaction.updateOne(
        { _id: interactionForReply._id },
        { $set: { status: 'resolved', resolvedAt: new Date(), chatOpen: false } }
      );
      try {
        const fresh = await Interaction.findById(interactionForReply._id).lean();
        if (fresh) emitToOrg(organization._id.toString(), 'interaction_updated', { interaction: fresh });
      } catch (_e) {}
      return { skipped: true, reason: 'bot_pleasantries_loop_resolved' };
    }

    // ─── LAYER 0.6: Max auto-reply hard stop ──────────────────────────────────
    // Enforce reply limit BEFORE generating an AI reply so bot-loop conversations
    // cannot consume unlimited credits by exploiting the "send first, escalate second"
    // ordering used later in the pipeline. Applies only to thread DMs.
    const maxAutoReplies = organization.escalationSettings?.maxAutoReplies ?? 3;
    if (threadDmReply && (interactionForReply.autoReplyCount || 0) >= maxAutoReplies) {
      logger.info('[Auto-reply] Layer 0.6: max auto-replies reached — escalating without new reply', {
        interactionId: interactionForReply._id?.toString(),
        autoReplyCount: interactionForReply.autoReplyCount,
        maxAutoReplies
      });
      await escalationService.escalateInteraction(
        interactionForReply, organization,
        [`Max auto-replies reached (${interactionForReply.autoReplyCount}/${maxAutoReplies})`],
        'reply_limit',
        {}
      );
      try {
        const fresh = await Interaction.findById(interactionForReply._id).lean();
        if (fresh) emitToOrg(organization._id.toString(), 'interaction_updated', { interaction: fresh });
      } catch (_e) {}
      persistSkipReason(interactionForReply._id, 'max_auto_replies_reached');
      return { skipped: true, escalated: true, reason: 'max_auto_replies_reached' };
    }

    // ─── LAYER 3: Conversation loop detection ──────────────────────────────────
    // For thread-style DMs where the AI has already replied at least once:
    // increment sameTopicReplies so the escalation scorer can detect unresolved loops.
    if (threadDmReply && (interactionForReply.autoReplyCount || 0) >= 1) {
      try {
        await Interaction.updateOne(
          { _id: interactionForReply._id },
          { $inc: { 'escalationMetadata.sameTopicReplies': 1 } }
        );
        // Keep in-memory copy in sync for the escalation check below
        if (!interactionForReply.escalationMetadata) {
          interactionForReply.escalationMetadata = {};
        }
        interactionForReply.escalationMetadata.sameTopicReplies =
          (interactionForReply.escalationMetadata.sameTopicReplies || 0) + 1;

        logger.info('[Auto-reply] Layer 3: sameTopicReplies incremented', {
          interactionId: interactionForReply._id?.toString(),
          sameTopicReplies: interactionForReply.escalationMetadata.sameTopicReplies
        });
      } catch (loopErr) {
        logger.warn('[Auto-reply] Layer 3: failed to increment sameTopicReplies', { error: loopErr.message });
      }
    }

    // ─── LAYER 1: Intent-based hard routing ────────────────────────────────────
    // Certain intent buckets (billing disputes, account security, legal, etc.) must
    // always skip AI and go directly to a human agent — zero false positives.
    if (organization.escalationSettings?.enabled) {
      const intentRouting = escalationService.checkIntentRouting(interactionForReply, organization);
      if (intentRouting.shouldRoute) {
        logger.info('[Auto-reply] Layer 1: intent routing to human — skipping AI generation', {
          interactionId: interactionForReply._id?.toString(),
          reason: intentRouting.reason,
          bucket: interactionForReply.intentBucket?.toString()
        });

        // Send handoff acknowledgment to customer first
        const handoffMsg =
          organization.escalationSettings?.handoffMessageTemplate ||
          "Thank you for reaching out. I'm connecting you with a team member who can better assist you with this.";
        let handoffSent = false;
        if (organization.autoReplySettings.enabled) {
          handoffSent = await sendReplyToPlatform(interactionForReply, handoffMsg, organization);
        }

        // Then escalate to human
        await escalationService.escalateInteraction(
          interactionForReply, organization,
          [intentRouting.reason], 'intent_routing', { intentBucket: interactionForReply.intentBucket?.toString() }
        );

        // Emit final state so the frontend list reflects the definitive status after all DB writes
        try {
          const fresh = await Interaction.findById(interactionForReply._id).lean();
          if (fresh) emitToOrg(organization._id.toString(), 'interaction_updated', { interaction: fresh });
        } catch (_e) {}

        logger.info('[Auto-reply] Layer 1: escalated after intent routing', {
          interactionId: interactionForReply._id?.toString(),
          handoffSent
        });
        return { sent: handoffSent, escalated: true, reason: 'intent_routing' };
      }
    }

    // ─── POLICY GATE: requireApproval / autoSend ────────────────────────────
    // When requireApproval is true or autoSend is false, do not automatically
    // deliver the reply. The AI reply is still generated for the inbox agent to
    // review, but sending is blocked here. We store it on the interaction so the
    // agent can review and click "Send" manually.
    const requireApproval = organization.autoReplySettings?.requireApproval === true;
    const autoSend = organization.autoReplySettings?.autoSend !== false; // default true

    // ─── WHATSAPP SPECIALIZATION: address capture ─────────────────────────────
    // If the AI state says we are awaiting a delivery address from this customer,
    // and the inbound message looks like an address (not a greeting, not too short),
    // capture it, save to the pending CommerceOrder, and send a confirmation —
    // without spending any LLM tokens.
    if (
      interactionForReply.platform === 'whatsapp' &&
      isThreadStyleDm(interactionForReply) &&
      looksLikeAddress(interactionForReply.content)
    ) {
      try {
        const WhatsAppAiState = require('../models/WhatsAppAiState');
        const phoneNumberId = interactionForReply.metadata?.phoneNumberId;
        const senderId = interactionForReply.author?.platformId
          || (interactionForReply.platformId?.startsWith('dm_')
            ? interactionForReply.platformId.split('_')[2]
            : null);

        if (phoneNumberId && senderId) {
          const aiState = await WhatsAppAiState.findOne({
            organization: organization._id,
            phoneNumberId,
            senderId,
            pendingAction: 'awaiting_shipping_address'
          }).lean();

          if (aiState?.entityId) {
            const CommerceOrder = require('../models/CommerceOrder');
            const addressText = interactionForReply.content.trim();
            const updated = await CommerceOrder.findOneAndUpdate(
              { _id: aiState.entityId, organization: organization._id },
              {
                $set: {
                  shippingAddress: addressText,
                  'shipping.raw': addressText
                },
                $push: {
                  statusHistory: {
                    status: 'address_captured',
                    at: new Date(),
                    note: `Delivery address captured via WhatsApp: ${addressText.substring(0, 80)}`
                  }
                }
              },
              { new: true }
            ).lean();

            if (updated) {
              // Clear the AI state — address is now captured
              await WhatsAppAiState.clearPendingAction({
                organization: organization._id,
                phoneNumberId,
                senderId
              });

              // Send deterministic confirmation (no LLM)
              const confText =
                `✅ Perfect! We've recorded your delivery address:\n\n${addressText}\n\n` +
                `Your order ${updated.displayRef || ''} is being processed. We'll reach out if we need anything else. Thank you! 🙌`;

              if (autoSend && !requireApproval) {
                const sent = await sendReplyToPlatform(interactionForReply, confText, organization);
                if (sent) {
                  logger.info('[Auto-reply] Address captured and confirmation sent', {
                    interactionId: interactionForReply._id?.toString(),
                    orderId: aiState.entityId?.toString()
                  });
                  return { sent: true, reason: 'address_captured' };
                }
              }
            }
          }
        }
      } catch (addrErr) {
        logger.warn('[Auto-reply] Address capture failed (non-fatal) — falling through to AI', { error: addrErr.message });
      }
    }

    // ─── WHATSAPP SPECIALIZATION: image intent — deterministic no-hallucination ─
    // Detect image/photo requests before the LLM. If the customer is asking for
    // product images, we check the catalog directly and either send a catalog card
    // or an honest "no image available" message — no LLM guessing.
    if (
      interactionForReply.platform === 'whatsapp' &&
      isThreadStyleDm(interactionForReply) &&
      isImageRequest(interactionForReply.content)
    ) {
      try {
        const WhatsAppAiState = require('../models/WhatsAppAiState');
        const phoneNumberId = interactionForReply.metadata?.phoneNumberId;
        const senderId = interactionForReply.author?.platformId
          || (interactionForReply.platformId?.startsWith('dm_')
            ? interactionForReply.platformId.split('_')[2]
            : null);

        let productToShow = null;

        // 1. Check if AI state has a recently selected product
        if (phoneNumberId && senderId) {
          const aiState = await WhatsAppAiState.findOne({
            organization: organization._id,
            phoneNumberId,
            senderId
          }).lean();
          if (aiState?.selectedProductId) {
            const Product = require('../models/Product');
            productToShow = await Product.findOne({
              _id: aiState.selectedProductId,
              organization: organization._id,
              isActive: true
            }).select('name sku images currency price').lean();
          }
        }

        // 2. Fallback: search for a product by name mentioned in the message
        if (!productToShow) {
          const { searchProducts } = require('../services/ai/productSearchService');
          const { products, fromFallback } = await searchProducts(
            organization._id.toString(),
            interactionForReply.content,
            { limit: 1 }
          );
          if (products.length > 0 && !fromFallback) productToShow = products[0];
        }

        if (productToShow) {
          const images = Array.isArray(productToShow.images) ? productToShow.images : [];
          const validImageUrl = images.find((img) => {
            const url = typeof img === 'string' ? img : img?.url || img?.src || '';
            return typeof url === 'string' && url.startsWith('https://');
          });
          const rawUrl = validImageUrl
            ? (typeof validImageUrl === 'string' ? validImageUrl : validImageUrl?.url || validImageUrl?.src)
            : null;

          let imageHandled = false;

          if (rawUrl) {
            // Send product card via WhatsApp catalog
            try {
              const PlatformConnection = require('../models/PlatformConnection');
              const conn = await PlatformConnection.findOne({
                organization: organization._id,
                platform: 'whatsapp',
                isActive: true
              }).lean();
              const catalogId = conn?.platformData?.catalogId || conn?.metadata?.catalogId;

              if (conn && catalogId) {
                const whatsappCatalogService = require('../integrations/whatsapp/whatsappCatalogService');
                const retailerId = productToShow.sku || productToShow._id.toString();
                await whatsappCatalogService.sendProductMessage(
                  conn,
                  senderId,
                  catalogId,
                  retailerId,
                  `Here's ${productToShow.name}! Let me know if you'd like to place an order.`
                );
                imageHandled = true;
              }
            } catch (catalogErr) {
              logger.debug('[Auto-reply] Image catalog send failed — falling back to text', { error: catalogErr.message });
            }
          }

          if (!imageHandled) {
            // Truthful "no image" message — never hallucinate
            const noImageText =
              `I'm sorry, product images aren't available here right now for *${productToShow.name}*.\n\n` +
              `I can share all the details though:\n` +
              `• Price: ${productToShow.currency || ''} ${productToShow.price || 'on request'}\n\n` +
              `Would you like to know more, or shall I connect you with our team? 😊`;

            if (autoSend && !requireApproval) {
              const sent = await sendReplyToPlatform(interactionForReply, noImageText, organization);
              if (sent) {
                logger.info('[Auto-reply] Truthful no-image reply sent', {
                  interactionId: interactionForReply._id?.toString(),
                  product: productToShow.name
                });
                return { sent: true, reason: 'image_not_available_honest_reply' };
              }
            }
          } else {
            // Catalog card was sent — no further reply needed
            logger.info('[Auto-reply] Product image card sent via catalog', {
              interactionId: interactionForReply._id?.toString(),
              product: productToShow.name
            });
            return { sent: true, reason: 'image_catalog_card_sent' };
          }
        }
      } catch (imgErr) {
        logger.warn('[Auto-reply] Image intent handler failed (non-fatal) — falling through to AI', { error: imgErr.message });
      }
    }

    // Generate auto-reply
    const autoReply = await aiService.generateAutoReply(
      interactionForReply,
      organization._id,
      organization
    );

    // ─── LAYER 2: AI self-assessment — unresolvable signal ────────────────────
    // The LLM assessed that it cannot resolve this without private account/system data.
    // Prefer fallbackSettings (newer, configurable), fall back to handoffMessageTemplate.
    if (autoReply.eligible && autoReply.resolvable === false) {
      logger.info('[Auto-reply] Layer 2: AI unresolvable — routing to human', {
        interactionId: interactionForReply._id?.toString(),
        reason: autoReply.resolvableReason
      });

      const fallback = organization.autoReplySettings?.fallbackSettings;
      const primaryMsg = (fallback?.enabled && fallback.message?.trim())
        ? fallback.message.trim()
        : (organization.escalationSettings?.handoffMessageTemplate ||
           "Thank you for reaching out. I'm connecting you with a team member who can better assist you with this.");

      const { message: handoffMsg, shouldSend: shouldSendHandoff } = selectFallbackMessage(
        primaryMsg, interactionForReply.replies
      );

      let handoffSent = false;
          if (shouldSendHandoff && handoffMsg && organization.autoReplySettings.enabled) {
        handoffSent = await sendReplyToPlatform(interactionForReply, handoffMsg, organization);
      }

      await escalationService.escalateInteraction(
        interactionForReply, organization,
        [`AI self-assessed as unresolvable: ${autoReply.resolvableReason || 'requires private data'}`],
        'ai_unresolvable',
        { resolvableReason: autoReply.resolvableReason }
      );

      // Auto-assign agent and email notification (from fallbackSettings)
      if (fallback?.enabled && fallback.assignToAgent) {
        try {
          const assignedAgent = await escalationService.assignToAgent(interactionForReply, organization, { forceFallback: true });
          if (assignedAgent) {
            console.log(`👤 [Auto-reply L2] Assigned to agent: ${assignedAgent.firstName} ${assignedAgent.lastName}`);
            if (fallback.notifyByEmail) {
              await escalationService.notifyAgent(assignedAgent, interactionForReply, organization);
            }
          }
        } catch (assignErr) {
          logger.warn('[Auto-reply] Layer 2: agent assignment error (non-fatal)', { error: assignErr.message });
        }
      }

      // Emit final state so the frontend list reflects the definitive status after all DB writes
      try {
        const fresh = await Interaction.findById(interactionForReply._id).lean();
        if (fresh) emitToOrg(organization._id.toString(), 'interaction_updated', { interaction: fresh });
      } catch (_e) {}

      await routeToFallbackBucket(interactionForReply, organization._id);

      logger.info('[Auto-reply] Layer 2: escalated after AI unresolvable assessment', {
        interactionId: interactionForReply._id?.toString(),
        handoffSent
      });
      return { sent: handoffSent, escalated: true, reason: 'ai_unresolvable' };
    }

    if (!autoReply.eligible) {
      // Reply not eligible (settings gate) — log clearly so the user can diagnose in console
      logger.info('[Auto-reply] Not eligible — check org auto-reply settings', {
        interactionId: interactionForReply._id?.toString(),
        platform: interactionForReply.platform,
        type: interactionForReply.type,
        sentiment: interactionForReply.sentiment,
        intent: interactionForReply.intent,
        reason: autoReply.reason,
        hint: 'Check: sentimentFilter, enabledPlatforms, enabledTypes in Auto-Reply settings'
      });
      console.warn(`⚠️  [Auto-reply] Not eligible for interaction ${interactionForReply._id}: ${autoReply.reason}`);

      // Escalate to human if escalation rules triggered
      if (escalationCheck.shouldEscalate) {
        await escalationService.escalateInteraction(
          interactionForReply, organization,
          escalationCheck.reasons, escalationCheck.type, escalationCheck.metadata
        );
      }

      // ─── FALLBACK: Send message + assign agent + notify when AI cannot respond ──
      const fallback = organization.autoReplySettings?.fallbackSettings;
      if (fallback?.enabled) {
        try {
          const primaryFbMsg = (fallback.message && fallback.message.trim())
            ? fallback.message.trim()
            : 'Our Agent will contact you within 24 hours.';

          const { message: fallbackMsg, shouldSend } = selectFallbackMessage(
            primaryFbMsg, interactionForReply.replies
          );

          // Send fallback message to the customer on the platform (with response memory)
          if (shouldSend && fallbackMsg && organization.autoReplySettings.enabled) {
            await sendReplyToPlatform(interactionForReply, fallbackMsg, organization);
            logger.info('[Auto-reply] Fallback message sent to platform', {
              interactionId: interactionForReply._id?.toString(),
              message: fallbackMsg
            });
          } else if (!shouldSend) {
            logger.info('[Auto-reply] Fallback suppressed — already sent twice in this conversation', {
              interactionId: interactionForReply._id?.toString()
            });
          }

          // Mark interaction as requiring human response
          await interactionForReply.escalateToHuman(
            [`AI not eligible: ${autoReply.reason}`], 'ai_fallback', { reason: autoReply.reason }
          );

          await routeToFallbackBucket(interactionForReply, organization._id);

          // Assign to an available agent and email them (independent of escalationSettings)
          if (fallback.assignToAgent) {
            const assignedAgent = await escalationService.assignToAgent(interactionForReply, organization, { forceFallback: true });
            if (assignedAgent) {
              console.log(`👤 [Auto-reply Fallback] Assigned to agent: ${assignedAgent.firstName} ${assignedAgent.lastName}`);
              if (fallback.notifyByEmail) {
                await escalationService.notifyAgent(assignedAgent, interactionForReply, organization);
                logger.info('[Auto-reply] Fallback: agent notified by email', {
                  interactionId: interactionForReply._id?.toString(),
                  agent: assignedAgent._id?.toString()
                });
              }
            }
          }

          // Emit final state so the frontend list reflects the definitive status after all DB writes
          try {
            const fresh = await Interaction.findById(interactionForReply._id).lean();
            if (fresh) emitToOrg(organization._id.toString(), 'interaction_updated', { interaction: fresh });
          } catch (_e) {}

          return { sent: !!shouldSend, escalated: true, reason: 'ai_fallback' };
        } catch (fallbackErr) {
          logger.warn('[Auto-reply] Fallback handler error (non-fatal)', {
            interactionId: interactionForReply._id?.toString(),
            error: fallbackErr.message
          });
        }
      }

      return { skipped: true, reason: autoReply.reason };
    }

    logEvents.autoReply.generated({
      interactionId: interactionForReply._id,
      confidence: autoReply.response.confidence,
      sentiment: interactionForReply.sentiment,
      length: autoReply.response.content.length
    });
    logger.info('[Auto-reply] Generated reply details', {
      interactionId: interactionForReply._id?.toString(),
      platform: interactionForReply.platform,
      type: interactionForReply.type,
      usedKnowledgeBase: !!autoReply.response.usedKnowledgeBase,
      knowledgeBaseCount: autoReply.response.knowledgeBaseCount || 0,
      knowledgeBaseFallback: !!autoReply.response.knowledgeBaseFallback,
      confidence: autoReply.response.confidence,
      messageType: autoReply.response.messageType,
      noReply: !!autoReply.response.noReply
    });

    // ─── LAYER 2.25: AI-detected closing / no-reply signal ─────────────────────
    // When the AI itself classifies the message as a closing/satisfied signal
    // (e.g. "okay thankyou", "got it", "shukriya") AND requests noReply,
    // resolve the conversation silently without sending any message.
    // Layer 0 catches most of these, but the AI catches edge cases Layer 0 misses.
    if (autoReply.response.noReply === true || autoReply.response.messageType === 'closing') {
      logger.info('[Auto-reply] Layer 2.25: AI detected closing/no-reply — resolving conversation silently', {
        interactionId: interactionForReply._id?.toString(),
        messageType: autoReply.response.messageType
      });
      await Interaction.updateOne(
        { _id: interactionForReply._id },
        { $set: { status: 'resolved', resolvedAt: new Date(), chatOpen: false } }
      );
      try {
        const fresh = await Interaction.findById(interactionForReply._id).lean();
        if (fresh) emitToOrg(organization._id.toString(), 'interaction_updated', { interaction: fresh });
      } catch (_e) {}
      return { skipped: true, reason: 'ai_detected_closing' };
    }

    // ─── LAYER 2.5: No KB context in prompt — fallback instead of generic AI answer ──
    // Trigger when fallback is enabled AND there were zero KB entries injected into the reply prompt.
    // Do not treat top-priority "fallback" slices as irrelevant: they are still real org KB (e.g. company
    // overview). Multilingual customers often miss text/keyword matches on English-only KB, but the
    // model was still grounded on those entries — sending the AI reply is correct.
    // EXCEPTION: Small talk (hi, hello) must always get an AI reply — never fallback.
    const fallbackCfg = organization.autoReplySettings?.fallbackSettings;
    const kbCount = autoReply.response.knowledgeBaseCount || 0;
    const hasNoRelevantKB = kbCount === 0;
    if (fallbackCfg?.enabled && hasNoRelevantKB && !isSmallTalk) {
      logger.info('[Auto-reply] Layer 2.5: AI had no knowledge base context in prompt — sending fallback instead of generic reply', {
        interactionId: interactionForReply._id?.toString(),
        usedKnowledgeBase: !!autoReply.response.usedKnowledgeBase,
        knowledgeBaseCount: kbCount,
        knowledgeBaseFallback: !!autoReply.response.knowledgeBaseFallback
      });

      const primary25Msg = (fallbackCfg.message && fallbackCfg.message.trim())
        ? fallbackCfg.message.trim()
        : 'Our Agent will contact you within 24 hours.';

      const { message: fallbackMsg, shouldSend } = selectFallbackMessage(
        primary25Msg, interactionForReply.replies
      );

      let fallbackSent = false;
      if (shouldSend && fallbackMsg && organization.autoReplySettings.enabled) {
        fallbackSent = await sendReplyToPlatform(interactionForReply, fallbackMsg, organization);
      }

      try {
        await interactionForReply.escalateToHuman(
          ['AI reply had no knowledge base context — fallback triggered'], 'ai_no_kb_fallback',
          { confidence: autoReply.response.confidence }
        );
      } catch (_escErr) {
        logger.warn('[Auto-reply] Layer 2.5: escalateToHuman error (non-fatal)', { error: _escErr.message });
      }

      await routeToFallbackBucket(interactionForReply, organization._id);

      if (fallbackCfg.assignToAgent) {
        try {
          const assignedAgent = await escalationService.assignToAgent(interactionForReply, organization, { forceFallback: true });
          if (assignedAgent) {
            console.log(`👤 [Auto-reply L2.5] Assigned to agent: ${assignedAgent.firstName} ${assignedAgent.lastName}`);
            if (fallbackCfg.notifyByEmail) {
              await escalationService.notifyAgent(assignedAgent, interactionForReply, organization);
            }
          }
        } catch (assignErr) {
          logger.warn('[Auto-reply] Layer 2.5: agent assignment error (non-fatal)', { error: assignErr.message });
        }
      }

      // Emit final state so the frontend list reflects the definitive status after all DB writes
      try {
        const fresh = await Interaction.findById(interactionForReply._id).lean();
        if (fresh) emitToOrg(organization._id.toString(), 'interaction_updated', { interaction: fresh });
      } catch (_e) {}

      return { sent: fallbackSent, escalated: true, reason: 'ai_no_kb_fallback' };
    }

    // Merge confidence-based escalation check with the earlier one
    const postReplyEscalationCheck = await escalationService.shouldEscalate(
      interactionForReply,
      organization,
      autoReply.response
    );

    // GUARDRAIL: if the AI's own reply promised a human will follow up ("I've
    // escalated this", "our priority team will reach out", "connecting you with an
    // agent", "we'll arrange the pickup"), we must actually escalate + assign a
    // human. The scorer above only reads the customer's message, so it never catches
    // a promise the AI itself introduced — this is exactly the "AI says escalated but
    // nobody is assigned" bug.
    const promisesHandoff = replyPromisesHumanHandoff(autoReply.response.content);

    const shouldEscalate =
      escalationCheck.shouldEscalate ||
      postReplyEscalationCheck.shouldEscalate ||
      promisesHandoff;
    const escalationReasons = [
      ...(escalationCheck.reasons || []),
      ...(postReplyEscalationCheck?.reasons || []),
      ...(promisesHandoff ? ['AI reply promised a human follow-up — routing to a human agent'] : [])
    ];
    const escalationType = escalationCheck.shouldEscalate
      ? escalationCheck.type
      : (postReplyEscalationCheck.shouldEscalate ? 'ai_confidence' : 'ai_unresolvable');
    const escalationMetadata = {
      ...(escalationCheck.metadata || {}),
      ...(postReplyEscalationCheck?.metadata || {}),
      ...(promisesHandoff ? { promisedHumanHandoff: true } : {})
    };

    // Send the reply FIRST so the customer always gets an acknowledgment,
    // even when the conversation is being escalated to a human agent.
    // requireApproval / autoSend gate: if either blocks sending, do not deliver.
    let replySent = false;
    if (organization.autoReplySettings.enabled && autoSend && !requireApproval) {
      const sent = await sendReplyToPlatform(
        interactionForReply, autoReply.response.content, organization,
        autoReply.response.confidence, autoReply.response.messageType
      );
      if (sent) {
        logEvents.autoReply.sent({
          interactionId: interactionForReply._id,
          platform: interactionForReply.platform
        });
        replySent = true;

        // Update contact AI insights (fire-and-forget — never blocks the reply path)
        if (interactionForReply.contact) {
          updateAIInsights(interactionForReply.contact, {
            intent: interactionForReply.intentBucket?.toString() || interactionForReply.intent || null,
            sentiment: interactionForReply.sentiment || null,
            priority: interactionForReply.urgency || null
          }).catch(() => {});
        }
      }
    }

    // THEN escalate to human if rules triggered (routing happens after the reply)
    if (shouldEscalate) {
      await escalationService.escalateInteraction(
        interactionForReply,
        organization,
        escalationReasons,
        escalationType,
        escalationMetadata
      );

      // When the AI itself promised a human, guarantee one is actually assigned +
      // notified (escalateInteraction only auto-assigns when autoAssign is on). This
      // keeps the promise even for orgs running "ReppyAI only" with auto-assign off.
      // No extra message is sent — the reply already carried the handoff wording.
      if (promisesHandoff) {
        await ensureHumanAssigned(interactionForReply, organization);
        await routeToFallbackBucket(interactionForReply, organization._id);
      }

      // Emit final state so the frontend list reflects the definitive status after all DB writes
      try {
        const fresh = await Interaction.findById(interactionForReply._id).lean();
        if (fresh) emitToOrg(organization._id.toString(), 'interaction_updated', { interaction: fresh });
      } catch (_e) {}

      logger.info('[Auto-reply] Escalated after reply', {
        interactionId: interactionForReply._id?.toString(),
        replySent,
        escalationType,
        promisesHandoff,
        reasons: escalationReasons
      });
      return { sent: replySent, escalated: true };
    }

    return replySent ? { sent: true } : { processed: true };

  } catch (error) {
    logEvents.autoReply.failed({
      interactionId,
      error,
      phase: 'processSingleInteraction'
    });
    // Re-throw transient infrastructure/send failures so BullMQ can retry the job.
    // Policy-gate skips (quiet_hours, blocked_keyword, etc.) will have already
    // returned normally above — any error reaching here is unexpected.
    const isTransient = (
      /ECONNRESET|ETIMEDOUT|ENOTFOUND|socket hang up|network|timeout|rate.?limit|5[0-9]{2}/i.test(error.message)
    );
    if (isTransient) {
      logger.warn('[Auto-reply] Transient error in processSingleInteraction — will retry', {
        interactionId,
        error: error.message
      });
      throw error; // BullMQ retries
    }
    // Non-transient: log and complete the job (don't fill dead-letter with permanent errors)
    logger.error('[Auto-reply] Non-transient error in processSingleInteraction — marking as completed', {
      interactionId,
      error: error.message
    });
    return { skipped: true, reason: error.message };
  }
}

/**
 * Process batch of interactions (scheduled)
 */
async function processBatchInteractions(organizationId, organization) {
  const results = {
    processed: 0,
    sent: 0,
    skipped: 0,
    details: [] // Add details for debugging
  };

  try {
    // Find eligible interactions
    const query = {
      organization: organizationId,
      status: 'unread',
      $or: [
        { replies: { $size: 0 } },
        { replies: { $exists: false } }
      ]
    };

    const interactions = await Interaction.find(query)
      .populate('platformConnection')
      .limit(20); // Process max 20 at a time

    logger.info('Auto-reply batch processing', { 
      interactionCount: interactions.length,
      organizationId 
    });

    for (const interaction of interactions) {
      const batchThreadDm = isThreadStyleDm(interaction);

      if (!batchThreadDm && interaction.replies && interaction.replies.length > 0) {
        results.skipped++;
        results.details.push({ id: interaction._id, reason: 'Already has replies' });
        continue;
      }

      if (!batchThreadDm && (interaction.status === 'replied' || interaction.status === 'resolved')) {
        results.skipped++;
        results.details.push({ id: interaction._id, reason: `Status is ${interaction.status}` });
        continue;
      }
      
      // Check daily limit
      if (organization.autoReplySettings.repliesCountToday >= organization.autoReplySettings.maxRepliesPerDay) {
        logger.warn('Auto-reply daily limit reached', {
          current: organization.autoReplySettings.repliesCountToday,
          limit: organization.autoReplySettings.maxRepliesPerDay
        });
        results.skipped++;
        results.details.push({ id: interaction._id, reason: 'Daily limit reached' });
        continue;
      }

      // IMPORTANT: Don't reply to replies that are replies to our own replies
      // Check 1: If this interaction has a parentId, check if the parent has a system reply
      if (interaction.parentId) {
        // Find the parent interaction
        // Note: parentId is a platform ID (e.g., YouTube comment ID), not a MongoDB ObjectId
        // So we only search by platformId, not _id
        const parentInteraction = await Interaction.findOne({
          platformId: interaction.parentId,
          organization: organizationId
        });

        if (parentInteraction) {
          // Check if parent has a system-generated reply
          if (parentInteraction.replies && parentInteraction.replies.length > 0) {
            const hasSystemReply = parentInteraction.replies.some(reply => reply.wasAutoGenerated === true);
            if (hasSystemReply) {
              results.skipped++;
              results.details.push({ id: interaction._id, reason: 'Parent comment already has system reply' });
              continue;
            }
          }

          // Check if the parent's author is the same as the platform connection's user
          // This would indicate the parent is a reply from the system itself
          if (interaction.platformConnection && parentInteraction.author) {
            const platformConnection = interaction.platformConnection;
            // For YouTube: Check if parent author matches the channel
            if (interaction.platform === 'youtube' && platformConnection.platformData?.channelId) {
              if (parentInteraction.author.platformId === platformConnection.platformData.channelId) {
                results.skipped++;
                results.details.push({ id: interaction._id, reason: 'Parent comment is from our own account' });
                continue;
              }
            }
            // For Instagram: Check if parent author matches the business account
            if (interaction.platform === 'instagram' && platformConnection.platformData?.businessAccountId) {
              if (parentInteraction.author.platformId === platformConnection.platformData.businessAccountId) {
                results.skipped++;
                results.details.push({ id: interaction._id, reason: 'Parent comment is from our own account' });
                continue;
              }
            }
          }
        }
      }

      // Check 2: Don't reply to interactions that are from our own account
      if (interaction.platformConnection && interaction.author) {
        const platformConnection = interaction.platformConnection;
        // For YouTube: Check if author matches the channel
        if (interaction.platform === 'youtube' && platformConnection.platformData?.channelId) {
          if (interaction.author.platformId === platformConnection.platformData.channelId) {
            results.skipped++;
            results.details.push({ id: interaction._id, reason: 'Interaction is from our own account' });
            continue;
          }
        }
        // For Instagram: Check if author matches the business account
        if (interaction.platform === 'instagram' && platformConnection.platformData?.businessAccountId) {
          if (interaction.author.platformId === platformConnection.platformData.businessAccountId) {
            results.skipped++;
            results.details.push({ id: interaction._id, reason: 'Interaction is from our own account' });
            continue;
          }
        }
      }

      // Fresh doc so batch jobs respect sentiment / intent after processAI
      const interactionFresh = await Interaction.findById(interaction._id)
        .populate('platformConnection');
      if (!interactionFresh) {
        results.skipped++;
        results.details.push({ id: interaction._id, reason: 'Interaction not found' });
        continue;
      }
      const freshThreadDm = isThreadStyleDm(interactionFresh);
      if (!freshThreadDm && interactionFresh.replies && interactionFresh.replies.length > 0) {
        results.skipped++;
        results.details.push({ id: interaction._id, reason: 'Already has replies' });
        continue;
      }
      if (!freshThreadDm && (interactionFresh.status === 'replied' || interactionFresh.status === 'resolved')) {
        results.skipped++;
        results.details.push({ id: interaction._id, reason: `Status is ${interactionFresh.status}` });
        continue;
      }

      // Generate auto-reply
      const autoReply = await aiService.generateAutoReply(
        interactionFresh,
        organizationId,
        organization
      );

      if (!autoReply.eligible) {
        results.skipped++;
        results.details.push({ id: interaction._id, reason: autoReply.reason });
        continue;
      }

      logEvents.autoReply.generated({
        interactionId: interactionFresh._id,
        confidence: autoReply.response.confidence,
        sentiment: interactionFresh.sentiment,
        length: autoReply.response.content.length
      });
      results.processed++;

      // Send if auto-reply is enabled
      if (organization.autoReplySettings.enabled) {
        const sent = await sendReplyToPlatform(
          interactionFresh, autoReply.response.content, organization,
          autoReply.response.confidence, autoReply.response.messageType
        );
        if (sent) {
          logEvents.autoReply.sent({
            interactionId: interactionFresh._id,
            platform: interactionFresh.platform
          });
          results.sent++;
          organization.autoReplySettings.repliesCountToday++;
          results.details.push({ id: interaction._id, status: 'sent' });
        } else {
          results.details.push({ id: interaction._id, status: 'failed to send' });
        }
      } else {
        results.details.push({ id: interaction._id, status: 'generated only' });
      }
    }

    return results;

  } catch (error) {
    logger.error('Error processing batch interactions', { 
      error: error.message,
      organizationId 
    });
    return results;
  }
}

/**
 * Resolve the platform connection to use for sending. For Instagram DM must use the thread owner
 * to avoid "(#100) not the thread owner". For Facebook DM must use the Page that owns the thread.
 */
async function getConnectionForReply(interaction) {
  const isInstagramDm = interaction.platform === 'instagram' && interaction.type === 'dm';
  let igAccountId = interaction.metadata?.instagramAccountId;
  if (isInstagramDm && !igAccountId && interaction.platformId && interaction.platformId.startsWith('dm_')) {
    const parts = interaction.platformId.split('_');
    if (parts.length >= 3) igAccountId = parts[1];
  }
  if (isInstagramDm && igAccountId) {
    const PlatformConnection = require('../models/PlatformConnection');
    const conn = await PlatformConnection.findOne({
      organization: interaction.organization,
      platform: 'instagram',
      platformUserId: { $in: [igAccountId, String(igAccountId)].filter(Boolean) },
      status: { $in: ['connected', 'available'] },
      isActive: true
    }).lean();
    if (conn) return conn;
    return null;
  }

  const isFacebookDm = interaction.platform === 'facebook' && interaction.type === 'dm';
  let facebookPageId = interaction.metadata?.facebookPageId;
  if (isFacebookDm && !facebookPageId && interaction.platformId && interaction.platformId.startsWith('dm_')) {
    const parts = interaction.platformId.split('_');
    if (parts.length >= 3) facebookPageId = parts[1];
  }
  if (isFacebookDm && facebookPageId) {
    const PlatformConnection = require('../models/PlatformConnection');
    const conn = await PlatformConnection.findOne({
      organization: interaction.organization,
      platform: 'facebook',
      platformPageId: { $in: [String(facebookPageId), facebookPageId] },
      status: { $in: ['connected', 'available'] },
      isActive: true
    }).lean();
    if (conn) return conn;
    return null;
  }

  return interaction.platformConnection;
}

/**
 * Send reply to platform
 */
const ALLOWED_CONNECTION_STATUS = ['connected', 'available'];

async function sendReplyToPlatform(interaction, content, organization, confidence = null, messageType = null) {
  // Defense-in-depth: never send internal AI metadata JSON to a customer.
  // This catches any regression in the reply generation pipeline.
  if (isInternalAiPayload(content)) {
    logger.error('[Auto-reply] BLOCKED — attempted to send internal AI JSON as customer reply', {
      interactionId: interaction._id?.toString(),
      platform: interaction.platform,
      contentPreview: String(content).slice(0, 120)
    });
    return false;
  }

  if (!content || !String(content).trim()) {
    logger.warn('[Auto-reply] sendReplyToPlatform called with empty content — skipping send', {
      interactionId: interaction._id?.toString()
    });
    return false;
  }

  try {
    const connection = await getConnectionForReply(interaction);
    if (!connection || !ALLOWED_CONNECTION_STATUS.includes(connection.status) || !connection.isActive) {
      logger.warn('[Auto-reply] No usable platform connection to send', {
        platform: interaction.platform,
        type: interaction.type,
        interactionId: interaction._id?.toString(),
        hasConnection: !!connection,
        status: connection?.status,
        isActive: connection?.isActive
      });
      return false;
    }

    let platformResponseId = null;
    let replyStatus = 'failed';

    if (interaction.platform === 'youtube') {
      const youtubeService = require('../integrations/google/youtubeService');
      const result = await youtubeService.replyToComment(
        connection,
        interaction.platformId,
        content
      );
      
      if (result.success && result.commentId) {
        platformResponseId = result.commentId;
        replyStatus = 'sent';
      }
    } else if (interaction.platform === 'instagram') {
      const instagramService = require('../integrations/meta/instagramService');
      let result;
      const connType = connection.metadata?.connectionType
        || (typeof connection.accessToken === 'string' && connection.accessToken.startsWith('IGAA') ? 'instagram_login' : null);
      if (interaction.type === 'dm') {
        // For Instagram Login (IGAA tokens), the endpoint must be /{ISUID}/messages where ISUID
        // is the app-scoped ID the token was issued for — stored in metadata.igLoginScopedId.
        // Using the self-healed global ID (platformPageId) causes error 2534037.
        const pageId = connType === 'instagram_login'
          ? (connection.metadata?.igLoginScopedId || connection.platformUserId)
          : (connection.platformPageId || connection.platformData?.pageId || connection.metadata?.facebookPageId);
        const recipientId = interaction.author?.platformId;
        if (!pageId || !recipientId) {
          logger.warn('[Auto-reply] Instagram DM missing pageId or recipientId', {
            interactionId: interaction._id?.toString(),
            hasPageId: !!pageId,
            hasRecipientId: !!recipientId
          });
        } else {
          try {
            result = await instagramService.sendMessage(
              recipientId,
              content,
              connection.accessToken,
              pageId,
              true,
              connType
            );
          } catch (sendErr) {
            logger.error('[Auto-reply] Instagram DM sendMessage failed', {
              interactionId: interaction._id?.toString(),
              error: sendErr.message,
              platformError: sendErr.platformError
            });
            result = null;
          }
        }
      }
      if (!result && interaction.type !== 'dm') {
        // Route product-linked-post comments through Private Reply (DM) so that
        // price, checkout links, and product-specific copy never appear publicly.
        const {
          isCommentOnProductLinkedPost,
          resolveInstagramPrivateReplyPageId
        } = require('../services/instagramCommentReplyRouter');

        const forcePrivate =
          organization?.commentToDmSettings?.forcePrivateReplyForLinkedProducts !== false;

        const usePrivateReply =
          interaction.type === 'comment' &&
          forcePrivate &&
          await isCommentOnProductLinkedPost(
            interaction,
            interaction.organization?.toString?.() || interaction.organization,
            { forcePrivateReply: forcePrivate }
          );

        if (usePrivateReply) {
          const pageId = resolveInstagramPrivateReplyPageId(connection, connType);
          if (!pageId) {
            logger.warn('[Auto-reply] Instagram private reply skipped — could not resolve pageId', {
              interactionId: interaction._id?.toString(),
              connType
            });
          } else {
            try {
              result = await instagramService.sendPrivateReply(
                interaction.platformId,
                content,
                connection.accessToken,
                pageId,
                connType
              );
              if (result?.success) {
                // Override the messageType so the inbox shows "DM" not "comment reply"
                messageType = 'instagram_private_dm';
              }
            } catch (privateReplyErr) {
              // Do NOT fall back to replyToComment: the content may contain price/
              // checkout links that must never appear publicly. Instead, assign to
              // a human agent so the lead is not lost.
              logger.error('[Auto-reply] Instagram private reply failed — escalating to human agent', {
                interactionId: interaction._id?.toString(),
                error: privateReplyErr.message,
                platformError: privateReplyErr.platformError
              });
              try {
                await escalationService.assignToAgent(interaction, organization, { forceFallback: true });
              } catch (escalateErr) {
                logger.warn('[Auto-reply] escalation after private-reply failure also failed', {
                  interactionId: interaction._id?.toString(),
                  error: escalateErr.message
                });
              }
              result = null;
            }
          }
        } else {
          result = await instagramService.replyToComment(
            interaction.platformId,
            content,
            connection.accessToken,
            connType
          );
        }
      }
      if (result && result.success && result.platformResponseId) {
        platformResponseId = result.platformResponseId;
        replyStatus = 'sent';
      }
    } else if (interaction.platform === 'facebook') {
      const facebookService = require('../integrations/meta/facebookService');
      let result;
      if (interaction.type === 'dm') {
        const pageId = connection.platformPageId || connection.platformData?.pageId;
        const recipientId = interaction.author?.platformId;
        if (pageId && recipientId) {
          result = await facebookService.sendMessage(
            recipientId,
            content,
            connection.accessToken,
            pageId,
            true
          );
        }
      }
      if (!result) {
        result = await facebookService.replyToComment(
          connection,
          interaction.platformId,
          content
        );
      }
      if (result && result.success && (result.platformResponseId || result.commentId)) {
        platformResponseId = result.platformResponseId || result.commentId;
        replyStatus = 'sent';
      }
    } else if (interaction.platform === 'google') {
      const googleService = require('../integrations/google/googleService');
      // TODO: Implement Google Business reply
      logger.debug('Google Business reply not yet implemented');
    } else if (interaction.platform === 'whatsapp') {
      const whatsappService = require('../integrations/whatsapp/whatsappService');
      // WhatsApp interactions use a thread model: author.platformId is the sender's WA ID (phone)
      // The thread platformId is dm_<phoneNumberId>_<senderId>; extract senderId from it.
      const recipientPhone =
        interaction.author?.platformId ||
        interaction.metadata?.senderId ||
        (interaction.platformId?.startsWith('dm_')
          ? interaction.platformId.split('_')[2]
          : null);

      if (!recipientPhone) {
        logger.warn('[Auto-reply] WhatsApp reply skipped — no recipient phone in interaction', {
          interactionId: interaction._id?.toString(),
          platformId: interaction.platformId
        });
      } else {
        try {
          const result = await whatsappService.sendTextMessage(connection, recipientPhone, content);
          if (result?.success && result?.messageId) {
            platformResponseId = result.messageId;
            replyStatus = 'sent';
          }
        } catch (waErr) {
          logger.error('[Auto-reply] WhatsApp sendTextMessage failed', {
            interactionId: interaction._id?.toString(),
            error: waErr.message
          });
        }
      }
    }

    if (replyStatus === 'sent') {
      // Find a user to attribute the auto-reply to.
      // Broaden the search to any org member so a missing admin/manager never
      // blocks the status update. Fall back to null — sentBy is not required.
      const User = require('../models/User');
      const user = await User.findOne({
        organization: organization._id,
        role: { $in: ['admin', 'manager', 'agent', 'super_admin'] }
      }).select('_id').lean();

      await interaction.addReply(
        content,
        user?._id ?? null,
        platformResponseId,
        true,
        null,
        null,
        confidence,
        messageType,
        null,
        interaction.platform === 'whatsapp' && platformResponseId ? 'sent' : null
      );
      interaction.autoReplied = true;
      interaction.respondedAt = new Date();
      interaction.aiSkipReason = null;
      await interaction.save();

      // Clear the interaction cache NOW so the next poll returns fresh DB data
      // (avoids the stale-cache race where the 30s frontend poll overwrites
      //  the socket-updated 'replied' status with cached 'unread' data)
      try {
        await cacheService.invalidateInteractionCaches(interaction.organization.toString());
      } catch (_cacheErr) { /* non-fatal */ }

      // Emit real-time update so the inbox list reflects 'replied' status immediately
      try {
        emitToOrg(interaction.organization.toString(), 'interaction_updated', {
          interaction: interaction.toObject ? interaction.toObject() : interaction
        });
      } catch (_emitErr) {
        // Non-fatal — don't block the reply
      }

      // Remove any pending AI processing jobs for this interaction
      try {
        const { aiQueue } = require('../config/queue');
        const jobs = await aiQueue.getJobs(['waiting', 'active', 'delayed']);
        
        for (const job of jobs) {
          if (job.data.interactionId && job.data.interactionId.toString() === interaction._id.toString()) {
            await job.remove();
          }
        }
      } catch (queueError) {
        // Don't fail the reply if queue cleanup fails
      }

      return true;
    }

    return false;

  } catch (error) {
    logger.error('Error sending reply to platform', { 
      error: error.message,
      platform: interaction.platform,
      interactionId: interaction._id.toString()
    });
    return false;
  }
}

// Exposed for unit tests (the primary export is the processAutoReply job function).
module.exports.replyPromisesHumanHandoff = replyPromisesHumanHandoff;

