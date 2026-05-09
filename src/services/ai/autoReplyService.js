/**
 * Auto-Reply Service
 *
 * Decides whether and how to auto-respond to inbound interactions.
 *
 * Public API:
 *   - shouldQueueImmediateAutoReply(interaction, organizationDoc)
 *       → cheap synchronous gate before enqueueing a webhook/sync job; does NOT
 *         require sentiment to be analysed yet.
 *   - canAutoReply(interaction, organizationSettings)
 *       → full eligibility check (status, replies, platform, type, sentiment,
 *         bucket toggle). Run inside the worker once sentiment is finalised.
 *   - generateAutoReply(interaction, organizationId, organizationSettings)
 *       → end-to-end flow: gate → credit check → LLM with self-assessment →
 *         confidence threshold → credit deduction. Returns a structured result.
 *
 * Returned shapes from generateAutoReply:
 *   { eligible: false, reason, [code], [creditsNeeded], [creditsRemaining], [response] }
 *   { eligible: true,  resolvable: false, resolvableReason, creditsUsed: 1 }    ← route to human
 *   { eligible: true,  response, creditsUsed: 1 }                                ← reply ready
 */

const logger = require('../../config/logger');
const aiCreditService = require('../aiCreditService');
const entitlementsService = require('../entitlementsService');
const { FEATURE_KEYS } = require('../../config/featureCatalog');
const replyGenerationService = require('./replyGenerationService');
const { runWithAiContextAndUsageId } = require('../aiRequestContext');
const { isThreadStyleDm } = require('../../utils/interactionThreadDm');

const DEFAULT_MIN_CONFIDENCE = 0.7;
const AUTO_REPLY_CREDITS = 1;

/** Lowercase + trim a list of platform names; drops empties. */
function normalizePlatformList(list) {
  if (!list?.length) return [];
  return list.map((p) => String(p).toLowerCase().trim()).filter(Boolean);
}

/** True when sentiment analysis has finished with a known label. */
function hasKnownSentiment(interaction) {
  const s = interaction.sentiment;
  return s === 'positive' || s === 'negative' || s === 'neutral';
}

/**
 * Cheap pre-queue gate. Skips the queue entirely when the org has clearly
 * opted out for this platform / type. Sentiment-based filters are NOT checked
 * here because sentiment is computed asynchronously.
 */
function shouldQueueImmediateAutoReply(interaction, organizationDoc) {
  if (!organizationDoc?.autoReplySettings) return false;
  const settings = organizationDoc.autoReplySettings;
  if (!settings.enabled) return false;

  const plat = (interaction.platform || '').toLowerCase();
  if (settings.enabledPlatforms?.length) {
    const allowed = normalizePlatformList(settings.enabledPlatforms);
    if (!allowed.includes(plat)) return false;
  }
  if (settings.enabledTypes?.length) {
    if (!settings.enabledTypes.includes(interaction.type)) return false;
  }
  return true;
}

/** Apply the org's sentimentFilter rule to the interaction's sentiment. */
function isBlockedBySentimentFilter(sentimentFilter, sentiment) {
  switch (sentimentFilter) {
    case 'negative_only':    return sentiment !== 'negative';
    case 'positive_only':    return sentiment !== 'positive';
    case 'neutral_only':     return sentiment !== 'neutral';
    case 'positive_neutral': return sentiment === 'negative';
    default:                 return false;
  }
}

/**
 * Full eligibility check. Returns false if the interaction must NOT be auto-replied
 * for any reason (already replied, platform/type/sentiment/bucket disabled, …).
 */
async function canAutoReply(interaction, organizationSettings = {}) {
  // Single-document DM threads (dm_*_*) keep replies[] as conversation history,
  // so the "already answered" rule doesn't apply to them.
  if (!isThreadStyleDm(interaction)) {
    if (interaction.status === 'replied' || interaction.status === 'resolved') return false;
    if (interaction.replies?.length > 0) return false;
  }

  // Mark replies-to-our-replies for the worker to verify against the parent doc.
  if (interaction.parentId) {
    interaction._needsParentCheck = true;
  }

  // Accept either plain object or Mongoose doc
  const settings =
    organizationSettings.autoReplySettings ||
    organizationSettings?.toObject?.()?.autoReplySettings ||
    {};

  if (!settings.enabled) return false;

  if (settings.enabledPlatforms?.length) {
    const plat = (interaction.platform || '').toLowerCase();
    const allowed = normalizePlatformList(settings.enabledPlatforms);
    if (!allowed.includes(plat)) {
      logger.warn('[canAutoReply] Blocked by platform filter', {
        interactionId: interaction._id?.toString(),
        platform: plat,
        allowed
      });
      return false;
    }
  }

  if (settings.enabledTypes?.length) {
    if (!settings.enabledTypes.includes(interaction.type)) {
      logger.warn('[canAutoReply] Blocked by type filter', {
        interactionId: interaction._id?.toString(),
        type: interaction.type,
        allowed: settings.enabledTypes
      });
      return false;
    }
  }

  const sentimentFilter = settings.sentimentFilter || 'all';
  const sentiment = interaction.sentiment;

  if (sentimentFilter !== 'all') {
    // Any non-"all" filter requires a completed sentiment analysis
    if (!hasKnownSentiment(interaction)) return false;
    if (isBlockedBySentimentFilter(sentimentFilter, sentiment)) {
      logger.warn('[canAutoReply] Blocked by sentiment filter', {
        interactionId: interaction._id?.toString(),
        filter: sentimentFilter,
        sentiment
      });
      return false;
    }
  }

  // Per-bucket reply toggle
  if (interaction.intentBucket) {
    const IntentBucket = require('../../models/IntentBucket');
    const bucket = await IntentBucket.findById(interaction.intentBucket).select('replyEnabled name').lean();
    if (bucket && bucket.replyEnabled === false) {
      logger.warn('[canAutoReply] Blocked by bucket toggle', {
        interactionId: interaction._id?.toString(),
        bucket: bucket.name
      });
      return false;
    }
  }

  return true;
}

/**
 * Resolve the user we should attribute the AI usage to.
 * Preference: the interaction's assignee → any org admin/manager → undefined.
 */
async function resolveAttributableUserId(interaction, organizationId) {
  if (interaction.assignedTo) return interaction.assignedTo;
  try {
    const User = require('../../models/User');
    const adminUser = await User.findOne({
      organization: organizationId,
      role: { $in: ['admin', 'manager'] }
    }).select('_id');
    return adminUser?._id;
  } catch {
    return undefined;
  }
}

async function deductCreditsSafely(organizationId, operation, interaction, aiApiUsageId) {
  try {
    const userId = await resolveAttributableUserId(interaction, organizationId);
    await aiCreditService.deductCredits(
      organizationId,
      AUTO_REPLY_CREDITS,
      {
        operation,
        userId,
        interactionId: interaction._id.toString(),
        platform: interaction.platform
      },
      { aiApiUsageId }
    );
    // Mirror into the dedicated auto-reply bucket so the per-plan quota
    // (`credits.autoReply.monthly`) is incremented alongside the AI credit pool.
    await entitlementsService
      .consume(organizationId, FEATURE_KEYS.CREDITS_AUTO_REPLY, AUTO_REPLY_CREDITS)
      .catch(() => {});
  } catch {
    // Credit deduction failure is non-fatal — usage is logged separately.
  }
}

/**
 * End-to-end auto-reply generation. See module header for return-shape contract.
 */
async function generateAutoReply(interaction, organizationId, organizationSettings = {}) {
  try {
    if (!(await canAutoReply(interaction, organizationSettings))) {
      return {
        eligible: false,
        reason: 'Interaction not eligible for auto-reply based on settings'
      };
    }

    // Plan-level auto-reply quota — separate from the generic AI credit pool.
    // Free plan caps it at 100/month per spec. Limited Free plans burn this
    // bucket FIRST so users get a clear "you've used your auto-reply allotment"
    // error instead of the generic AI credit message.
    try {
      await entitlementsService.assert(organizationId, FEATURE_KEYS.CREDITS_AUTO_REPLY, AUTO_REPLY_CREDITS);
    } catch (err) {
      if (err?.name === 'EntitlementError') {
        logger.warn('[Auto-Reply] Auto-reply credit quota exhausted', { organizationId, code: err.code });
        return {
          eligible: false,
          reason: err.message,
          code: err.code,
          featureKey: err.featureKey,
          creditsNeeded: AUTO_REPLY_CREDITS,
          creditsRemaining: err.meta?.remaining ?? 0
        };
      }
      throw err;
    }

    const creditCheck = await aiCreditService.checkCredits(organizationId, AUTO_REPLY_CREDITS);
    if (!creditCheck.allowed) {
      logger.warn('[Auto-Reply] AI credit limit reached', { organizationId });
      return {
        eligible: false,
        reason: creditCheck.error || 'Insufficient AI credits for auto-reply',
        code: creditCheck.code || 'AI_CREDITS_EXCEEDED',
        creditsNeeded: AUTO_REPLY_CREDITS,
        creditsRemaining: creditCheck.remaining
      };
    }

    // Layer 2: LLM also returns a `resolvable` flag for human-routing decisions.
    const { result: response, aiApiUsageId } = await runWithAiContextAndUsageId(
      {
        organizationId,
        userId: interaction.assignedTo || undefined,
        feature: 'inbox.auto_reply'
      },
      () => replyGenerationService.generateResponseOpenAI(
        interaction, organizationId, null, { withSelfAssessment: true }
      )
    );

    if (!response) {
      return { eligible: false, reason: 'Failed to generate AI response' };
    }

    if (response.resolvable === false) {
      logger.info('[Auto-reply] AI self-assessed as unresolvable — routing to human', {
        interactionId: interaction._id?.toString(),
        reason: response.resolvableReason
      });
      // Still charge for the LLM call we made.
      await deductCreditsSafely(organizationId, 'auto_reply_unresolvable', interaction, aiApiUsageId);
      return {
        eligible: true,
        resolvable: false,
        resolvableReason: response.resolvableReason,
        creditsUsed: AUTO_REPLY_CREDITS
      };
    }

    const minConfidence = organizationSettings.autoReplySettings?.minConfidence || DEFAULT_MIN_CONFIDENCE;
    if (response.confidence < minConfidence) {
      return {
        eligible: false,
        reason: `Confidence ${response.confidence} below threshold ${minConfidence}`,
        response
      };
    }

    await deductCreditsSafely(organizationId, 'auto_reply', interaction, aiApiUsageId);
    return { eligible: true, response, creditsUsed: AUTO_REPLY_CREDITS };
  } catch (error) {
    logger.error('Auto-reply generation error', {
      error: error.message,
      interactionId: interaction?._id?.toString()
    });
    return { eligible: false, reason: error.message };
  }
}

module.exports = {
  shouldQueueImmediateAutoReply,
  canAutoReply,
  generateAutoReply,
  // Helpers exposed only for the facade's backward-compat shims.
  _internal: {
    normalizePlatformList,
    hasKnownSentiment
  }
};
