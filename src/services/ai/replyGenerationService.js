/**
 * Reply Generation Service
 *
 * Three public functions:
 *   - generateResponse(...)      — thin alias for generateResponseOpenAI (kept for API stability)
 *   - generateResponseOpenAI(...) — primary inbox-reply generator with optional self-assessment
 *   - generateText(...)          — generic text-generation utility (summarisation, extraction, etc.)
 *
 * generateResponseOpenAI does heavy lifting:
 *   1. Resolves a relevant knowledge-base slice (or fallback brand summary)
 *   2. Loads bucket-specific reply config (tone, language, special instructions)
 *   3. Builds a guideline-rich system prompt
 *   4. In `withSelfAssessment` mode: asks the LLM to reply AND self-classify whether
 *      it can resolve the query (used by the auto-reply Layer 2 routing).
 *
 * Failure mode: throws on API/network errors; callers expect to handle/retry.
 */

const logger = require('../../config/logger');
const openaiClient = require('./openaiClient');
const knowledgeBaseSearchService = require('./knowledgeBaseSearchService');
const {
  normalizeOpenAIModelId,
  openAIChatCompletionMaxTokensField,
  openAIChatCompletionTemperatureField
} = require('../../utils/openaiModelHelpers');

const MAX_KB_ENTRY_CHARS = 400;   // per-entry cap injected into the prompt
const MAX_KB_TOTAL_CHARS = 1200;  // hard total cap across all entries
const REPLY_TIMEOUT_MS = 120000;
const STANDARD_REPLY_TEMPERATURE = 0.7;
const STANDARD_REPLY_MAX_TOKENS = 200;
const SELF_ASSESS_TEMPERATURE = 0.7;
const SELF_ASSESS_MAX_TOKENS = 400;
const TEXT_GEN_DEFAULT_TEMPERATURE = 0.7;
const TEXT_GEN_DEFAULT_MAX_TOKENS = 1000;
const TEXT_GEN_HARD_MAX = 4000;

const BASE_CONFIDENCE = 0.78;
const KB_CONFIDENCE_BONUS = 0.04;
const MAX_CONFIDENCE = 0.95;

/** Confidence boost from KB matches, capped at 0.95. */
function kbBackedConfidence(relevantKB) {
  if (!relevantKB?.length) return BASE_CONFIDENCE;
  return Math.min(MAX_CONFIDENCE, BASE_CONFIDENCE + relevantKB.length * KB_CONFIDENCE_BONUS);
}

/** Cap each KB entry and the total context length to control prompt token cost. */
function buildKbContext(relevantKB) {
  if (!relevantKB?.length) return '';
  let totalChars = 0;
  const parts = [];
  for (const kb of relevantKB) {
    if (totalChars >= MAX_KB_TOTAL_CHARS) break;
    const body = (kb.content || '').substring(0, MAX_KB_ENTRY_CHARS);
    const truncated = (kb.content || '').length > MAX_KB_ENTRY_CHARS ? '…' : '';
    const entry = `${kb.title}: ${body}${truncated}`;
    totalChars += entry.length;
    parts.push(entry);
  }
  return parts.join('\n\n');
}

/**
 * Resolve relevant KB entries (or use the provided ones), increment usage counts
 * on real matches (not on top-priority fallbacks), and return both the entries
 * and the fallback flag for confidence scoring.
 */
async function resolveKnowledgeBase(interaction, organizationId, providedKB) {
  if (providedKB) return { entries: providedKB, fromFallback: false };
  if (!organizationId) return { entries: null, fromFallback: false };

  const { entries, fromFallback } = await knowledgeBaseSearchService.searchKnowledgeBase(
    organizationId,
    interaction.content,
    5
  );

  // Only count real KB matches — top-priority fallback context shouldn't inflate usage stats.
  if (!fromFallback && entries?.length) {
    for (const kb of entries) {
      try {
        if (typeof kb.usageCount !== 'number' || isNaN(kb.usageCount)) {
          kb.usageCount = 0;
        }
        await kb.incrementUsage();
      } catch (usageError) {
        logger.error('Error incrementing KB usage', { error: usageError.message, kbId: kb._id?.toString() });
      }
    }
  }

  return { entries, fromFallback };
}

/**
 * Load bucket reply config (tone, language, special prompt) — falls back to
 * BrandConfig.toneOfVoice when bucket has no tone.
 */
async function buildBucketContext(interaction, organizationId) {
  if (!interaction.intentBucket) return '';

  try {
    const IntentBucket = require('../../models/IntentBucket');
    const bucketConfig = await IntentBucket.findById(interaction.intentBucket)
      .select('replyTone replyLanguage replyPrompt name')
      .lean();
    if (!bucketConfig) return '';

    let tone = bucketConfig.replyTone;
    if (!tone && organizationId) {
      // Fall back to org-wide brand voice. NOTE: BrandConfig must be required here
      // (was missing in the original inline implementation — latent ReferenceError).
      const BrandConfig = require('../../models/BrandConfig');
      const bc = await BrandConfig.findOne({ organization: organizationId }).select('toneOfVoice').lean();
      tone = bc?.toneOfVoice || 'professional';
    }

    let bucketContext = `\nREPLY CONTEXT (Bucket: "${bucketConfig.name}"):`;
    if (tone) bucketContext += `\n- Tone: ${tone}`;
    if (bucketConfig.replyLanguage && bucketConfig.replyLanguage !== 'auto') {
      bucketContext += `\n- Reply Language: ${bucketConfig.replyLanguage}`;
    }
    if (bucketConfig.replyPrompt) {
      bucketContext += `\n- Special Instructions: ${bucketConfig.replyPrompt}`;
    }
    return bucketContext;
  } catch (bucketErr) {
    logger.error('Error loading bucket config for reply', { error: bucketErr.message });
    return '';
  }
}

function buildBaseGuidelines(bucketContext, kbContext) {
  return `IMPORTANT GUIDELINES:
- Be polite, empathetic, and professional
- Keep responses concise and clear (2-4 sentences)
- Use a friendly and conversational tone
- Address the customer's concern directly
- If knowledge base content is provided, ground your answer in that content and prioritize those facts over generic wording
- Never say placeholders like "[List of services]"; provide real items from the knowledge base
- If the user asks to list offerings/services/features, return a clear bullet list using names found in the knowledge base
- If you don't have enough information, acknowledge it professionally
- Do not make promises you can't keep
- Match the tone to the platform (casual for social media, professional for reviews)
${bucketContext ? `\n${bucketContext}` : ''}
${kbContext ? `\n\nKNOWLEDGE BASE (Use this information to answer; it may be general brand/FAQ context if the user message was very short):\n${kbContext}` : '\n\nNote: No specific knowledge base available. Provide a general helpful response.'}`;
}

/**
 * Map an OpenAI HTTP/network error to a user-facing Error.
 */
function rethrowOpenAIReplyError(error) {
  if (error.response) {
    const status = error.response.status;
    const errorData = error.response.data;

    if (status === 401) {
      logger.error('OpenAI authentication failed', { status });
      throw new Error('OpenAI API key is invalid or expired. Please contact your administrator.');
    }
    if (status === 429) {
      logger.error('OpenAI rate limit exceeded');
      throw new Error('AI service is temporarily unavailable due to rate limits. Please try again later.');
    }
    if (status === 500 || status === 502 || status === 503) {
      logger.error('OpenAI service error', { status, error: errorData });
      throw new Error('AI service is temporarily unavailable. Please try again later.');
    }
    logger.error('OpenAI error', { status, error: errorData });
    throw new Error(`AI service error: ${errorData?.error?.message || 'Unknown error'}`);
  }

  if (error.request) {
    logger.error('No response from OpenAI API', { error: error.message });
    throw new Error('Unable to connect to AI service. Please check your internet connection and try again.');
  }

  logger.error('AI response generation error', { error: error.message });
  throw error;
}

/**
 * Self-assessment prompt: asks the model to both reply AND classify whether
 * it can fully resolve the query. Returns parsed JSON or the raw text on
 * parse failure.
 */
async function callSelfAssessment(interaction, baseGuidelines) {
  const selfAssessSystemPrompt = `You are a professional customer service AI. Assess if you can fully resolve this query WITHOUT: private account data, real-time system data, or internal tools.

${baseGuidelines}

Reply with JSON only (no markdown):
{"resolvable":true/false,"reason":"why not resolvable (if false)","confidence":0.0-1.0,"reply":"customer-facing reply","messageType":"small_talk|business|unclear","noReply":false}

Rules: greeting/small talk → messageType small_talk, resolvable true, confidence 1.0. Unclear query → attempt a clarifying question (low confidence). Cannot resolve → resolvable false.`;

  const response = await openaiClient.chatCompletion(
    {
      model: openaiClient.chatModel,
      messages: [
        { role: 'system', content: selfAssessSystemPrompt },
        {
          role: 'user',
          content: `Message: "${interaction.content}"\nPlatform: ${interaction.platform} | Sentiment: ${interaction.sentiment || 'unknown'}`
        }
      ],
      ...openAIChatCompletionTemperatureField(openaiClient.chatModel, SELF_ASSESS_TEMPERATURE),
      ...openAIChatCompletionMaxTokensField(openaiClient.chatModel, SELF_ASSESS_MAX_TOKENS)
    },
    {},
    { timeout: REPLY_TIMEOUT_MS }
  );

  const raw = response.data.choices[0].message.content.trim();
  let parsed = null;
  try {
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    parsed = JSON.parse(jsonMatch ? jsonMatch[0] : raw);
  } catch {
    logger.warn('[AI] Self-assessment JSON parse failed, falling back to raw reply', {
      interactionId: interaction._id?.toString()
    });
  }
  return { raw, parsed };
}

/**
 * Generate an AI reply via OpenAI.
 *
 * @param {object} interaction
 * @param {string|null} [organizationId]
 * @param {Array|null}  [knowledgeBase]
 * @param {object}      [options]
 * @param {boolean}     [options.withSelfAssessment=false]
 * @returns {Promise<{
 *   content: string,
 *   confidence: number,
 *   resolvable: boolean,
 *   noReply?: boolean,
 *   messageType?: string,
 *   resolvableReason: string|null,
 *   generatedAt: Date,
 *   usedKnowledgeBase: boolean,
 *   knowledgeBaseCount: number,
 *   knowledgeBaseFallback: boolean
 * }>}
 */
async function generateResponseOpenAI(interaction, organizationId = null, knowledgeBase = null, options = {}) {
  const withSelfAssessment = options.withSelfAssessment === true;

  try {
    if (!openaiClient.hasApiKey()) {
      logger.error('OpenAI API key is not configured');
      throw new Error('OpenAI API key is not configured. Please contact your administrator.');
    }

    const { entries: relevantKB, fromFallback: knowledgeBaseFallback } = await resolveKnowledgeBase(
      interaction, organizationId, knowledgeBase
    );

    const kbContext = buildKbContext(relevantKB);
    const bucketContext = await buildBucketContext(interaction, organizationId);
    const baseGuidelines = buildBaseGuidelines(bucketContext, kbContext);

    if (withSelfAssessment) {
      // NOTE: Layer 0 (messageIntentClassifier) already filters out 'closing' and 'gibberish'
      // messages before this AI call is made. Only 'small_talk' and 'business' messages reach here.
      const { raw, parsed } = await callSelfAssessment(interaction, baseGuidelines);

      if (parsed && typeof parsed.reply === 'string') {
        const resolvable = parsed.resolvable !== false;
        const messageType = parsed.messageType || 'business';
        const noReply = parsed.noReply === true;
        const confidence = typeof parsed.confidence === 'number'
          ? Math.max(0, Math.min(1, parsed.confidence))
          : kbBackedConfidence(relevantKB);

        return {
          content: parsed.reply.trim(),
          confidence,
          resolvable,
          noReply,
          messageType,
          resolvableReason: resolvable ? null : (parsed.reason || 'Requires access to private account or system data'),
          generatedAt: new Date(),
          usedKnowledgeBase: !!relevantKB?.length,
          knowledgeBaseCount: relevantKB?.length || 0,
          knowledgeBaseFallback
        };
      }

      // Parse failed — treat raw text as a resolvable business reply.
      return {
        content: raw,
        confidence: kbBackedConfidence(relevantKB),
        resolvable: true,
        noReply: false,
        messageType: 'business',
        resolvableReason: null,
        generatedAt: new Date(),
        usedKnowledgeBase: !!relevantKB?.length,
        knowledgeBaseCount: relevantKB?.length || 0,
        knowledgeBaseFallback
      };
    }

    // Standard mode (no self-assessment)
    const systemPrompt = `You are a professional customer service representative. 
Your task is to generate a helpful, friendly, and professional response to customer inquiries.

${baseGuidelines}

Generate a response that addresses the customer's message appropriately.`;

    const response = await openaiClient.chatCompletion(
      {
        model: openaiClient.chatModel,
        messages: [
          { role: 'system', content: systemPrompt },
          {
            role: 'user',
            content: `Customer message: "${interaction.content}"\n\nPlatform: ${interaction.platform}\nType: ${interaction.type}\nSentiment: ${interaction.sentiment || 'unknown'}`
          }
        ],
        ...openAIChatCompletionTemperatureField(openaiClient.chatModel, STANDARD_REPLY_TEMPERATURE),
        ...openAIChatCompletionMaxTokensField(openaiClient.chatModel, STANDARD_REPLY_MAX_TOKENS)
      },
      {},
      { timeout: REPLY_TIMEOUT_MS }
    );

    const generatedResponse = response.data.choices[0].message.content.trim();

    return {
      content: generatedResponse,
      confidence: kbBackedConfidence(relevantKB),
      resolvable: true,
      resolvableReason: null,
      generatedAt: new Date(),
      usedKnowledgeBase: !!relevantKB?.length,
      knowledgeBaseCount: relevantKB?.length || 0,
      knowledgeBaseFallback
    };
  } catch (error) {
    rethrowOpenAIReplyError(error);
  }
}

/** Alias kept for API stability — historically defaulted to OpenAI. */
async function generateResponse(interaction, organizationId = null, knowledgeBase = null) {
  return generateResponseOpenAI(interaction, organizationId, knowledgeBase);
}

/**
 * Generic text generator (summarisation, extraction, etc).
 *
 * @param {string} systemPrompt
 * @param {string} userPrompt
 * @param {object} [options]
 * @param {number} [options.temperature=0.7]
 * @param {number} [options.maxTokens=1000]   - Hard-capped at 4000
 * @param {string} [options.model]            - Override the default chat model
 * @param {string} [options.feature]          - Logged feature name for usage attribution
 */
async function generateText(systemPrompt, userPrompt, options = {}) {
  const {
    temperature = TEXT_GEN_DEFAULT_TEMPERATURE,
    maxTokens = TEXT_GEN_DEFAULT_MAX_TOKENS,
    model = null,
    feature: optionFeature = null
  } = options;

  try {
    if (!openaiClient.hasApiKey()) {
      throw new Error('OpenAI API key is not configured');
    }

    const resolvedModel = normalizeOpenAIModelId(model || openaiClient.chatModel);
    const response = await openaiClient.chatCompletion(
      {
        model: resolvedModel,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        ...openAIChatCompletionTemperatureField(resolvedModel, temperature),
        ...openAIChatCompletionMaxTokensField(resolvedModel, maxTokens || TEXT_GEN_HARD_MAX)
      },
      optionFeature ? { feature: optionFeature } : {},
      { timeout: REPLY_TIMEOUT_MS }
    );

    return response.data.choices[0].message.content.trim();
  } catch (error) {
    logger.error('[AI] Text generation error', { error: error.message, status: error.response?.status });
    throw new Error(`Failed to generate text: ${error.message}`);
  }
}

module.exports = {
  generateResponse,
  generateResponseOpenAI,
  generateText
};
