/**
 * Post Generation Service
 *
 * Generates social-media post copy via OpenAI Chat Completions. Three flows:
 *   1. generatePost(...)         — single or per-platform post for the Composer
 *   2. generatePostVariants(...) — N variants (used by Content Studio's "give me options" flow)
 *   3. generateEventPost(...)    — composite of brand + event template + user intent
 *
 * Brand context resolution is delegated to brandContextService; this module owns
 * prompt assembly, temperature/token settings, and platform guidelines only.
 */

const logger = require('../../config/logger');
const openaiClient = require('./openaiClient');
const brandContextService = require('./brandContextService');
const { runWithAiContext } = require('../aiRequestContext');
const {
  openAIChatCompletionMaxTokensField,
  openAIChatCompletionTemperatureField
} = require('../../utils/openaiModelHelpers');

const DEFAULT_TEMPERATURE = 0.8;
const DEFAULT_MAX_TOKENS = 500;
const VARIANT_TEMPERATURES = [0.7, 0.85, 0.95];
const MAX_VARIANTS = 5;
const EVENT_POST_MAX_TOKENS = 600;

/**
 * Build temperature + token-field config for the *event post* path which uses
 * raw fields (not the helper that handles fixed-temperature models). Kept as a
 * standalone for backward compat with the inline _tempTokenConfig.
 */
function tempTokenConfig(temp, max) {
  const model = (openaiClient.chatModel || '').toLowerCase();
  const tokenField = /^gpt-5|^o[134]/.test(model)
    ? { max_completion_tokens: max }
    : { max_tokens: max };
  return { temperature: temp, ...tokenField };
}

/** Per-platform writing guidelines for post copy. */
function getPlatformGuidelines(platforms, postType) {
  const guidelines = [];

  if (platforms.includes('instagram')) {
    if (postType === 'story') {
      guidelines.push('• Instagram Story: Keep it casual, behind-the-scenes, use stickers/polls language');
    } else if (postType === 'reel') {
      guidelines.push('• Instagram Reel: Hook in 3 seconds, trending topics, discovery-focused hashtags');
    } else {
      guidelines.push('• Instagram: Visual-first, 2200 char max, 5-10 hashtags, emojis welcome');
    }
  }

  if (platforms.includes('facebook')) {
    if (postType === 'story') {
      guidelines.push('• Facebook Story: Conversational, call-to-action, time-sensitive');
    } else if (postType === 'reel' || postType === 'short') {
      guidelines.push('• Facebook Reel: Engaging hook, share-worthy, community-focused');
    } else {
      guidelines.push('• Facebook: Community-focused, longer form OK, questions for engagement');
    }
  }

  if (platforms.includes('linkedin')) {
    guidelines.push('• LinkedIn: Professional tone, industry insights, 3000 char max, 1-3 hashtags');
  }

  return guidelines.join('\n');
}

function buildSinglePostSystemPrompt(platforms, postType, brandContext) {
  const platformNames = platforms.join(', ');
  const platformGuidelines = getPlatformGuidelines(platforms, postType);
  const brandSection = brandContext ? `\nBrand guidelines (follow strictly):\n${brandContext}\n` : '';

  return `You are a professional social media content creator. Generate engaging ${postType} content for ${platformNames}.
${platformGuidelines ? `\n${platformGuidelines}` : ''}${brandSection}
Rules: Be authentic; use emojis sparingly; match platform hashtag norms; professional yet conversational tone.
Generate ONLY the post content. No explanations or meta-commentary.`;
}

function buildPostVariantSystemPrompt(platforms, postType, brandContext, occasionContext = null) {
  const platformNames = platforms.join(', ');
  const platformGuidelines = getPlatformGuidelines(platforms, postType);
  const brandSection = brandContext ? `\nBrand guidelines (follow strictly):\n${brandContext}\n` : '';
  let occasionSection = '';
  if (occasionContext) {
    const hashtagStr = (occasionContext.hashtags || []).join(' ');
    occasionSection = `\nOccasion context (follow strictly):
Occasion: ${occasionContext.name} (${occasionContext.eventType}).${occasionContext.sampleCaption ? `\nSample tone/caption: "${occasionContext.sampleCaption}".` : ''}${hashtagStr ? `\nInclude these hashtags: ${hashtagStr}.` : ''}${occasionContext.cta ? `\nCTA style: ${occasionContext.cta}.` : ''}\n`;
  }
  return `You are a professional social media content creator. Generate a SINGLE engaging ${postType} that works across ${platformNames}.
${platformGuidelines ? `\n${platformGuidelines}` : ''}${brandSection}${occasionSection}
CRITICAL RULES: Output ONE post only — no platform labels. Emojis sparingly; 3-5 hashtags at end.
Generate ONLY the post text. No explanations, headers, or meta-commentary.`;
}

/**
 * Make the actual OpenAI call for a single post.
 * @returns {Promise<string>} Trimmed post copy
 */
async function generateSinglePost(prompt, platforms, postType, brandContext = null) {
  if (!openaiClient.hasApiKey()) {
    throw new Error('OpenAI API key is not configured');
  }
  const systemPrompt = buildSinglePostSystemPrompt(platforms, postType, brandContext);
  const response = await openaiClient.chatCompletion(
    {
      model: openaiClient.chatModel,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: prompt }
      ],
      ...openAIChatCompletionTemperatureField(openaiClient.chatModel, DEFAULT_TEMPERATURE),
      ...openAIChatCompletionMaxTokensField(openaiClient.chatModel, DEFAULT_MAX_TOKENS)
    },
    {}
  );
  return response.data.choices[0].message.content.trim();
}

/**
 * Variant of generateSinglePost that takes pre-built system/user prompts and
 * a temperature override. Used by the variants flow to vary creativity.
 */
async function generateSinglePostWithTemperature(systemPrompt, userPrompt, temperature = DEFAULT_TEMPERATURE) {
  if (!openaiClient.hasApiKey()) {
    throw new Error('OpenAI API key is not configured');
  }
  const response = await openaiClient.chatCompletion(
    {
      model: openaiClient.chatModel,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      ...openAIChatCompletionTemperatureField(
        openaiClient.chatModel,
        Math.min(1, Math.max(0, temperature))
      ),
      ...openAIChatCompletionMaxTokensField(openaiClient.chatModel, DEFAULT_MAX_TOKENS)
    },
    {}
  );
  return response.data.choices[0].message.content.trim();
}

/**
 * Generate one or per-platform post copy.
 *
 * BRAND CONTEXT POLICY (intentional — do not "fix" without a product decision):
 * this path (used by the Publish/Composer "Generate with AI" quick action —
 * no mode selector shown to the user) ALWAYS applies brand voice when an
 * organizationId is supplied. This differs from generatePostVariants()
 * below, which is used by Content Studio's mode-driven ideation flow and
 * only applies brand voice when the user explicitly selects "Brand Voice"
 * mode (defaults to 'instant' = no brand context, for fast generic
 * ideation). The two surfaces have different UX contracts: Composer implies
 * "write this in my voice", Content Studio's default implies "give me raw
 * ideas first, then I'll pick a mode." Keep both call sites' JSDoc in sync
 * if this policy ever changes.
 *
 * @param {string} prompt
 * @param {string[]} platforms        - ['instagram', 'facebook', 'linkedin', ...]
 * @param {'same'|'custom'} [mode='same']
 * @param {string} [postType='post']  - 'post' | 'story' | 'reel' | 'short'
 * @param {string|null} [organizationId]
 */
async function generatePost(prompt, platforms, mode = 'same', postType = 'post', organizationId = null) {
  try {
    logger.info('[AI] Generating post', { mode, platforms, postType });

    const brandContext = organizationId ? await brandContextService.getBrandContext(organizationId) : null;

    if (mode === 'same') {
      const post = await generateSinglePost(prompt, platforms, postType, brandContext);
      return { mode: 'same', posts: { all: post }, creditsUsed: 1 };
    }

    const posts = {};
    for (const platform of platforms) {
      // Sequential rather than Promise.all because each call hits the same
      // OpenAI rate limit and per-platform brand voice tends to share context.
      posts[platform] = await generateSinglePost(prompt, [platform], postType, brandContext);
    }
    return { mode: 'custom', posts, creditsUsed: platforms.length };
  } catch (error) {
    logger.error('Generate post failed', { error: error.message });
    throw error;
  }
}

/**
 * Generate N post-text variants for Content Studio.
 *
 * @param {string}   prompt
 * @param {string[]} platforms
 * @param {object}   [options]
 * @param {number}   [options.count=3]            - Number of variants (clamped to 5)
 * @param {string}   [options.organizationId]
 * @param {string}   [options.userId]
 * @param {string}   [options.postType='post']
 * @param {string}   [options.audience]
 * @param {string}   [options.intent]
 * @param {string}   [options.mood]
 * @param {boolean}  [options.includeTrend]
 * @param {'instant'|'brand-voice'|'reference'} [options.generationMode='instant']
 * @param {object}   [options.occasionContext]
 */
async function generatePostVariants(prompt, platforms, options = {}) {
  const count = Math.min(Number(options.count) || 3, MAX_VARIANTS);
  const organizationId = options.organizationId || null;
  const postType = options.postType || 'post';
  const audience = options.audience || '';
  const intent = options.intent || '';
  const mood = options.mood || '';
  const includeTrend = options.includeTrend;
  // 'instant' mode skips brand context so generation is generic and fast.
  // 'brand-voice' applies full brand writing guidelines.
  // 'reference' uses standard text generation (visual style applied at image stage).
  const generationMode = options.generationMode || 'instant';

  let userPrompt = prompt;
  if (audience) userPrompt += ` Target audience: ${audience}.`;
  if (intent) userPrompt += ` Content intent: ${intent}.`;
  if (mood) userPrompt += ` Writing tone/mood: ${mood}.`;
  if (includeTrend) userPrompt += ' Weave in a relevant current trend or seasonal angle.';

  const brandContext = (organizationId && generationMode === 'brand-voice')
    ? await brandContextService.getBrandContext(organizationId)
    : null;
  const occasionContext = options.occasionContext || null;
  const systemPrompt = buildPostVariantSystemPrompt(platforms, postType, brandContext, occasionContext);

  logger.debug('[Content Studio] AI prompts for post variants', {
    systemPromptLength: systemPrompt.length,
    userPromptLength: userPrompt.length
  });

  const temperatures = VARIANT_TEMPERATURES.slice(0, count);
  const results = await Promise.all(
    temperatures.map((temp, idx) =>
      runWithAiContext(
        {
          organizationId,
          userId: options.userId || null,
          feature: `content_studio.post_variant.${idx}`
        },
        () =>
          generateSinglePostWithTemperature(systemPrompt, userPrompt, temp)
            .then((content) => ({ content: content || '' }))
            .catch(() => ({ content: '' }))
      )
    )
  );
  return { variants: results.filter((v) => v.content) };
}

/**
 * Generate an event/seasonal post by compositing three layers:
 *   1) Brand identity (BrandConfig.brandProfile)
 *   2) Event style (EventTemplate.eventStyle)
 *   3) User intent (the user's message/prompt)
 *
 * @param {object} opts
 * @param {string} opts.organizationId
 * @param {string} opts.eventTemplateId
 * @param {string} opts.prompt        - User's message / greeting / offer
 * @param {string[]} opts.platforms
 * @param {string} [opts.userId]
 * @returns {Promise<{ text: string, imagePrompt: string }>}
 */
async function generateEventPost(opts) {
  const { organizationId, eventTemplateId, prompt, platforms, userId } = opts;
  const EventTemplate = require('../../models/EventTemplate');

  const [brandCtx, visualCtx, template] = await Promise.all([
    brandContextService.getBrandContext(organizationId),
    brandContextService.getVisualStyleContext(organizationId),
    EventTemplate.findById(eventTemplateId).lean()
  ]);

  if (!template) throw new Error('Event template not found');

  const eventStyle = template.eventStyle || {};
  const eventName = template.name || template.eventType;

  const eventLayerParts = [];
  if (eventStyle.dominantColors?.length) eventLayerParts.push(`Event accent colors: ${eventStyle.dominantColors.join(', ')}`);
  if (eventStyle.decorativeElements?.length) eventLayerParts.push(`Decorative elements: ${eventStyle.decorativeElements.join(', ')}`);
  if (eventStyle.mood) eventLayerParts.push(`Event mood: ${eventStyle.mood}`);
  if (eventStyle.typography) eventLayerParts.push(`Event typography: ${eventStyle.typography}`);
  const eventLayer = eventLayerParts.length
    ? `Event style for "${eventName}" (blend with brand, 60% brand / 40% event):\n- ${eventLayerParts.join('\n- ')}`
    : `Event: ${eventName}`;

  const textSystemPrompt = `You are a social media content creator. Write a ${eventName} post for ${platforms.join(', ')}.
${brandCtx ? `\nBrand guidelines:\n${brandCtx}\n` : ''}
${eventLayer}

User message: ${prompt}

Return ONLY the post text (caption + hashtags). Keep the brand voice while incorporating seasonal greetings and event spirit.`;

  const textResponse = await runWithAiContext(
    { organizationId, userId, feature: 'event_post.text' },
    () => openaiClient.chatCompletion({
      model: openaiClient.chatModel,
      messages: [
        { role: 'system', content: textSystemPrompt },
        { role: 'user', content: prompt }
      ],
      ...tempTokenConfig(DEFAULT_TEMPERATURE, EVENT_POST_MAX_TOKENS)
    })
  );
  const generatedText = textResponse.data?.choices?.[0]?.message?.content || '';

  const imagePromptParts = [`Create a social media post image for ${eventName}.`];
  if (visualCtx) imagePromptParts.push(visualCtx);
  imagePromptParts.push(eventLayer);
  imagePromptParts.push(`Content: "${prompt}"`);
  const imagePrompt = imagePromptParts.join('\n');

  return { text: generatedText, imagePrompt };
}

module.exports = {
  generatePost,
  generatePostVariants,
  generateEventPost,
  // Exported so the aiService facade can keep its `_*` shadows pointing at the
  // same implementations (some tests / older callers use them directly).
  _internal: {
    generateSinglePost,
    generateSinglePostWithTemperature,
    buildPostVariantSystemPrompt,
    getPlatformGuidelines,
    tempTokenConfig
  }
};
