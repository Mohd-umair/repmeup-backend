/**
 * Inbox AI Assist Service
 *
 * Centralizes all AI-assisted inbox operations so the 4 HTTP handlers
 * (`suggestReply`, `aiAssist`, `aiAssistRegenerate`, `generateAutoReplies`)
 * share one consistent error contract, one credit-guard+rollback pattern,
 * one conversation-context builder, and one knowledge-base lookup path.
 *
 * Before this service existed each controller duplicated:
 *   - the 404/403 ownership check
 *   - the credit check payload (403 with current/limit/remaining)
 *   - the conversation context assembly
 *   - the KB fetch + per-entry usage increment
 *   - the credit rollback on AI failure
 * …with subtle differences per handler (e.g. inconsistent rollback on 401).
 *
 * Error contract
 * ──────────────
 * All recoverable failures throw `InboxAiError` with:
 *   - statusCode (400/403/404)
 *   - code  (stable string, safe to expose to clients)
 *   - payload (optional extras — e.g. `credits` for quota exhausted)
 *
 * Controllers translate via the exported `respondInboxAiError(res, err)` helper.
 *
 * Non-responsibilities
 * ────────────────────
 *   - No `req` / `res` coupling — orchestrators take plain user/interaction objects.
 *   - No HTTP status codes leaked in responses — only via `InboxAiError.statusCode`.
 *   - Credit atomicity: every orchestrator either deducts + returns, or throws
 *     without leaking credits (rollback guaranteed).
 */

'use strict';

const logger = require('../../config/logger');
const Interaction = require('../../models/Interaction');
const Organization = require('../../models/Organization');
const aiService = require('../aiService');
const aiCreditService = require('../aiCreditService');
const cacheService = require('../cacheService');
const { runWithAiContextAndUsageId } = require('../aiRequestContext');

// ─── constants ──────────────────────────────────────────────────────────────

const MAX_KB_ENTRIES = 5;
const MAX_KB_ENTRY_CHARS = 600;
const MAX_CHILD_INTERACTIONS = 10;
const MAX_RECENT_REPLIES = 10;
const AUTO_REPLY_BATCH_SIZE = 20;

/**
 * Single source of truth for the three reply variants used by AI Assist and
 * AI Assist Regenerate. Tweaking the prompt / token budget lives here only.
 */
const REPLY_TYPES = Object.freeze({
  short: Object.freeze({
    instruction: 'Generate a SHORT, concise reply (1-2 sentences max). Get straight to the point.',
    maxTokens: 100,
    temperature: 0.6,
    regenerateTemperature: 0.8
  }),
  detailed: Object.freeze({
    instruction: 'Generate a DETAILED, comprehensive reply (3-5 sentences). Cover all relevant points thoroughly while remaining friendly.',
    maxTokens: 300,
    temperature: 0.7,
    regenerateTemperature: 0.8
  }),
  sales: Object.freeze({
    instruction: 'Generate a SALES-oriented reply (2-4 sentences). Address the query, then naturally suggest relevant products/services or upsell opportunities. Be helpful, not pushy.',
    maxTokens: 250,
    temperature: 0.75,
    regenerateTemperature: 0.85
  })
});

const REPLY_TYPE_KEYS = Object.freeze(Object.keys(REPLY_TYPES));

// ─── error class ────────────────────────────────────────────────────────────

class InboxAiError extends Error {
  /**
   * @param {string} message
   * @param {object} [opts]
   * @param {number} [opts.statusCode=500]
   * @param {string} [opts.code]
   * @param {object} [opts.payload] Arbitrary data to include in the HTTP body
   */
  constructor(message, { statusCode = 500, code = null, payload = null } = {}) {
    super(message);
    this.name = 'InboxAiError';
    this.statusCode = statusCode;
    this.code = code;
    this.payload = payload;
  }
}

/**
 * Unified response translator. Controllers:
 *   try { … } catch (err) {
 *     if (err instanceof InboxAiError) return respondInboxAiError(res, err);
 *     next(err);
 *   }
 */
function respondInboxAiError(res, err) {
  const body = { success: false, error: err.message };
  if (err.code) body.code = err.code;
  if (err.payload && typeof err.payload === 'object') Object.assign(body, err.payload);
  return res.status(err.statusCode || 500).json(body);
}

// ─── internal primitives ────────────────────────────────────────────────────

/**
 * Load an interaction by id and assert it belongs to the caller's org.
 * @throws {InboxAiError} 404 when missing, 403 when org mismatch
 */
async function loadOwnedInteraction(interactionId, orgId) {
  if (!interactionId) {
    throw new InboxAiError('Interaction id is required', {
      statusCode: 400,
      code: 'MISSING_INTERACTION_ID'
    });
  }
  const interaction = await Interaction.findById(interactionId);
  if (!interaction) {
    throw new InboxAiError('Interaction not found', {
      statusCode: 404,
      code: 'INTERACTION_NOT_FOUND'
    });
  }
  if (interaction.organization.toString() !== String(orgId)) {
    throw new InboxAiError('Access denied', {
      statusCode: 403,
      code: 'FORBIDDEN'
    });
  }
  return interaction;
}

/**
 * Assert the org has `amount` credits available, otherwise throw an error
 * whose payload carries the current/limit/remaining numbers (existing API
 * shape — clients rely on `credits` field).
 */
async function ensureCreditsAvailable(orgId, amount = 1) {
  const check = await aiCreditService.checkCredits(orgId, amount);
  if (!check.allowed) {
    throw new InboxAiError(check.error || 'Insufficient AI credits', {
      statusCode: 403,
      code: check.code || 'INSUFFICIENT_CREDITS',
      payload: {
        credits: {
          current: check.current,
          limit: check.limit,
          remaining: check.remaining
        }
      }
    });
  }
  return check;
}

/**
 * Build the prompt-ready "Customer: ...\nCustomer: ...\nAgent: ..." transcript.
 * Fetches up to 10 child messages and includes up to 10 recent replies.
 */
async function buildConversationContext(interaction, orgId) {
  const childInteractions = await Interaction.find({
    $or: [
      { parentId: interaction._id.toString() },
      { parentId: interaction.platformId }
    ],
    organization: orgId
  })
    .sort({ platformCreatedAt: -1 })
    .limit(MAX_CHILD_INTERACTIONS)
    .lean();

  const recentReplies = (interaction.replies || [])
    .filter((r) => r.status !== 'deleted')
    .slice(-MAX_RECENT_REPLIES);

  const lines = [];
  lines.push(`Customer (${interaction.author?.name || 'Unknown'}): "${interaction.content}"`);
  for (const child of childInteractions.reverse()) {
    lines.push(`Customer: "${child.content}"`);
  }
  for (const reply of recentReplies) {
    const role = reply.isPlatformReply ? 'Customer' : 'Agent';
    lines.push(`${role}: "${reply.content}"`);
  }

  return {
    chatContext: lines.join('\n'),
    childCount: childInteractions.length,
    replyCount: recentReplies.length
  };
}

/**
 * Search knowledge base + optionally increment usage counters, then return a
 * capped prompt-ready string. Never throws on KB failures — falls back to
 * empty context so AI still runs.
 */
async function fetchKnowledgeBaseContext(orgId, query, {
  limit = MAX_KB_ENTRIES,
  maxEntryChars = MAX_KB_ENTRY_CHARS,
  incrementUsage = true,
  loggerLabel = 'inboxAiAssist'
} = {}) {
  let kbEntries = [];
  let fromFallback = false;
  try {
    const res = await aiService.searchKnowledgeBase(orgId, query, limit);
    kbEntries = res?.entries || [];
    fromFallback = Boolean(res?.fromFallback);
  } catch (err) {
    logger.warn(`[${loggerLabel}] KB search failed, continuing without KB`, {
      organizationId: String(orgId),
      error: err.message
    });
    return { kbContext: '', kbEntries: [], usedKnowledgeBase: false, knowledgeBaseCount: 0 };
  }

  if (incrementUsage && !fromFallback && kbEntries.length > 0) {
    await Promise.all(
      kbEntries.map(async (kb) => {
        try {
          await kb.incrementUsage();
        } catch (err) {
          logger.warn(`[${loggerLabel}] KB usage increment failed`, {
            kbId: kb?._id?.toString(),
            error: err.message
          });
        }
      })
    );
  }

  const kbContext = kbEntries.length > 0
    ? kbEntries.map((kb) => {
        const body = (kb.content || '').substring(0, maxEntryChars);
        const truncated = (kb.content || '').length > maxEntryChars ? '…' : '';
        return `${kb.title}: ${body}${truncated}`;
      }).join('\n\n')
    : '';

  return {
    kbContext,
    kbEntries,
    usedKnowledgeBase: kbEntries.length > 0,
    knowledgeBaseCount: kbEntries.length
  };
}

/**
 * Build the system prompt shared by aiAssist + aiAssistRegenerate.
 */
function buildAssistSystemPrompt({ chatContext, kbContext, interaction }) {
  return `You are a professional customer service AI assistant.
You help agents draft replies to customer messages.

CONVERSATION CONTEXT:
${chatContext}

${kbContext ? `KNOWLEDGE BASE (use this information to ground your answers):\n${kbContext}` : 'No knowledge base content available. Provide helpful general responses.'}

IMPORTANT RULES:
- Address the customer's concern directly
- Be polite, empathetic, and professional
- If knowledge base content is provided, prioritize those facts
- Never say placeholders like "[Your Name]" or "[Company]"
- Match the tone to the platform: ${interaction.platform} (${interaction.type})
- Do NOT include a greeting like "Dear customer" unless the message is formal`;
}

function buildAssistUserPrompt(interaction) {
  return `Customer message: "${interaction.content}"\nPlatform: ${interaction.platform}\nType: ${interaction.type}\nSentiment: ${interaction.sentiment || 'unknown'}`;
}

/**
 * Wrap credit deduct so a transient AI/db failure doesn't leak quota.
 * If `fn` throws, credits that were already deducted in this call are refunded
 * before the original error is rethrown.
 *
 * @param {object} args
 * @param {string} args.orgId
 * @param {string} args.operation        — e.g. 'ai_assist'
 * @param {object} args.metadata         — attached to deductCredits()
 * @param {() => Promise<{ result: any, aiApiUsageId?: string }>} args.aiCall
 *   Must return the AI result plus the usageId to link spend against.
 */
async function runWithCreditDeductAndRollback({ orgId, user, operation, metadata, aiCall }) {
  let deducted = 0;
  try {
    const { result, aiApiUsageId } = await aiCall();
    await aiCreditService.deductCredits(
      orgId,
      1,
      { operation, userId: user?._id, ...metadata },
      { aiApiUsageId }
    );
    deducted = 1;
    return { result, aiApiUsageId, deducted };
  } catch (err) {
    if (deducted > 0) {
      try {
        await aiCreditService.rollbackCredits(orgId, deducted, {
          operation,
          userId: user?._id,
          reason: err.message
        });
      } catch (rollbackErr) {
        logger.error('[inboxAiAssist] credit rollback failed after AI error', {
          orgId: String(orgId),
          operation,
          rollbackError: rollbackErr.message,
          originalError: err.message
        });
      }
    }
    // Translate known transport-layer errors to stable codes for clients.
    if (err.response?.status === 401) {
      throw new InboxAiError('OpenAI API key is invalid or expired.', {
        statusCode: 500,
        code: 'AI_CREDENTIALS_INVALID'
      });
    }
    throw err;
  }
}

// ─── orchestrator 1: suggestReply ───────────────────────────────────────────

/**
 * Generate a single suggested reply for an interaction (used by the inbox
 * "Suggest Reply" button). Deducts 1 credit on success; refunds on failure.
 *
 * @returns {{ data: object, credits: object }}
 */
async function suggestReplyFor({ interactionId, user }) {
  const orgId = user.organization._id;
  const orgIdStr = orgId.toString();

  const interaction = await loadOwnedInteraction(interactionId, orgId);
  await ensureCreditsAvailable(orgIdStr, 1);

  const { result: aiResponse, aiApiUsageId } = await runWithCreditDeductAndRollback({
    orgId: orgIdStr,
    user,
    operation: 'ai_response',
    metadata: {
      interactionId: interaction._id.toString(),
      platform: interaction.platform,
      messagePreview: interaction.lastMessage?.content?.substring(0, 100) || ''
    },
    aiCall: async () => {
      const { result, aiApiUsageId: usageId } = await runWithAiContextAndUsageId(
        { organizationId: orgId, userId: user._id, feature: 'inbox.suggest_reply' },
        () => aiService.generateResponse(interaction, orgId)
      );
      if (!result) {
        throw new InboxAiError('Failed to generate AI response', {
          statusCode: 500,
          code: 'AI_GENERATION_FAILED'
        });
      }
      return { result, aiApiUsageId: usageId };
    }
  });
  // Lint guard: suppress unused "aiApiUsageId" return
  void aiApiUsageId;

  const credits = await aiCreditService.getUsage(orgIdStr);
  return {
    data: {
      suggestedReply: aiResponse.content,
      confidence: aiResponse.confidence,
      usedKnowledgeBase: aiResponse.usedKnowledgeBase,
      knowledgeBaseCount: aiResponse.knowledgeBaseCount
    },
    credits
  };
}

// ─── orchestrator 2: aiAssist (short + detailed + sales triple) ─────────────

async function generateAssistTriple({ interactionId, user }) {
  const orgId = user.organization._id;
  const orgIdStr = orgId.toString();

  const interaction = await loadOwnedInteraction(interactionId, orgId);
  await ensureCreditsAvailable(orgIdStr, 1);

  const [{ chatContext }, kb] = await Promise.all([
    buildConversationContext(interaction, orgId),
    fetchKnowledgeBaseContext(orgIdStr, interaction.content, { loggerLabel: 'aiAssist' })
  ]);

  const systemPrompt = buildAssistSystemPrompt({
    chatContext,
    kbContext: kb.kbContext,
    interaction
  });
  const userPrompt = buildAssistUserPrompt(interaction);

  const generateOne = async (type) => {
    const config = REPLY_TYPES[type];
    return runWithAiContextAndUsageId(
      { organizationId: orgId, userId: user._id, feature: `inbox.ai_assist.${type}` },
      async () => {
        const result = await aiService.generateText(
          `${systemPrompt}\n\n${config.instruction}`,
          userPrompt,
          { temperature: config.temperature, maxTokens: config.maxTokens }
        );
        return { type, content: result };
      }
    );
  };

  // Deduct 1 credit total for the triple; rollback on any failure.
  const { result: triple } = await runWithCreditDeductAndRollback({
    orgId: orgIdStr,
    user,
    operation: 'ai_assist',
    metadata: {
      interactionId: interaction._id.toString(),
      platform: interaction.platform,
      messagePreview: interaction.content?.substring(0, 100) || ''
    },
    aiCall: async () => {
      const [wShort, wDetailed, wSales] = await Promise.all([
        generateOne('short'),
        generateOne('detailed'),
        generateOne('sales')
      ]);
      return {
        result: {
          short: wShort.result.content,
          detailed: wDetailed.result.content,
          sales: wSales.result.content
        },
        // Link the spend to whichever usage row has the richest context.
        aiApiUsageId: wSales.aiApiUsageId || wDetailed.aiApiUsageId || wShort.aiApiUsageId
      };
    }
  });

  const credits = await aiCreditService.getUsage(orgIdStr);
  return {
    data: {
      short: triple.short,
      detailed: triple.detailed,
      sales: triple.sales,
      usedKnowledgeBase: kb.usedKnowledgeBase,
      knowledgeBaseCount: kb.knowledgeBaseCount
    },
    credits
  };
}

// ─── orchestrator 3: aiAssistRegenerate ─────────────────────────────────────

async function regenerateAssistOne({ interactionId, user, type }) {
  if (!REPLY_TYPE_KEYS.includes(type)) {
    throw new InboxAiError('Invalid type. Must be short, detailed, or sales.', {
      statusCode: 400,
      code: 'INVALID_REPLY_TYPE'
    });
  }

  const orgId = user.organization._id;
  const orgIdStr = orgId.toString();

  const interaction = await loadOwnedInteraction(interactionId, orgId);
  await ensureCreditsAvailable(orgIdStr, 1);

  const [{ chatContext }, kb] = await Promise.all([
    buildConversationContext(interaction, orgId),
    fetchKnowledgeBaseContext(orgIdStr, interaction.content, { loggerLabel: 'aiAssistRegenerate' })
  ]);

  const config = REPLY_TYPES[type];
  const systemPrompt = `You are a professional customer service AI assistant.
You help agents draft replies to customer messages. Generate a DIFFERENT response than the previous one.

CONVERSATION CONTEXT:
${chatContext}

${kb.kbContext ? `KNOWLEDGE BASE:\n${kb.kbContext}` : ''}

${config.instruction}`;
  const userPrompt = buildAssistUserPrompt(interaction);

  const { result: content } = await runWithCreditDeductAndRollback({
    orgId: orgIdStr,
    user,
    operation: 'ai_assist_regenerate',
    metadata: {
      interactionId: interaction._id.toString(),
      platform: interaction.platform,
      messagePreview: interaction.content?.substring(0, 100) || ''
    },
    aiCall: async () => {
      const { result, aiApiUsageId } = await runWithAiContextAndUsageId(
        {
          organizationId: orgId,
          userId: user._id,
          feature: `inbox.ai_assist_regenerate.${type}`
        },
        () => aiService.generateText(
          systemPrompt,
          userPrompt,
          { temperature: config.regenerateTemperature, maxTokens: config.maxTokens }
        )
      );
      return { result, aiApiUsageId };
    }
  });

  const credits = await aiCreditService.getUsage(orgIdStr);
  return { data: { type, content }, credits };
}

// ─── orchestrator 4: generateAutoReplies (batch) ────────────────────────────

/**
 * Shared batch auto-reply primitive. Returns a structured result with per-item
 * status — never throws for per-item failures (a per-item throw would abort
 * the whole batch and is the wrong UX for a bulk tool).
 *
 * Pre-loop conditions DO throw `InboxAiError`:
 *   - Auto-reply feature disabled for the org
 *   - Organization not found
 *   - Daily reply limit already reached
 */
async function processAutoReplyBatch({ user, interactionIds = [], autoSend = false, mode = 'full' }) {
  const orgId = user.organization._id;

  const organization = await Organization.findById(orgId);
  if (!organization) {
    throw new InboxAiError('Organization not found', {
      statusCode: 404,
      code: 'ORG_NOT_FOUND'
    });
  }

  // The "test" dry-run mode doesn't require the feature flag to be enabled;
  // the full generator does.
  if (mode !== 'test' && !organization.autoReplySettings?.enabled) {
    throw new InboxAiError('Auto-reply is not enabled for your organization', {
      statusCode: 400,
      code: 'AUTO_REPLY_DISABLED'
    });
  }

  // Daily counter reset at midnight (local).
  const today = new Date().toDateString();
  const lastReset = organization.autoReplySettings?.lastReplyResetDate
    ? new Date(organization.autoReplySettings.lastReplyResetDate).toDateString()
    : null;

  if (lastReset !== today && organization.autoReplySettings) {
    organization.autoReplySettings.repliesCountToday = 0;
    organization.autoReplySettings.lastReplyResetDate = new Date();
    await organization.save();
  }

  const dailyMax = organization.autoReplySettings?.maxRepliesPerDay ?? 0;
  if (mode !== 'test' && (organization.autoReplySettings?.repliesCountToday ?? 0) >= dailyMax) {
    throw new InboxAiError('Daily auto-reply limit reached', {
      statusCode: 429,
      code: 'AUTO_REPLY_DAILY_LIMIT'
    });
  }

  const query = Array.isArray(interactionIds) && interactionIds.length > 0
    ? { _id: { $in: interactionIds }, organization: orgId }
    : {
        organization: orgId,
        status: 'unread',
        $or: [
          { replies: { $size: 0 } },
          { replies: { $exists: false } }
        ]
      };

  const interactions = await Interaction.find(query)
    .populate('platformConnection')
    .limit(AUTO_REPLY_BATCH_SIZE);

  const results = mode === 'test'
    ? { found: interactions.length, processed: 0, sent: 0, skipped: 0, details: [] }
    : { total: interactions.length, generated: 0, sent: 0, failed: 0, skipped: 0, details: [] };

  for (const interaction of interactions) {
    await _processSingleAutoReply({
      interaction,
      organization,
      orgId,
      user,
      results,
      mode,
      autoSend,
      dailyMax
    });
  }

  if (mode !== 'test') {
    await organization.save();
    // Invalidate list cache so the UI shows the freshly replied rows.
    await cacheService.invalidateInteractionCaches(orgId).catch((err) => {
      logger.warn('[inboxAiAssist] cache invalidation failed after auto-reply batch', {
        orgId: String(orgId),
        error: err.message
      });
    });
  }

  return results;
}

/**
 * Internal: process one interaction in the batch. All failures mutate
 * `results` rather than throwing — the loop must continue.
 */
async function _processSingleAutoReply({
  interaction, organization, orgId, user, results, mode, autoSend, dailyMax
}) {
  try {
    if (mode !== 'test' &&
        (organization.autoReplySettings?.repliesCountToday ?? 0) >= dailyMax) {
      results.skipped++;
      results.details.push({
        interactionId: interaction._id,
        status: 'skipped',
        reason: 'Daily limit reached'
      });
      return;
    }

    const creditCheck = await aiCreditService.checkCredits(orgId, 1);
    if (!creditCheck.allowed) {
      results.skipped++;
      results.details.push({
        interactionId: interaction._id,
        platform: interaction.platform,
        type: interaction.type,
        status: 'skipped',
        reason: 'Insufficient AI credits'
      });
      return;
    }

    const autoReply = await aiService.generateAutoReply(interaction, orgId, organization);

    if (!autoReply.eligible) {
      results.skipped++;
      results.details.push({
        interactionId: interaction._id,
        platform: interaction.platform,
        type: interaction.type,
        status: 'skipped',
        reason: autoReply.reason
      });
      return;
    }

    if (mode === 'test') {
      results.processed++;
      results.details.push({
        id: interaction._id,
        platform: interaction.platform,
        type: interaction.type,
        status: 'generated',
        confidence: autoReply.response.confidence,
        reply: autoReply.response.content
      });
      return;
    }

    results.generated++;

    const shouldSend = autoSend
      && organization.autoReplySettings?.autoSend
      && !organization.autoReplySettings?.requireApproval;

    if (!shouldSend) {
      results.details.push({
        interactionId: interaction._id,
        status: 'generated',
        suggestedReply: autoReply.response.content,
        confidence: autoReply.response.confidence,
        usedKnowledgeBase: autoReply.response.usedKnowledgeBase
      });
      return;
    }

    await _sendAutoReplyToPlatform({
      interaction, autoReply, user, organization, results
    });
  } catch (err) {
    results.failed = (results.failed || 0) + 1;
    results.details.push({
      interactionId: interaction._id,
      status: 'error',
      reason: err.message
    });
    logger.error('[inboxAiAssist] auto-reply item failed', {
      interactionId: interaction._id?.toString(),
      error: err.message
    });
  }
}

/**
 * Platform dispatcher for auto-reply sends. Only YouTube is wired today —
 * other platforms are no-ops that mark the item failed (same behavior as the
 * pre-refactor controller).
 */
async function _sendAutoReplyToPlatform({ interaction, autoReply, user, organization, results }) {
  try {
    let platformResponseId = null;
    let replyStatus = 'sent';

    if (interaction.platformConnection && interaction.platformConnection.status === 'connected') {
      if (interaction.platform === 'youtube') {
        const youtubeService = require('../../integrations/google/youtubeService');
        const result = await youtubeService.replyToComment(
          interaction.platformConnection,
          interaction.platformId,
          autoReply.response.content
        );
        if (result.success && result.commentId) {
          platformResponseId = result.commentId;
          replyStatus = 'sent';
        } else {
          replyStatus = 'failed';
        }
      }
      // NOTE: other platforms are intentionally NOT wired here yet — matches
      // pre-refactor behavior. Add new branches above.
    } else {
      replyStatus = 'failed';
    }

    if (replyStatus === 'sent') {
      await interaction.addReply(autoReply.response.content, user._id, platformResponseId, true);
      interaction.respondedAt = new Date();
      await interaction.save();

      results.sent++;
      if (organization.autoReplySettings) {
        organization.autoReplySettings.repliesCountToday++;
      }
      results.details.push({
        interactionId: interaction._id,
        status: 'sent',
        reply: autoReply.response.content,
        confidence: autoReply.response.confidence
      });
    } else {
      results.failed++;
      results.details.push({
        interactionId: interaction._id,
        status: 'failed',
        reason: 'Failed to send to platform'
      });
    }
  } catch (sendError) {
    results.failed++;
    results.details.push({
      interactionId: interaction._id,
      status: 'failed',
      reason: sendError.message
    });
  }
}

// ─── exports ────────────────────────────────────────────────────────────────

module.exports = {
  // error class + response helper
  InboxAiError,
  respondInboxAiError,

  // constants
  MAX_KB_ENTRIES,
  MAX_KB_ENTRY_CHARS,
  MAX_CHILD_INTERACTIONS,
  MAX_RECENT_REPLIES,
  AUTO_REPLY_BATCH_SIZE,
  REPLY_TYPES,
  REPLY_TYPE_KEYS,

  // primitives (exported for tests + reuse)
  loadOwnedInteraction,
  ensureCreditsAvailable,
  buildConversationContext,
  fetchKnowledgeBaseContext,
  buildAssistSystemPrompt,
  buildAssistUserPrompt,
  runWithCreditDeductAndRollback,

  // orchestrators
  suggestReplyFor,
  generateAssistTriple,
  regenerateAssistOne,
  processAutoReplyBatch
};
