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
const { buildRecentConversationTranscript } = require('../../utils/inboxConversationTranscript');
const { AI_VOICE_BLOCK } = require('../../config/aiVoiceRules');
const { stripMarkdownForMessaging } = require('../../utils/aiTextFormatting');
const {
  normalizeOpenAIModelId,
  openAIChatCompletionMaxTokensField,
  openAIChatCompletionTemperatureField
} = require('../../utils/openaiModelHelpers');

const MAX_KB_ENTRY_CHARS = 400;   // per-entry cap injected into the prompt
const MAX_KB_TOTAL_CHARS = 1200;  // hard total cap across all entries
// Conversation memory the model gets for continuity. Larger than the transcript
// default so the agent reasons over the recent thread (last ~15-20 turns), while
// the char cap keeps prompt token cost bounded.
const CONVERSATION_TRANSCRIPT_MAX_MESSAGES = 18;
const CONVERSATION_TRANSCRIPT_MAX_TOTAL_CHARS = 4000;
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

/**
 * Opaque placeholders WhatsApp/native-cart use when the customer sent an order
 * with NO real typed text (e.g. "[Product order]"). Only in this case may the
 * order description stand in for the customer's message.
 */
const OPAQUE_ORDER_PLACEHOLDER_RE = /^\s*\[?\s*(product\s*order|order|cart|checkout)\s*\]?\s*$/i;

function isOpaqueOrderPlaceholder(content) {
  const s = String(content == null ? '' : content).trim();
  if (!s) return true; // empty content → native cart with no text
  return OPAQUE_ORDER_PLACEHOLDER_RE.test(s);
}

/**
 * Resolve the "latest customer message" line injected into the prompt.
 *
 * CRITICAL: for any real typed message the customer's OWN words must be what the
 * model answers — the open order is background context only. We substitute the
 * order description ONLY when the actual message is an opaque cart placeholder
 * (WhatsApp native cart). Previously the order always replaced the message, so
 * "hi"/gibberish/anything got answered with an order confirmation.
 *
 * @param {object} interaction
 * @param {string} [orderContext]
 * @returns {{ line: string, usedOrderAsMessage: boolean }}
 */
function resolveLatestMessageForPrompt(interaction, orderContext) {
  const order = (orderContext && String(orderContext).trim()) || '';
  const content = interaction?.content != null ? String(interaction.content).trim() : '';
  if (order && isOpaqueOrderPlaceholder(content)) {
    return { line: `the customer placed an order — ${order}`, usedOrderAsMessage: true };
  }
  return { line: `"${content}"`, usedOrderAsMessage: false };
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

/** Preset tone instructions for org AI Auto-Reply (Automation Hub). */
const AUTO_REPLY_TONE_PRESETS = {
  growth:
    'AUTO-REPLY TONE (Growth): Sound upbeat and conversion-aware — proactive suggestions, clear next steps, light promotional framing where helpful. Stay authentic; avoid hype or spammy language.',
  balanced:
    'AUTO-REPLY TONE (Balanced): Friendly, helpful, and natural — default professional customer-care voice. Clear and concise.',
  safe:
    'AUTO-REPLY TONE (Safe): Conservative and neutral — de-escalate, avoid strong opinions or edgy humour, prioritize factual clarity and trust.'
};

/**
 * Build an extra guideline block from Organization.autoReplySettings (auto-reply path only).
 * @param {string} [tone]
 * @param {string} [customText]
 * @returns {string}
 */
function buildAutoReplyToneAddon(tone, customText) {
  const key = (tone || 'balanced').toLowerCase();
  if (key === 'custom') {
    const t = String(customText || '')
      .trim()
      .slice(0, 800);
    if (!t) {
      return 'AUTO-REPLY TONE (Custom): The organization chose a custom tone but left instructions empty — use a professional, friendly customer-service voice.';
    }
    return `AUTO-REPLY TONE (Custom — follow strictly; this overrides generic tone hints):\n${t}`;
  }
  return AUTO_REPLY_TONE_PRESETS[key] || AUTO_REPLY_TONE_PRESETS.balanced;
}

/**
 * Anti-hallucination rules injected into every system prompt.
 * Ensures the model never fabricates facts it wasn't given.
 */
const ANTI_HALLUCINATION_BLOCK = `
ANTI-HALLUCINATION RULES (NON-NEGOTIABLE — never violate these):
- NEVER claim to have sent, attached, or shared an image, photo, file, or document. You can only send text; any attachment must come through a separate system action.
- NEVER invent product details: colors, sizes, patterns, designs, availability, stock level, price, discount, SKU, or variant. If not provided, say "I don't have that detail available" or offer to have the team confirm.
- NEVER fabricate order status, tracking number, delivery date, estimated arrival, refund status, return status, cancellation status, or payment status. If not provided, state that only the team can confirm and route accordingly.
- NEVER confirm an appointment or booking unless you are given explicit booking confirmation data.
- NEVER use customer-sounding phrases like "I've sent you the image" or "here's the photo" — only the system can send media.
- If a customer asks for product images and no image data is in context, say exactly: "I'm sorry, product images aren't available here right now. I can share full details or connect you with our team."
- If asked about something you were not given data for, be transparent: say the information is not available rather than guessing or estimating.
`;

function buildBaseGuidelines(bucketContext, kbContext, conversationTranscript = '', autoReplyToneAddon = '', orderContext = '', productContext = '') {
  const transcript = (conversationTranscript && String(conversationTranscript).trim()) || '';
  const productBlock = (productContext && String(productContext).trim())
    ? `\n\nPRODUCT CATALOG (GROUND YOUR ANSWERS IN THESE FACTS — do NOT add details beyond what is listed here):\n${String(productContext).trim()}`
    : '';
  const orderBlock = (orderContext && String(orderContext).trim())
    ? `

ACTIVE ORDER (BACKGROUND CONTEXT ONLY — this is NOT the customer's message):
${String(orderContext).trim()}
- This order is ALREADY recorded. Do NOT "confirm" it again, do NOT restate its price/total, and do NOT thank them for ordering — UNLESS the customer's latest message is clearly them placing or confirming an order right now.
- ALWAYS reply to the customer's ACTUAL latest message (shown in the user prompt). If they greet, greet back; if they ask something, answer THAT; if the message is unclear or looks like random characters, ask a short, friendly clarifying question. Never volunteer order details they didn't ask about.
- Use the order above only if the customer asks about their order/items/total/status — then use these exact details. Never re-ask which product or what quantity.
- Delivery address: ONLY if the customer is actively moving forward with this order AND the recent thread does NOT already show you asking for it, you may add ONE short line requesting their full delivery address (house/flat, area/landmark, city, pincode). If it was already requested earlier in the thread, do NOT ask again.
- Keep it concise, natural, and human.`
    : '';
  const continuity = transcript
    ? `

CONVERSATION CONTINUITY (threaded inbox):
- You are continuing an ongoing conversation — not answering a single isolated message in a vacuum.
- Use the recent messages below for context: reference prior points briefly when it helps, avoid repeating full greetings or the same opening the business already used, and do not contradict earlier business replies in this thread.
- Prioritize resolving the customer's *latest* intent (see the user prompt) while staying consistent with the thread.
- Match the customer's language and tone when appropriate.

Recent thread (last messages, chronological):
${transcript}`
    : '';

  return `IMPORTANT GUIDELINES:
- Be warm and straightforward — polite without being formal
- Keep responses concise and clear (2-4 sentences) unless the thread clearly needs more detail
- Address the customer's concern directly
${AI_VOICE_BLOCK}
- If knowledge base content is provided, ground your answer in that content and prioritize those facts over generic wording
- Never say placeholders like "[List of services]"; provide real items from the knowledge base
- If the user asks to list offerings/services/features, return a clear bullet list using names found in the knowledge base
- If you don't have enough information, acknowledge it professionally
- Do not make promises you can't keep
- Match the tone to the platform (casual for social media, professional for reviews)
${ANTI_HALLUCINATION_BLOCK}
${orderBlock}
${continuity}
${bucketContext ? `\n${bucketContext}` : ''}
${kbContext ? `\n\nKNOWLEDGE BASE (Use this information to answer; it may be general brand/FAQ context if the user message was very short):\n${kbContext}` : '\n\nNote: No specific knowledge base available. Provide a general helpful response.'}
${productBlock}
${autoReplyToneAddon ? `\n\n${autoReplyToneAddon}` : ''}`;
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
async function callSelfAssessment(interaction, baseGuidelines, conversationTranscript, orderContext = '') {
  const selfAssessSystemPrompt = `You are a professional customer service AI. Assess if you can fully resolve this query WITHOUT: private account data, real-time system data, or internal tools.

${baseGuidelines}

Reply with JSON only (no markdown):
{"resolvable":true/false,"reason":"why not resolvable (if false)","confidence":0.0-1.0,"reply":"customer-facing reply text","messageType":"small_talk|business|unclear|closing","noReply":false}

CRITICAL RULES — you MUST follow all of these:
1. greeting/small talk → messageType "small_talk", resolvable true, confidence 1.0, always include a friendly reply.
2. Cannot resolve (missing private data, wrong business, etc.) → resolvable false, include a SHORT generic reply such as "I'm sorry, I'm unable to help with that. A team member will assist you shortly." OR set noReply true if no reply should be sent at all.
3. NEVER omit the "reply" field unless noReply is explicitly true. An empty or missing reply with resolvable:false causes internal JSON to be delivered to the customer — this is a critical bug.
4. Automated pleasantries / bot-like messages ("thank you so much, always a pleasure to connect, wishing you a wonderful day") → messageType "closing", noReply true, reply "".
5. Message is from the wrong business or a competitor reference and you cannot help → resolvable false, short polite handoff reply, confidence < 0.5.
6. Unclear query → attempt a clarifying question (low confidence).
7. noReply true → reply field may be empty string "".
8. Account- or order-specific requests you CANNOT verify from the knowledge base or the provided order context — order status/tracking ("where is my order"), refund/return/replacement/cancellation status, arranging a pickup, payment/billing disputes, or changing an existing order — need private/system data → resolvable false, confidence < 0.6, and a short reply that a team member will assist. NEVER invent a status, order number, tracking detail, or timeline.
9. If your reply tells the customer that a human, agent, team, or "someone" will contact / reach out / follow up, or that you have escalated / forwarded / raised / passed along their request — you are NOT resolving it yourself: set resolvable false. Never claim a human will follow up while resolvable is true.`;

  const transcript = (conversationTranscript && String(conversationTranscript).trim()) || '';
  // Substitute the order for the message ONLY when the real message is an opaque
  // native-cart placeholder; otherwise the customer's actual words are the intent.
  const { line: latestMessage } = resolveLatestMessageForPrompt(interaction, orderContext);
  const userContent = transcript
    ? `Recent conversation:\n${transcript}\n\nLatest customer message (prioritize replying to this): ${latestMessage}\nPlatform: ${interaction.platform} | Sentiment: ${interaction.sentiment || 'unknown'}`
    : `Message: ${latestMessage}\nPlatform: ${interaction.platform} | Sentiment: ${interaction.sentiment || 'unknown'}`;

  const response = await openaiClient.chatCompletion(
    {
      model: openaiClient.chatModel,
      messages: [
        { role: 'system', content: selfAssessSystemPrompt },
        {
          role: 'user',
          content: userContent
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
    const conversationTranscript = buildRecentConversationTranscript(interaction, {
      maxMessages: CONVERSATION_TRANSCRIPT_MAX_MESSAGES,
      maxTotalChars: CONVERSATION_TRANSCRIPT_MAX_TOTAL_CHARS,
      sessionStartedAt: options.sessionStartedAt || null
    });
    const arTone = options.autoReplyTone;
    const arToneCustom = options.autoReplyToneCustom;
    const toneAddon =
      arTone !== undefined && arTone !== null && String(arTone).length > 0
        ? buildAutoReplyToneAddon(arTone, arToneCustom)
        : '';
    const orderContext = options.orderContext || '';
    // productContext: grounded product facts so AI never invents colors/images/sizes/prices
    const productContext = options.productContext || '';
    const baseGuidelines = buildBaseGuidelines(bucketContext, kbContext, conversationTranscript, toneAddon, orderContext, productContext);

    if (withSelfAssessment) {
      // NOTE: Layer 0 (messageIntentClassifier) already filters out 'closing' and 'gibberish'
      // messages before this AI call is made. Only 'small_talk' and 'business' messages reach here.
      const { raw, parsed } = await callSelfAssessment(interaction, baseGuidelines, conversationTranscript, orderContext);

      // Case 1 — ideal path: JSON parsed AND contains a customer-safe reply string.
      if (parsed && typeof parsed.reply === 'string' && parsed.reply.trim().length > 0) {
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

      // Case 2 — JSON parsed but no customer-facing reply.
      // This happens when the model returns resolvable:false / noReply:true without a reply field.
      // NEVER use raw JSON text as the customer reply.
      if (parsed) {
        const confidence = typeof parsed.confidence === 'number'
          ? Math.max(0, Math.min(1, parsed.confidence))
          : kbBackedConfidence(relevantKB);

        // Explicit noReply or closing signal — resolve conversation silently.
        if (parsed.noReply === true || parsed.messageType === 'closing') {
          logger.info('[AI] Self-assessment: noReply/closing signal — resolving silently', {
            interactionId: interaction._id?.toString(),
            messageType: parsed.messageType
          });
          return {
            content: '',
            confidence,
            resolvable: true,
            noReply: true,
            messageType: parsed.messageType || 'closing',
            resolvableReason: null,
            generatedAt: new Date(),
            usedKnowledgeBase: !!relevantKB?.length,
            knowledgeBaseCount: relevantKB?.length || 0,
            knowledgeBaseFallback
          };
        }

        // resolvable:false without a reply — route to human, send handoff message.
        logger.warn('[AI] Self-assessment returned resolvable:false or empty reply — routing to human', {
          interactionId: interaction._id?.toString(),
          resolvable: parsed.resolvable,
          reason: parsed.reason
        });
        return {
          content: '',
          confidence,
          resolvable: false,
          noReply: false,
          messageType: parsed.messageType || 'business',
          resolvableReason: parsed.reason || 'Requires access to private account or system data',
          generatedAt: new Date(),
          usedKnowledgeBase: !!relevantKB?.length,
          knowledgeBaseCount: relevantKB?.length || 0,
          knowledgeBaseFallback
        };
      }

      // Case 3 — JSON parse failed entirely.
      // If raw output looks like internal JSON metadata, never send it to the customer.
      const looksLikeInternalJson = /^\s*\{[\s\S]*"resolvable"/.test(raw);
      if (looksLikeInternalJson) {
        logger.warn('[AI] Self-assessment raw output looks like internal JSON — routing to human instead of sending', {
          interactionId: interaction._id?.toString(),
          rawPreview: raw.slice(0, 120)
        });
        return {
          content: '',
          confidence: kbBackedConfidence(relevantKB),
          resolvable: false,
          noReply: false,
          messageType: 'business',
          resolvableReason: 'AI response could not be parsed into a customer reply',
          generatedAt: new Date(),
          usedKnowledgeBase: !!relevantKB?.length,
          knowledgeBaseCount: relevantKB?.length || 0,
          knowledgeBaseFallback
        };
      }

      // Case 4 — raw text is a plain non-JSON string (rare, valid fallback).
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

    const { line: stdLatest } = resolveLatestMessageForPrompt(interaction, orderContext);
    const stdUserContent = (conversationTranscript && conversationTranscript.trim())
      ? `Recent conversation:\n${conversationTranscript}\n\nLatest customer message:\n${stdLatest}\n\nPlatform: ${interaction.platform}\nType: ${interaction.type}\nSentiment: ${interaction.sentiment || 'unknown'}`
      : `Customer message: ${stdLatest}\n\nPlatform: ${interaction.platform}\nType: ${interaction.type}\nSentiment: ${interaction.sentiment || 'unknown'}`;

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
            content: stdUserContent
          }
        ],
        ...openAIChatCompletionTemperatureField(openaiClient.chatModel, STANDARD_REPLY_TEMPERATURE),
        ...openAIChatCompletionMaxTokensField(openaiClient.chatModel, STANDARD_REPLY_MAX_TOKENS)
      },
      {},
      { timeout: REPLY_TIMEOUT_MS }
    );

    const generatedResponse = stripMarkdownForMessaging(
      response.data.choices[0].message.content.trim(),
      interaction.platform
    );

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
    const status = error.response?.status;
    const openAiCode = error.response?.data?.error?.code;
    const openAiMessage = error.response?.data?.error?.message;
    logger.error('[AI] Text generation error', {
      error: error.message,
      status,
      openAiCode,
      model: normalizeOpenAIModelId(model || openaiClient.chatModel)
    });
    if (status === 404 && (openAiCode === 'model_not_found' || /model/i.test(openAiMessage || ''))) {
      throw new Error(
        `OpenAI model not found (404). Check OPENAI_MODEL on the server — retired ids like gpt-5.3-chat-latest fail on /chat/completions. Use gpt-5.4 or gpt-4o.`
      );
    }
    throw new Error(`Failed to generate text: ${error.message}`);
  }
}

module.exports = {
  generateResponse,
  generateResponseOpenAI,
  generateText,
  // Exported for unit tests
  isOpaqueOrderPlaceholder,
  resolveLatestMessageForPrompt
};
