const axios = require('axios');
const { getAiRequestContext, runWithAiContext, runWithAiContextAndUsageId } = require('./aiRequestContext');
const aiApiUsageService = require('./aiApiUsageService');
const KnowledgeBase = require('../models/KnowledgeBase');
const BrandConfig = require('../models/BrandConfig');
const BrandReferenceImage = require('../models/BrandReferenceImage');
const aiCreditService = require('./aiCreditService');
const logger = require('../config/logger');
const { escapeRegex } = require('../utils/sanitize');
const { isThreadStyleDm } = require('../utils/interactionThreadDm');

/**
 * OpenAI model ids are lowercase (e.g. gpt-5.3-chat-latest). ChatGPT-style names like "GPT-5.3" 404.
 * Maps common shorthand to the official Chat Completions model id.
 */
function normalizeOpenAIModelId(raw) {
  const fallback = 'gpt-4';
  if (raw == null || String(raw).trim() === '') {
    return fallback;
  }
  const m = String(raw).trim().toLowerCase();
  const aliases = {
    'gpt-5.3': 'gpt-5.3-chat-latest',
    'gpt-5-3': 'gpt-5.3-chat-latest',
    'gpt5.3': 'gpt-5.3-chat-latest'
  };
  return aliases[m] || m;
}

/**
 * Newer OpenAI chat models (e.g. gpt-5.x) reject `max_tokens` and require `max_completion_tokens`.
 */
function openAIChatCompletionMaxTokensField(model, maxValue) {
  const m = (model || '').toLowerCase();
  const useMaxCompletion =
    /^gpt-5/.test(m) || /^o1/.test(m) || /^o3/.test(m) || /^o4/.test(m);
  if (useMaxCompletion) {
    return { max_completion_tokens: maxValue };
  }
  return { max_tokens: maxValue };
}

/** Models that only accept the default sampling temperature (omit param; do not send custom values). */
function openAIChatModelUsesFixedTemperature(model) {
  const m = (model || '').toLowerCase();
  return /^gpt-5/.test(m) || /^o1/.test(m) || /^o3/.test(m) || /^o4/.test(m);
}

function openAIChatCompletionTemperatureField(model, temperature) {
  if (openAIChatModelUsesFixedTemperature(model)) {
    return {};
  }
  return { temperature };
}

/** Plain text from first chat completion choice (handles string or multimodal content parts). */
function completionTextFromOpenAIResponse(data) {
  const ch = data?.choices?.[0];
  if (!ch) return '';
  const msg = ch.message || ch;
  const c = msg?.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    return c
      .map((part) => {
        if (part && part.type === 'text' && typeof part.text === 'string') return part.text;
        if (typeof part === 'string') return part;
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  if (c != null && typeof c === 'object') {
    try {
      return JSON.stringify(c);
    } catch {
      return String(c);
    }
  }
  return c != null ? String(c) : '';
}

class AIService {
  constructor() {
    this.openaiApiKey = process.env.OPENAI_API_KEY;
    this.openaiApiUrl = 'https://api.openai.com/v1/chat/completions';
    this.openaiModel = normalizeOpenAIModelId(process.env.OPENAI_MODEL);
    // Cheaper model for classification-only tasks (sentiment, intent, topics, bucket).
    // Defaults to gpt-4o-mini; override with OPENAI_CLASSIFICATION_MODEL env var.
    this.classificationModel = normalizeOpenAIModelId(
      process.env.OPENAI_CLASSIFICATION_MODEL || 'gpt-4o-mini'
    );
    // Vision-capable model for image analysis tasks. Must support image_url content.
    // gpt-4o supports vision; the primary model (gpt-5.3-chat-latest) does not.
    // Override with OPENAI_VISION_MODEL env var if needed.
    this.visionModel = normalizeOpenAIModelId(
      process.env.OPENAI_VISION_MODEL || 'gpt-4o'
    );

    /** Kept for diagnostics / compatibility — AI stack is OpenAI-only */
    this.provider = 'openai';

    if (process.env.AI_PROVIDER && process.env.AI_PROVIDER.toLowerCase() === 'ollama') {
      logger.warn('AI_PROVIDER=ollama is no longer supported; OpenAI only. Set OPENAI_API_KEY.');
    }

    if (this.openaiApiKey && this.openaiApiKey.trim() !== '') {
      logger.info('AI Service: OpenAI', { model: this.openaiModel });
    } else {
      logger.warn('AI Service: OPENAI_API_KEY is not set — AI features will fail until configured.');
    }

    console.log('🤖 AI Provider: OPENAI');
    console.log(`📝 OpenAI Model: ${this.openaiModel}`);
  }

  _mergeAiLogContext(overrides = {}) {
    const store = getAiRequestContext();
    return {
      organizationId: overrides.organizationId !== undefined ? overrides.organizationId : store.organizationId,
      userId: overrides.userId !== undefined ? overrides.userId : store.userId,
      feature: overrides.feature || store.feature || 'unknown',
      metadata: overrides.metadata || {}
    };
  }

  /**
   * Chat completions POST with token usage persisted to AiApiUsage (non-blocking).
   */
  async _postChatCompletions(requestBody, logOverrides = {}, axiosConfig = {}) {
    const ctx = this._mergeAiLogContext(logOverrides);
    const defaultAxios = {
      headers: {
        Authorization: `Bearer ${this.openaiApiKey}`,
        'Content-Type': 'application/json'
      },
      timeout: 30000
    };
    const response = await axios.post(this.openaiApiUrl, requestBody, { ...defaultAxios, ...axiosConfig });
    const usage = response.data?.usage;
    if (usage) {
      const completionText = completionTextFromOpenAIResponse(response.data);
      aiApiUsageService.recordChatUsage({
        organizationId: ctx.organizationId,
        userId: ctx.userId,
        feature: ctx.feature,
        model: requestBody.model || this.openaiModel,
        promptTokens: usage.prompt_tokens,
        completionTokens: usage.completion_tokens,
        totalTokens: usage.total_tokens,
        promptMessages: requestBody.messages,
        completionText,
        metadata: ctx.metadata
      });
    }
    return response;
  }

  _logImageUsage(model, size, quality) {
    const ctx = this._mergeAiLogContext({});
    aiApiUsageService.recordImageUsage({
      organizationId: ctx.organizationId,
      userId: ctx.userId,
      feature: ctx.feature || 'image.generation',
      model,
      size,
      quality,
      metadata: {}
    });
  }

  _logVideoUsage(model, durationSeconds) {
    const ctx = this._mergeAiLogContext({});
    aiApiUsageService.recordVideoUsage({
      organizationId: ctx.organizationId,
      userId: ctx.userId,
      feature: ctx.feature || 'video.generation',
      model,
      durationSeconds,
      metadata: {}
    });
  }

  /**
   * Base filter for KB entries used in replies (DMs use the same path as comments).
   */
  _knowledgeBaseReplyFilter(organizationId) {
    return {
      organization: organizationId,
      isActive: true,
      isTrainingData: { $ne: false }
    };
  }

  /**
   * Search relevant knowledge base entries for a given query
   * (Short DMs like "hi" used to match nothing — keyword len>3 and no fallback — so we add broader matching + top-FAQ fallback.)
   */
  async searchKnowledgeBase(organizationId, query, limit = 5) {
    try {
      const base = this._knowledgeBaseReplyFilter(organizationId);
      const trimmed = (query && String(query).trim()) || '';

      const topPriorityFallback = async () => {
        return KnowledgeBase.find(base)
          .select('title content category priority keywords trainingWeight')
          .sort({ priority: -1, trainingWeight: -1, usageCount: -1 })
          .limit(limit);
      };

      if (!trimmed) {
        const entries = await topPriorityFallback();
        return { entries, fromFallback: true };
      }

      // MongoDB text search (needs text index on title/content/keywords)
      let results = [];
      try {
        results = await KnowledgeBase.find({
          ...base,
          $text: { $search: trimmed }
        })
          .select('title content category priority keywords trainingWeight')
          .sort({ score: { $meta: 'textScore' }, priority: -1 })
          .limit(limit);
      } catch (textErr) {
        logger.warn('Knowledge base text search skipped', { message: textErr.message });
      }

      if (results.length > 0) {
        return { entries: results, fromFallback: false };
      }

      // Keyword / title match: include 2+ char tokens so short DMs ("hi", "ok", "hii") can still match keywords
      const queryWords = trimmed
        .toLowerCase()
        .split(/\s+/)
        .map((w) => w.replace(/[^\w]/g, ''))
        .filter((w) => w.length >= 2)
        .slice(0, 12);

      if (queryWords.length > 0) {
        const escapedForRegex = queryWords.map((w) => escapeRegex(w));
        const keywordResults = await KnowledgeBase.find({
          ...base,
          $or: [
            { keywords: { $in: queryWords } },
            { title: { $regex: escapedForRegex.join('|'), $options: 'i' } }
          ]
        })
          .select('title content category priority keywords trainingWeight')
          .sort({ priority: -1, usageCount: -1 })
          .limit(limit);

        if (keywordResults.length > 0) {
          return { entries: keywordResults, fromFallback: false };
        }
      }

      // Still nothing: inject highest-priority training articles so DMs/comments still get brand context
      const fallbackEntries = await topPriorityFallback();
      return { entries: fallbackEntries, fromFallback: true };
    } catch (error) {
      console.error('Knowledge base search error:', error.message);
      return { entries: [], fromFallback: false };
    }
  }

  /**
   * Generate social media post content from a prompt
   * @param {String} prompt - User's description of what they want to post
   * @param {Array} platforms - Array of platform names ['instagram', 'facebook', 'linkedin']
   * @param {String} mode - 'same' for same post across all, 'custom' for different per platform
   * @param {String} postType - 'post', 'story', 'reel', 'short'
   * @param {String} [organizationId] - Optional org ID for brand context (tone, banned words, hashtags)
   * @returns {Promise<Object>} Generated post(s) and credits used
   */
  async generatePost(prompt, platforms, mode = 'same', postType = 'post', organizationId = null) {
    try {
      console.log(`✍️ [AI] Generating ${mode} post for platforms:`, platforms);
      console.log(`📝 [AI] Prompt: "${prompt}"`);
      console.log(`📋 [AI] Post type: ${postType}`);

      const brandContext = organizationId ? await this._getBrandContext(organizationId) : null;

      if (mode === 'same') {
        // Generate ONE post for all platforms
        const post = await this._generateSinglePost(prompt, platforms, postType, brandContext);
        return {
          mode: 'same',
          posts: { all: post },
          creditsUsed: 1
        };
      } else {
        // Generate CUSTOM post for EACH platform
        const posts = {};
        for (const platform of platforms) {
          posts[platform] = await this._generateSinglePost(prompt, [platform], postType, brandContext);
        }
        return {
          mode: 'custom',
          posts: posts,
          creditsUsed: platforms.length
        };
      }
    } catch (error) {
      console.error('Generate post error:', error.message);
      throw error;
    }
  }

  /**
   * Get brand context string for prompt injection (tone, banned words, approved hashtags)
   * @private
   */
  async _getBrandContext(organizationId) {
    if (!organizationId) return null;
    try {
      const config = await BrandConfig.findOne({ organization: organizationId }).lean();
      if (!config) return null;
      const parts = [];
      parts.push(`Brand tone: ${config.toneOfVoice || 'professional'}.`);
      if (config.personalityTags && config.personalityTags.length > 0) {
        parts.push(`Brand personality: ${config.personalityTags.join(', ')}.`);
      }
      if (config.bannedWords && config.bannedWords.length > 0) {
        parts.push(`Never use these words: ${config.bannedWords.join(', ')}.`);
      }
      if (config.approvedHashtags && config.approvedHashtags.length > 0) {
        parts.push(`Prefer these hashtags when relevant: ${config.approvedHashtags.join(', ')}.`);
      }
      if (config.legalDisclaimers && config.legalDisclaimers.trim()) {
        parts.push(`Include this disclaimer when relevant: ${config.legalDisclaimers.trim()}`);
      }

      const bp = config.brandProfile;
      const ov = config.brandProfileOverrides || {};
      if (bp && bp.analyzedAt) {
        const ws = ov.writingStyle || bp.writingStyle;
        if (ws) parts.push(`Writing style: ${ws}.`);
        const eu = ov.emojiUsage || bp.emojiUsage;
        if (eu && eu !== 'moderate') parts.push(`Emoji usage: ${eu}.`);
        const re = ov.recurringEmojis || bp.recurringEmojis;
        if (re && re.length) parts.push(`Frequently uses emojis: ${re.join(', ')}.`);
        const pd = ov.personalityDescriptors || bp.personalityDescriptors;
        if (pd && pd.length) parts.push(`Brand character: ${pd.join(', ')}.`);
        const hs = ov.hashtagStrategy || bp.hashtagStrategy;
        if (hs && hs.avgCount) {
          let hsText = `Hashtag strategy: ~${hs.avgCount} per post`;
          if (hs.branded?.length) hsText += `, branded: ${hs.branded.join(' ')}`;
          if (hs.generic?.length) hsText += `, mix generic: ${hs.generic.slice(0, 5).join(' ')}`;
          parts.push(hsText + '.');
        }
        const cta = ov.ctaStyle || bp.ctaStyle;
        if (cta && cta.length) parts.push(`CTA style: ${cta.join(', ')}.`);
        const im = ov.imageMood || bp.imageMood;
        if (im) parts.push(`Visual mood: ${im}.`);
        const cp = ov.colorPalette || bp.colorPalette;
        if (cp && cp.length) parts.push(`Color palette: ${cp.join(', ')}.`);
      }

      return parts.length ? parts.join(' ') : null;
    } catch (err) {
      logger.warn('Brand context fetch failed', { organizationId, err: err.message });
      return null;
    }
  }

  /**
   * Build a visual style instruction block for image generation prompts.
   * Combines BrandConfig.brandProfile visual fields with aggregated reference image analysis.
   * @param {string} organizationId
   * @returns {Promise<string|null>}
   */
  async _getVisualStyleContext(organizationId) {
    if (!organizationId) return null;
    try {
      const [config, refImages] = await Promise.all([
        BrandConfig.findOne({ organization: organizationId }).select('brandProfile brandProfileOverrides').lean(),
        BrandReferenceImage.find({ organization: organizationId, analysis: { $ne: null } }).limit(20).lean()
      ]);

      const bp = config?.brandProfile;
      const ov = config?.brandProfileOverrides || {};
      const parts = [];

      const palette = ov.colorPalette || bp?.colorPalette;
      if (palette?.length) parts.push(`Color palette: ${palette.join(', ')}`);

      const comp = ov.visualComposition || bp?.visualComposition;
      if (comp) parts.push(`Composition: ${comp}`);

      const typo = ov.typographyStyle || bp?.typographyStyle;
      if (typo) parts.push(`Typography: ${typo}`);

      const mood = ov.imageMood || bp?.imageMood;
      if (mood) parts.push(`Mood: ${mood}`);

      const logo = ov.logoPlacement || bp?.logoPlacement;
      if (logo && logo !== 'none detected') parts.push(`Logo: ${logo}`);

      if (refImages.length) {
        const colorFreq = {};
        const compFreq = {};
        const moodFreq = {};
        for (const ri of refImages) {
          const a = ri.analysis;
          (a.dominantColors || []).forEach(c => { colorFreq[c] = (colorFreq[c] || 0) + 1; });
          if (a.compositionType) compFreq[a.compositionType] = (compFreq[a.compositionType] || 0) + 1;
          if (a.mood) moodFreq[a.mood] = (moodFreq[a.mood] || 0) + 1;
        }
        if (!palette?.length) {
          const topColors = Object.entries(colorFreq).sort((a, b) => b[1] - a[1]).slice(0, 5).map(e => e[0]);
          if (topColors.length) parts.push(`Reference colors: ${topColors.join(', ')}`);
        }
        const topComp = Object.entries(compFreq).sort((a, b) => b[1] - a[1])[0]?.[0];
        if (topComp && !comp) parts.push(`Reference composition: ${topComp}`);
        const topMood = Object.entries(moodFreq).sort((a, b) => b[1] - a[1])[0]?.[0];
        if (topMood && !mood) parts.push(`Reference mood: ${topMood}`);
      }

      if (!parts.length) return null;
      return `Visual style requirements (follow strictly):\n- ${parts.join('\n- ')}`;
    } catch (err) {
      logger.warn('Visual style context fetch failed', { organizationId, err: err.message });
      return null;
    }
  }

  /**
   * Generate a single post optimized for specific platform(s)
   * @private
   */
  async _generateSinglePost(prompt, platforms, postType, brandContext = null) {
    const platformNames = platforms.join(', ');
    const platformGuidelines = this._getPlatformGuidelines(platforms, postType);
    const brandSection = brandContext ? `\nBrand guidelines (follow strictly):\n${brandContext}\n` : '';

    const systemPrompt = `You are a professional social media content creator. Generate engaging ${postType} content for ${platformNames}.
${platformGuidelines ? `\n${platformGuidelines}` : ''}${brandSection}
Rules: Be authentic; use emojis sparingly; match platform hashtag norms; professional yet conversational tone.
Generate ONLY the post content. No explanations or meta-commentary.`;

    if (!this.openaiApiKey || this.openaiApiKey.trim() === '') {
      throw new Error('OpenAI API key is not configured');
    }
    const response = await this._postChatCompletions(
      {
        model: this.openaiModel,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: prompt }
        ],
        ...openAIChatCompletionTemperatureField(this.openaiModel, 0.8),
        ...openAIChatCompletionMaxTokensField(this.openaiModel, 500)
      },
      {}
    );

    return response.data.choices[0].message.content.trim();
  }

  /**
   * Generate N text variants for Content Studio (e.g. 3 options to choose from).
   */
  async generatePostVariants(prompt, platforms, options = {}) {
    const count = Math.min(Number(options.count) || 3, 5);
    const organizationId = options.organizationId || null;
    const postType = options.postType || 'post';
    const audience = options.audience || '';
    const intent = options.intent || '';
    const mood = options.mood || '';
    const includeTrend = options.includeTrend;
    let userPrompt = prompt;
    if (audience) userPrompt += ` Target audience: ${audience}.`;
    if (intent) userPrompt += ` Content intent: ${intent}.`;
    if (mood) userPrompt += ` Writing tone/mood: ${mood}.`;
    if (includeTrend) userPrompt += ' Weave in a relevant current trend or seasonal angle.';

    const brandContext = organizationId ? await this._getBrandContext(organizationId) : null;
    const systemPrompt = this._buildPostVariantSystemPrompt(platforms, postType, brandContext);
    console.log('[Content Studio] AI system prompt for post variants:\n', systemPrompt);
    console.log('[Content Studio] AI user prompt for post variants:\n', userPrompt);

    const temperatures = [0.7, 0.85, 0.95].slice(0, count);
    const results = await Promise.all(
      temperatures.map((temp, idx) =>
        runWithAiContext(
          {
            organizationId,
            userId: options.userId || null,
            feature: `content_studio.post_variant.${idx}`
          },
          () =>
            this._generateSinglePostWithTemperature(systemPrompt, userPrompt, temp)
              .then((content) => ({ content: content || '' }))
              .catch(() => ({ content: '' }))
        )
      )
    );
    return { variants: results.filter(v => v.content) };
  }

  _buildPostVariantSystemPrompt(platforms, postType, brandContext) {
    const platformNames = platforms.join(', ');
    const platformGuidelines = this._getPlatformGuidelines(platforms, postType);
    const brandSection = brandContext ? `\nBrand guidelines (follow strictly):\n${brandContext}\n` : '';
    return `You are a professional social media content creator. Generate a SINGLE engaging ${postType} that works across ${platformNames}.
${platformGuidelines ? `\n${platformGuidelines}` : ''}${brandSection}
CRITICAL RULES: Output ONE post only — no platform labels. Emojis sparingly; 3-5 hashtags at end.
Generate ONLY the post text. No explanations, headers, or meta-commentary.`;
  }

  async _generateSinglePostWithTemperature(systemPrompt, userPrompt, temperature = 0.8) {
    if (!this.openaiApiKey || this.openaiApiKey.trim() === '') {
      throw new Error('OpenAI API key is not configured');
    }
    const response = await this._postChatCompletions(
      {
        model: this.openaiModel,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        ...openAIChatCompletionTemperatureField(
          this.openaiModel,
          Math.min(1, Math.max(0, temperature))
        ),
        ...openAIChatCompletionMaxTokensField(this.openaiModel, 500)
      },
      {}
    );
    return response.data.choices[0].message.content.trim();
  }

  /**
   * Get platform-specific guidelines for post generation
   * @private
   */
  _getPlatformGuidelines(platforms, postType) {
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

  /**
   * Generate an event/seasonal post by compositing three layers:
   *  1) Brand identity (from BrandConfig.brandProfile)
   *  2) Event style (from EventTemplate.eventStyle)
   *  3) User intent (the user's message/prompt)
   *
   * @param {object} opts
   * @param {string} opts.organizationId
   * @param {string} opts.eventTemplateId
   * @param {string} opts.prompt - The user's message / greeting / offer text
   * @param {string[]} opts.platforms
   * @param {string} [opts.userId]
   * @returns {Promise<{ text: string, imagePrompt: string }>}
   */
  async generateEventPost(opts) {
    const { organizationId, eventTemplateId, prompt, platforms, userId } = opts;
    const EventTemplate = require('../models/EventTemplate');

    const [brandCtx, visualCtx, template] = await Promise.all([
      this._getBrandContext(organizationId),
      this._getVisualStyleContext(organizationId),
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
      () => this._postChatCompletions({
        model: this.openaiModel,
        messages: [
          { role: 'system', content: textSystemPrompt },
          { role: 'user', content: prompt }
        ],
        ...this._tempTokenConfig(0.8, 600)
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

  _tempTokenConfig(temp, max) {
    const model = (this.openaiModel || '').toLowerCase();
    const tokenField = /^gpt-5|^o[134]/.test(model)
      ? { max_completion_tokens: max }
      : { max_tokens: max };
    return { temperature: temp, ...tokenField };
  }

  /**
   * Whether an image API error is worth retrying (timeouts, drops, rate limits).
   * @private
   */
  _isTransientImageGenError(error) {
    const status = error.response?.status;
    if (status === 429 || status === 502 || status === 503 || status === 504) return true;
    const code = error.code;
    if (code && ['ECONNRESET', 'ECONNABORTED', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND'].includes(code)) return true;
    const msg = String(error.message || '').toLowerCase();
    if (
      msg.includes('aborted') ||
      msg.includes('timeout') ||
      msg.includes('socket') ||
      msg.includes('hang up') ||
      msg.includes('econnreset') ||
      msg.includes('network')
    ) {
      return true;
    }
    return false;
  }

  /**
   * Generate an image via OpenAI Image API using gpt-image-1.5.
   * Retries transient failures (aborted connections, timeouts, 429/502/503).
   * @param {string} prompt - Description of the image to generate
   * @param {string} [organizationId] - If provided, visual style context is injected
   * @returns {Promise<Buffer|null>} Image buffer or null on error
   */
  async generateImage(prompt, organizationId = null) {
    if (!this.openaiApiKey || this.openaiApiKey.trim() === '') {
      return null;
    }

    let basePrompt = typeof prompt === 'string' && prompt.length > 0
      ? prompt
      : 'Professional social media post image, modern, high quality';

    if (organizationId) {
      const visualCtx = await this._getVisualStyleContext(organizationId);
      if (visualCtx) {
        basePrompt = `${visualCtx}\n\n${basePrompt}`;
      }
    }
    const imagePrompt = basePrompt.substring(0, 1500);

    const model = process.env.OPENAI_IMAGE_MODEL || 'gpt-image-1.5';
    const maxAttempts = Math.min(Math.max(parseInt(process.env.OPENAI_IMAGE_MAX_RETRIES, 10) || 3, 1), 5);
    const imageTimeout = Math.min(Math.max(parseInt(process.env.OPENAI_IMAGE_TIMEOUT_MS, 10) || 120000, 60000), 300000);

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const response = await axios.post(
          'https://api.openai.com/v1/images/generations',
          {
            model,
            prompt: imagePrompt,
            n: 1,
            size: '1024x1024',
            quality: 'medium'
          },
          {
            headers: {
              Authorization: `Bearer ${this.openaiApiKey}`,
              'Content-Type': 'application/json'
            },
            timeout: imageTimeout,
            maxContentLength: Infinity,
            maxBodyLength: Infinity
          }
        );

        const b64 = response.data?.data?.[0]?.b64_json;
        if (b64) {
          this._logImageUsage(model, '1024x1024', 'medium');
          return Buffer.from(b64, 'base64');
        }

        const imageUrl = response.data?.data?.[0]?.url;
        if (!imageUrl) return null;

        const imgResponse = await axios.get(imageUrl, {
          responseType: 'arraybuffer',
          timeout: 60000,
          maxContentLength: Infinity
        });
        this._logImageUsage(model, '1024x1024', 'medium');
        return Buffer.from(imgResponse.data);
      } catch (error) {
        const status = error.response?.status;
        const data = error.response?.data;
        const transient = this._isTransientImageGenError(error);
        const willRetry = transient && attempt < maxAttempts;

        logger.warn('AI image generation failed', {
          attempt,
          maxAttempts,
          error: error.message,
          code: error.code,
          status,
          openaiError: data?.error?.message || data?.message,
          willRetry
        });

        if (willRetry) {
          const delayMs = Math.min(2000 * 2 ** (attempt - 1), 16000);
          await new Promise((r) => setTimeout(r, delayMs));
          continue;
        }
        return null;
      }
    }
    return null;
  }

  /**
   * Generate a short video/reel using OpenAI Sora (v1/videos API).
   * Submits the job, polls for completion, downloads via /content endpoint, returns a Buffer.
   *
   * Correct endpoints (as of 2026):
   *   Submit : POST  https://api.openai.com/v1/videos
   *   Poll   : GET   https://api.openai.com/v1/videos/{id}
   *   Download: GET  https://api.openai.com/v1/videos/{id}/content
   *
   * @param {string} prompt   - Cinematic direction prompt
   * @param {object} options
   * @param {number} [options.duration=4]    - Clip length in seconds; Sora accepts 4 | 8 | 12
   * @param {string} [options.aspect='9:16'] - '16:9' | '9:16'
   * @returns {Promise<Buffer|null>}
   */
  async generateVideo(prompt, { duration = 4, aspect = '9:16' } = {}) {
    if (!this.openaiApiKey || this.openaiApiKey.trim() === '') {
      logger.warn('[Video] OPENAI_API_KEY not set — video generation skipped.');
      return null;
    }

    const model = process.env.OPENAI_VIDEO_MODEL || 'sora-2';
    const timeoutMs = Math.min(
      Math.max(parseInt(process.env.OPENAI_VIDEO_TIMEOUT_MS, 10) || 300000, 60000),
      600000
    );

    // Sora valid sizes: 720x1280 (9:16), 1280x720 (16:9), 1024x1792 (tall), 1792x1024 (wide)
    const sizeMap = { '16:9': '1280x720', '9:16': '720x1280' };
    const size = sizeMap[aspect] || '720x1280';

    // Sora valid seconds values are strings: "4" | "8" | "12"
    const validSeconds = [4, 8, 12];
    const nearest = validSeconds.reduce((prev, cur) =>
      Math.abs(cur - duration) < Math.abs(prev - duration) ? cur : prev
    );
    const seconds = String(nearest);

    const videoPrompt = typeof prompt === 'string' && prompt.length > 0
      ? prompt.substring(0, 2000)
      : 'A professional social media short video, modern, high quality, no text.';

    const headers = {
      Authorization: `Bearer ${this.openaiApiKey}`,
      'Content-Type': 'application/json'
    };

    // ── Step 1: Submit the video generation job ──────────────────────────────
    let jobId;
    try {
      const submitRes = await axios.post(
        'https://api.openai.com/v1/videos',
        { model, prompt: videoPrompt, size, seconds },
        { headers, timeout: 30000 }
      );
      jobId = submitRes.data?.id;
      if (!jobId) {
        logger.warn('[Video] Sora did not return a job id', { data: submitRes.data });
        return null;
      }
      logger.info('[Video] Sora job submitted', { jobId, model, size, seconds });
    } catch (err) {
      logger.warn('[Video] Sora submit failed', {
        error: err.message,
        status: err.response?.status,
        openaiError: err.response?.data?.error?.message
      });
      throw err;
    }

    // ── Step 2: Poll for completion ──────────────────────────────────────────
    const pollInterval = 5000;
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, pollInterval));

      let statusRes;
      try {
        statusRes = await axios.get(
          `https://api.openai.com/v1/videos/${jobId}`,
          { headers, timeout: 15000 }
        );
      } catch (pollErr) {
        logger.warn('[Video] Sora poll request failed (will retry)', {
          jobId, error: pollErr.message
        });
        continue;
      }

      const status = statusRes.data?.status;
      logger.info('[Video] Sora job status', { jobId, status, progress: statusRes.data?.progress });

      if (status === 'completed') {
        // ── Step 3: Download via /content endpoint ────────────────────────────
        try {
          const dlRes = await axios.get(
            `https://api.openai.com/v1/videos/${jobId}/content`,
            {
              headers: { Authorization: `Bearer ${this.openaiApiKey}` },
              responseType: 'arraybuffer',
              timeout: 120000,
              maxContentLength: Infinity,
              maxBodyLength: Infinity
            }
          );
          this._logVideoUsage(model, parseInt(seconds, 10) || 4);
          return Buffer.from(dlRes.data);
        } catch (dlErr) {
          logger.warn('[Video] MP4 download failed', { jobId, error: dlErr.message });
          return null;
        }
      }

      if (status === 'failed') {
        const reason = statusRes.data?.error?.message || 'Video generation failed';
        logger.warn('[Video] Sora job failed', { jobId, reason });
        const err = new Error(reason);
        err.soraFailed = true;
        err.soraStatus = status;
        throw err;
      }

      // statuses 'queued' | 'in_progress' — keep polling
    }

    logger.warn('[Video] Sora job timed out', { jobId, timeoutMs });
    return null;
  }

  /**
   * Analyze sentiment of text using OpenAI
   */
  async analyzeSentiment(content) {
    try {
      console.log(`🔍 [AI] Analyzing sentiment for: "${content.substring(0, 50)}..."`);

      try {
        const response = await this._postChatCompletions(
          {
            model: this.classificationModel,
            messages: [
              {
                role: 'system',
                content: `You are an expert sentiment analysis AI. Analyze customer interactions.

Respond with ONLY this JSON structure (no other text):
{
  "sentiment": "positive" or "negative" or "neutral",
  "score": number between -1 and 1,
  "confidence": number between 0 and 1
}

Rules:
- positive: Praise, gratitude, satisfaction, enthusiasm
- negative: Complaints, anger, disappointment, frustration
- neutral: Questions, information requests, factual statements

Scoring: very positive 0.7-1.0, neutral -0.3 to 0.3, very negative -1.0 to -0.7`
              },
              {
                role: 'user',
                content: `Analyze: "${content}"`
              }
            ],
            ...openAIChatCompletionTemperatureField(this.classificationModel, 0.2),
            ...openAIChatCompletionMaxTokensField(this.classificationModel, 80)
          },
          {}
        );

        const responseContent = response.data.choices[0].message.content.trim();

        let result;
        try {
          const jsonMatch = responseContent.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            result = JSON.parse(jsonMatch[0]);
          } else {
            throw new Error('No JSON found in OpenAI response');
          }
        } catch (parseError) {
          console.warn('⚠️  [AI] Failed to parse OpenAI JSON, using text parsing');
          const sentiment = responseContent.toLowerCase().includes('positive') ? 'positive' :
            responseContent.toLowerCase().includes('negative') ? 'negative' : 'neutral';
          result = {
            sentiment,
            score: sentiment === 'positive' ? 0.7 : sentiment === 'negative' ? -0.7 : 0,
            confidence: 0.75,
            reasoning: 'Fallback text parsing'
          };
        }

        console.log(`✅ [AI] Sentiment: ${result.sentiment} (score: ${result.score}, confidence: ${result.confidence})`);

        return {
          sentiment: result.sentiment,
          sentimentScore: result.score,
          sentimentConfidence: result.confidence,
          sentimentReasoning: result.reasoning
        };
      } catch (apiError) {
        if (apiError.response) {
          console.error('❌ [AI] OpenAI API Error:', {
            status: apiError.response.status,
            statusText: apiError.response.statusText,
            data: apiError.response.data,
            model: this.openaiModel
          });
        } else {
          console.error('❌ [AI] OpenAI Request Error:', apiError.message);
        }
        throw apiError;
      }
    } catch (error) {
      console.error('❌ [AI] Sentiment analysis error:', error.message);

      // Fallback to basic keyword analysis
      return this.fallbackSentimentAnalysis(content);
    }
  }

  /**
   * Fallback sentiment analysis using keywords (when AI fails)
   */
  fallbackSentimentAnalysis(content) {
    const text = content.toLowerCase();

    // Enhanced keyword lists with weights
    const positiveWords = {
      'love': 2, 'amazing': 2, 'awesome': 2, 'excellent': 2, 'perfect': 2,
      'great': 1.5, 'good': 1.5, 'wonderful': 2, 'fantastic': 2, 'best': 2,
      'nice': 1, 'thanks': 1.5, 'thank you': 2, 'appreciate': 1.5, 'helpful': 1.5,
      '😍': 2, '❤️': 2, '🥰': 2, '😊': 1.5, '👍': 1.5, '🙏': 1.5, '⭐': 1
    };

    const negativeWords = {
      // Negative words
      'hate': 2, 'terrible': 2, 'awful': 2, 'worst': 2, 'horrible': 2,
      'bad': 1.5, 'poor': 1.5, 'disappointed': 2, 'disappointing': 2,
      'useless': 2, 'waste': 1.5, 'scam': 2, 'fraud': 2, 'pathetic': 2, 
      'disgusting': 2, 'angry': 1.5, 'furious': 2, 'annoying': 1.5, 'annoyed': 1.5,
      'upset': 1.5, 'sad': 1.5, 'unhappy': 1.5, 'dislike': 1.5, 'sucks': 2,
      'stupid': 2, 'dumb': 1.5, 'ridiculous': 1.5, 'joke': 1, 'broken': 1.5,
      'fail': 1.5, 'failed': 1.5, 'failure': 2, 'problem': 1, 'issue': 1,
      'bug': 1, 'error': 1, 'wrong': 1, 'not working': 1.5, 'doesn\'t work': 1.5,
      // Negative emojis
      '😡': 2, '😠': 2, '👎': 2, '😤': 1.5, '💔': 2, '😢': 1.5, '😭': 2,
      '😞': 1.5, '😔': 1.5, '😟': 1.5, '😕': 1, '🙁': 1.5, '☹️': 1.5,
      '😩': 1.5, '😫': 1.5, '😖': 1.5, '💀': 1, '🤬': 2, '🖕': 2
    };

    let positiveScore = 0;
    let negativeScore = 0;

    // Count weighted keywords
    Object.entries(positiveWords).forEach(([word, weight]) => {
      if (text.includes(word)) positiveScore += weight;
    });

    Object.entries(negativeWords).forEach(([word, weight]) => {
      if (text.includes(word)) negativeScore += weight;
    });

    // Calculate sentiment
    let sentiment = 'neutral';
    let score = 0;

    if (positiveScore > negativeScore && positiveScore > 0) {
      sentiment = 'positive';
      score = Math.min(0.8, 0.4 + (positiveScore * 0.1));
    } else if (negativeScore > positiveScore && negativeScore > 0) {
      sentiment = 'negative';
      score = Math.max(-0.8, -0.4 - (negativeScore * 0.1));
    }

    return {
      sentiment,
      sentimentScore: score,
      sentimentConfidence: 0.6, // Lower confidence for keyword-based
      sentimentReasoning: 'Fallback keyword analysis (AI unavailable)'
    };
  }

  /**
   * Generate AI response using OpenAI
   * @param {Object} interaction
   * @param {string|null} organizationId
   * @param {Array|null} knowledgeBase
   * @param {Object} [options]
   * @param {boolean} [options.withSelfAssessment=false] - When true the LLM is asked to assess
   *   whether it can resolve the query before replying. Returns an additional `resolvable` flag
   *   and `resolvableReason`. Used by generateAutoReply to implement Layer 2 proactive routing.
   */
  async generateResponseOpenAI(interaction, organizationId = null, knowledgeBase = null, options = {}) {
    const withSelfAssessment = options.withSelfAssessment === true;
    let knowledgeBaseFallback = false;
    try {
      // Check if API key is configured
      if (!this.openaiApiKey || this.openaiApiKey.trim() === '') {
        console.error('OpenAI API key is not configured. Please set OPENAI_API_KEY environment variable.');
        throw new Error('OpenAI API key is not configured. Please contact your administrator.');
      }

      // If knowledgeBase not provided, search for relevant entries (same for DMs, comments, reviews)
      let relevantKB = knowledgeBase;
      if (!relevantKB && organizationId) {
        const { entries, fromFallback } = await this.searchKnowledgeBase(
          organizationId,
          interaction.content,
          5
        );
        relevantKB = entries;
        knowledgeBaseFallback = fromFallback;

        // Count real matches only — avoid inflating usage when we inject top-priority fallback context
        if (!fromFallback && relevantKB && relevantKB.length > 0) {
          for (const kb of relevantKB) {
            try {
              if (typeof kb.usageCount !== 'number' || isNaN(kb.usageCount)) {
                kb.usageCount = 0;
              }
              await kb.incrementUsage();
            } catch (usageError) {
              console.error('Error incrementing KB usage:', usageError);
            }
          }
        }
      }

      // Build context from knowledge base — cap each entry to avoid bloating the prompt
      const MAX_KB_ENTRY_CHARS = 600;
      const kbContext = relevantKB && relevantKB.length > 0
        ? relevantKB.map(kb => {
            const body = (kb.content || '').substring(0, MAX_KB_ENTRY_CHARS);
            const truncated = (kb.content || '').length > MAX_KB_ENTRY_CHARS ? '…' : '';
            return `${kb.title}: ${body}${truncated}`;
          }).join('\n\n')
        : '';

      // Load per-bucket reply config if interaction is classified
      const IntentBucket = require('../models/IntentBucket');
      let bucketContext = '';
      if (interaction.intentBucket) {
        try {
          const bucketConfig = await IntentBucket.findById(interaction.intentBucket)
            .select('replyTone replyLanguage replyPrompt name')
            .lean();
          if (bucketConfig) {
            let tone = bucketConfig.replyTone;
            if (!tone && organizationId) {
              const bc = await BrandConfig.findOne({ organization: organizationId }).select('toneOfVoice').lean();
              tone = bc?.toneOfVoice || 'professional';
            }
            bucketContext += `\nREPLY CONTEXT (Bucket: "${bucketConfig.name}"):`;
            if (tone) bucketContext += `\n- Tone: ${tone}`;
            if (bucketConfig.replyLanguage && bucketConfig.replyLanguage !== 'auto') {
              bucketContext += `\n- Reply Language: ${bucketConfig.replyLanguage}`;
            }
            if (bucketConfig.replyPrompt) {
              bucketContext += `\n- Special Instructions: ${bucketConfig.replyPrompt}`;
            }
          }
        } catch (bucketErr) {
          console.error('Error loading bucket config for reply:', bucketErr.message);
        }
      }

      const baseGuidelines = `IMPORTANT GUIDELINES:
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

      // Layer 2: self-assessment mode — LLM reports whether it can resolve the query
      if (withSelfAssessment) {
        const selfAssessSystemPrompt = `You are a professional customer service AI. Before composing a reply, assess whether you can fully resolve this query WITHOUT needing access to:
- Private account data (order history, transaction records, account details)
- Real-time system data (live inventory, delivery tracking, live status)
- Internal tools, back-office systems, or human judgment

${baseGuidelines}

Respond ONLY with this exact JSON (no other text, no markdown fences):
{
  "resolvable": true or false,
  "reason": "if false: one-sentence explanation of why you cannot resolve it without private data",
  "confidence": 0.0 to 1.0,
  "reply": "your complete customer-facing response"
}`;

        const selfAssessResponse = await this._postChatCompletions(
          {
            model: this.openaiModel,
            messages: [
              { role: 'system', content: selfAssessSystemPrompt },
              {
                role: 'user',
                content: `Customer message: "${interaction.content}"\n\nPlatform: ${interaction.platform}\nType: ${interaction.type}\nSentiment: ${interaction.sentiment || 'unknown'}`
              }
            ],
            ...openAIChatCompletionTemperatureField(this.openaiModel, 0.7),
            ...openAIChatCompletionMaxTokensField(this.openaiModel, 400)
          },
          {},
          { timeout: 120000 }
        );

        const rawSelfAssess = selfAssessResponse.data.choices[0].message.content.trim();
        let parsed = null;
        try {
          const jsonMatch = rawSelfAssess.match(/\{[\s\S]*\}/);
          parsed = JSON.parse(jsonMatch ? jsonMatch[0] : rawSelfAssess);
        } catch {
          // JSON parse failed — treat as resolvable, use raw text as reply
          logger.warn('[AI] Self-assessment JSON parse failed, falling back to raw reply', {
            interactionId: interaction._id?.toString()
          });
        }

        if (parsed && typeof parsed.reply === 'string' && parsed.reply.trim()) {
          const resolvable = parsed.resolvable !== false; // default to true if field missing
          const confidence = typeof parsed.confidence === 'number'
            ? Math.max(0, Math.min(1, parsed.confidence))
            : (relevantKB && relevantKB.length > 0 ? Math.min(0.95, 0.78 + relevantKB.length * 0.04) : 0.78);

          return {
            content: parsed.reply.trim(),
            confidence,
            resolvable,
            resolvableReason: resolvable ? null : (parsed.reason || 'Requires access to private account or system data'),
            generatedAt: new Date(),
            usedKnowledgeBase: relevantKB && relevantKB.length > 0,
            knowledgeBaseCount: relevantKB ? relevantKB.length : 0,
            knowledgeBaseFallback
          };
        }

        // Fallback: parse failed or malformed — treat raw text as resolvable reply
        const fallbackConfidence = relevantKB && relevantKB.length > 0
          ? Math.min(0.95, 0.78 + relevantKB.length * 0.04)
          : 0.78;
        return {
          content: rawSelfAssess,
          confidence: fallbackConfidence,
          resolvable: true,
          resolvableReason: null,
          generatedAt: new Date(),
          usedKnowledgeBase: relevantKB && relevantKB.length > 0,
          knowledgeBaseCount: relevantKB ? relevantKB.length : 0,
          knowledgeBaseFallback
        };
      }

      // Standard mode (no self-assessment)
      const systemPrompt = `You are a professional customer service representative. 
Your task is to generate a helpful, friendly, and professional response to customer inquiries.

${baseGuidelines}

Generate a response that addresses the customer's message appropriately.`;

      const response = await this._postChatCompletions(
        {
          model: this.openaiModel,
          messages: [
            {
              role: 'system',
              content: systemPrompt
            },
            {
              role: 'user',
              content: `Customer message: "${interaction.content}"\n\nPlatform: ${interaction.platform}\nType: ${interaction.type}\nSentiment: ${interaction.sentiment || 'unknown'}`
            }
          ],
          ...openAIChatCompletionTemperatureField(this.openaiModel, 0.7),
          ...openAIChatCompletionMaxTokensField(this.openaiModel, 200)
        },
        {},
        { timeout: 120000 }
      );

      const generatedResponse = response.data.choices[0].message.content.trim();

      // Calculate confidence based on KB matches
      let confidence = 0.78; // Default confidence
      if (relevantKB && relevantKB.length > 0) {
        confidence = Math.min(0.95, 0.78 + (relevantKB.length * 0.04));
      }

      return {
        content: generatedResponse,
        confidence: confidence,
        resolvable: true,
        resolvableReason: null,
        generatedAt: new Date(),
        usedKnowledgeBase: relevantKB && relevantKB.length > 0,
        knowledgeBaseCount: relevantKB ? relevantKB.length : 0,
        knowledgeBaseFallback: knowledgeBaseFallback
      };
    } catch (error) {
      // Handle specific OpenAI API errors
      if (error.response) {
        const status = error.response.status;
        const errorData = error.response.data;

        if (status === 401) {
          console.error('OpenAI API authentication failed. Please check your API key.');
          throw new Error('OpenAI API key is invalid or expired. Please contact your administrator.');
        } else if (status === 429) {
          console.error('OpenAI API rate limit exceeded.');
          throw new Error('AI service is temporarily unavailable due to rate limits. Please try again later.');
        } else if (status === 500 || status === 502 || status === 503) {
          console.error('OpenAI API service error:', errorData);
          throw new Error('AI service is temporarily unavailable. Please try again later.');
        } else {
          console.error('OpenAI API error:', status, errorData);
          throw new Error(`AI service error: ${errorData?.error?.message || 'Unknown error'}`);
        }
      } else if (error.request) {
        console.error('No response from OpenAI API:', error.message);
        throw new Error('Unable to connect to AI service. Please check your internet connection and try again.');
      } else {
        console.error('AI response generation error:', error.message);
        throw error;
      }
    }
  }

  /**
   * Generate AI response (OpenAI)
   */
  async generateResponse(interaction, organizationId = null, knowledgeBase = null) {
    return this.generateResponseOpenAI(interaction, organizationId, knowledgeBase);
  }

  /**
   * Generate text from a prompt (generic method for any text generation task)
   * Used for summarization, extraction, etc.
   * @param {string} systemPrompt - System instructions
   * @param {string} userPrompt - User input/prompt
   * @param {Object} options - Generation options
   * @returns {Promise<string>} Generated text
   */
  async generateText(systemPrompt, userPrompt, options = {}) {
    const {
      temperature = 0.7,
      maxTokens = 1000,
      model = null,
      feature: optionFeature = null
    } = options;

    try {
      console.log('🤖 [AI] Generating text (OpenAI)');
      console.log(`📝 [AI] System prompt length: ${systemPrompt.length} chars`);
      console.log(`📝 [AI] User prompt length: ${userPrompt.length} chars`);

      if (!this.openaiApiKey || this.openaiApiKey.trim() === '') {
        throw new Error('OpenAI API key is not configured');
      }

      const resolvedModel = normalizeOpenAIModelId(model || this.openaiModel);
      console.log(`🔵 [AI] Using OpenAI model: ${resolvedModel}`);
      const response = await this._postChatCompletions(
        {
          model: resolvedModel,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt }
          ],
          ...openAIChatCompletionTemperatureField(resolvedModel, temperature),
          ...openAIChatCompletionMaxTokensField(resolvedModel, maxTokens || 4000)
        },
        optionFeature ? { feature: optionFeature } : {},
        { timeout: 120000 }
      );

      const generatedText = response.data.choices[0].message.content.trim();
      console.log(`✅ [AI] OpenAI response received: ${generatedText.length} characters`);
      return generatedText;
    } catch (error) {
      console.error(`❌ [AI] Text generation error: ${error.message}`);
      if (error.response) {
        console.error(`❌ [AI] API response status: ${error.response.status}`);
        console.error(`❌ [AI] API response data:`, error.response.data);
      }
      throw new Error(`Failed to generate text: ${error.message}`);
    }
  }

  /**
   * Detect intent/category of interaction
   */
  async detectIntent(content) {
    try {
      if (!this.openaiApiKey || this.openaiApiKey.trim() === '') {
        return 'other';
      }
      const response = await this._postChatCompletions(
        {
          model: this.classificationModel,
          messages: [
            {
              role: 'system',
              content: 'Classify the intent of this message. Respond with ONLY one word: "inquiry", "complaint", "praise", "feedback", "support", or "other".'
            },
            {
              role: 'user',
              content: `Classify: "${content}"`
            }
          ],
          ...openAIChatCompletionTemperatureField(this.classificationModel, 0.3),
          ...openAIChatCompletionMaxTokensField(this.classificationModel, 10)
        },
        {}
      );

      const intent = response.data.choices[0].message.content.toLowerCase().trim();
      const validIntents = ['inquiry', 'complaint', 'praise', 'feedback', 'support'];

      return validIntents.includes(intent) ? intent : 'other';
    } catch (error) {
      console.error('Intent detection error:', error.message);
      return 'other';
    }
  }

  /**
   * Classify a message into an intent bucket.
   * 1) Keyword match (case-insensitive) — first bucket whose keywords appear in content wins.
   * 2) AI fallback — asks the model to pick the best bucket given hints.
   * 3) Default fallback — returns the bucket marked isDefault if nothing matches.
   *
   * @param {string} content - Message text
   * @param {Array} buckets - Active IntentBucket documents (plain objects with _id, name, keywords, aiPromptHint, isDefault)
   * @returns {{ bucketId: string|null, method: 'keyword'|'ai'|'default' }}
   */
  async classifyIntoBucket(content, buckets) {
    if (!buckets || buckets.length === 0) {
      return { bucketId: null, method: 'default' };
    }

    const lowerContent = (content || '').toLowerCase();

    // Step 1: Keyword match
    for (const bucket of buckets) {
      if (!bucket.keywords || bucket.keywords.length === 0) continue;
      for (const kw of bucket.keywords) {
        if (kw && lowerContent.includes(kw.toLowerCase())) {
          return { bucketId: bucket._id.toString(), method: 'keyword' };
        }
      }
    }

    // Step 2: AI classification
    try {
      if (this.openaiApiKey && this.openaiApiKey.trim() !== '') {
        const bucketDescriptions = buckets
          .filter(b => !b.isDefault)
          .map(b => `- "${b.name}": ${b.aiPromptHint || 'No description'}`)
          .join('\n');

        const defaultBucket = buckets.find(b => b.isDefault);
        const defaultName = defaultBucket ? defaultBucket.name : 'General Queries';

        const systemPrompt = `You are a message classifier. Classify the following message into exactly one of these categories. Respond with ONLY the category name, nothing else.

Categories:
${bucketDescriptions}
- "${defaultName}": Anything that does not clearly fit the above categories`;

        const response = await this._postChatCompletions(
          {
            model: this.classificationModel,
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: `Classify: "${content}"` }
            ],
            ...openAIChatCompletionTemperatureField(this.classificationModel, 0.2),
            ...openAIChatCompletionMaxTokensField(this.classificationModel, 20)
          },
          {}
        );

        const aiChoice = response.data.choices[0].message.content.trim().replace(/^["']|["']$/g, '');
        const matched = buckets.find(b => b.name.toLowerCase() === aiChoice.toLowerCase());
        if (matched) {
          return { bucketId: matched._id.toString(), method: 'ai' };
        }
      }
    } catch (error) {
      console.error('Bucket AI classification error:', error.message);
    }

    // Step 3: Default fallback
    const defaultBucket = buckets.find(b => b.isDefault);
    return { bucketId: defaultBucket ? defaultBucket._id.toString() : null, method: 'default' };
  }

  /**
   * Combined single-call analysis: sentiment + intent + topics + optional bucket classification.
   * Replaces the 4 separate calls in processAI for a ~4x reduction in HTTP round trips and
   * system-prompt overhead per interaction.
   *
   * @param {string} content - Interaction message text
   * @param {Array} buckets  - Active IntentBucket documents (from DB, may be empty)
   * @returns {{ sentiment, sentimentScore, sentimentConfidence, intent, topics, bucketResult }}
   */
  async analyzeInteraction(content, buckets = []) {
    // Keyword bucket match first — no AI cost, short-circuits bucket section from the prompt
    let keywordBucketResult = null;
    const lowerContent = (content || '').toLowerCase();
    if (buckets && buckets.length > 0) {
      outer: for (const bucket of buckets) {
        if (!bucket.keywords || bucket.keywords.length === 0) continue;
        for (const kw of bucket.keywords) {
          if (kw && lowerContent.includes(kw.toLowerCase())) {
            keywordBucketResult = { bucketId: bucket._id.toString(), method: 'keyword' };
            break outer;
          }
        }
      }
    }

    const includeBucketAI = !keywordBucketResult && buckets && buckets.length > 0;
    const defaultBucket = buckets.find(b => b.isDefault);
    const defaultName = defaultBucket ? defaultBucket.name : 'General Queries';

    const bucketJsonField = includeBucketAI ? ',\n  "bucketName": "exact bucket name, or null"' : '';
    const bucketSection = includeBucketAI
      ? `\n\nBucket categories (assign exactly one or null):\n${
          buckets
            .filter(b => !b.isDefault)
            .map(b => `- "${b.name}": ${b.aiPromptHint || 'No description'}`)
            .join('\n')
        }\n- "${defaultName}": anything that does not fit the above`
      : '';

    const systemPrompt = `Analyze the customer message. Respond ONLY with valid JSON, no other text:
{
  "sentiment": "positive" or "negative" or "neutral",
  "score": number from -1 to 1,
  "confidence": number from 0 to 1,
  "intent": "inquiry" or "complaint" or "praise" or "feedback" or "support" or "other",
  "topics": ["keyword1", "keyword2"]${bucketJsonField}
}

Scoring: very positive 0.7-1.0, neutral -0.3 to 0.3, very negative -1.0 to -0.7.
Topics: 2-3 keywords only.${bucketSection}`;

    const response = await this._postChatCompletions(
      {
        model: this.classificationModel,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `Message: "${content}"` }
        ],
        ...openAIChatCompletionTemperatureField(this.classificationModel, 0.2),
        ...openAIChatCompletionMaxTokensField(this.classificationModel, includeBucketAI ? 150 : 120)
      },
      {}
    );

    const raw = response.data.choices[0].message.content.trim();
    let parsed;
    try {
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      parsed = JSON.parse(jsonMatch ? jsonMatch[0] : raw);
    } catch {
      parsed = {};
    }

    const validSentiments = ['positive', 'negative', 'neutral'];
    const validIntents = ['inquiry', 'complaint', 'praise', 'feedback', 'support', 'other'];

    const sentiment = validSentiments.includes(parsed.sentiment) ? parsed.sentiment : 'neutral';
    const sentimentScore = typeof parsed.score === 'number' ? Math.max(-1, Math.min(1, parsed.score)) : 0;
    const sentimentConfidence = typeof parsed.confidence === 'number' ? Math.max(0, Math.min(1, parsed.confidence)) : 0.5;
    const intent = validIntents.includes(parsed.intent) ? parsed.intent : 'other';
    const topics = Array.isArray(parsed.topics) ? parsed.topics.map(t => String(t).trim()).filter(Boolean) : [];

    // Resolve bucket result
    let bucketResult = keywordBucketResult;
    if (!bucketResult && includeBucketAI && parsed.bucketName) {
      const matched = buckets.find(b => b.name.toLowerCase() === String(parsed.bucketName).toLowerCase());
      if (matched) {
        bucketResult = { bucketId: matched._id.toString(), method: 'ai' };
      }
    }
    if (!bucketResult && defaultBucket) {
      bucketResult = { bucketId: defaultBucket._id.toString(), method: 'default' };
    }

    return { sentiment, sentimentScore, sentimentConfidence, intent, topics, bucketResult };
  }

  /**
   * Extract topics/keywords from text
   */
  async extractTopics(content) {
    try {
      if (!this.openaiApiKey || this.openaiApiKey.trim() === '') {
        return [];
      }
      const response = await this._postChatCompletions(
        {
          model: this.classificationModel,
          messages: [
            {
              role: 'system',
              content: 'Extract 2-3 main topics or keywords from the text. Return them as a comma-separated list.'
            },
            {
              role: 'user',
              content: `Extract topics: "${content}"`
            }
          ],
          ...openAIChatCompletionTemperatureField(this.classificationModel, 0.3),
          ...openAIChatCompletionMaxTokensField(this.classificationModel, 50)
        },
        {}
      );

      const topicsStr = response.data.choices[0].message.content.trim();
      return topicsStr.split(',').map(t => t.trim()).filter(t => t);
    } catch (error) {
      console.error('Topic extraction error:', error.message);
      return [];
    }
  }

  /**
   * Normalize list entries for case-insensitive platform matching
   */
  _normalizePlatformList(list) {
    if (!list || !list.length) return [];
    return list.map((p) => String(p).toLowerCase().trim()).filter(Boolean);
  }

  /**
   * True when sentiment analysis has finished with a known label (required for sentiment-based rules).
   */
  _hasKnownSentiment(interaction) {
    const s = interaction.sentiment;
    return s === 'positive' || s === 'negative' || s === 'neutral';
  }

  /**
   * Cheap gate before enqueueing a webhook/sync auto-reply job (avoids useless queue work).
   * Does not require sentiment — caller still runs full canAutoReply when the job executes.
   */
  shouldQueueImmediateAutoReply(interaction, organizationDoc) {
    if (!organizationDoc?.autoReplySettings) return false;
    const settings = organizationDoc.autoReplySettings;
    if (!settings.enabled) return false;

    const plat = (interaction.platform || '').toLowerCase();
    if (settings.enabledPlatforms && settings.enabledPlatforms.length > 0) {
      const allowed = this._normalizePlatformList(settings.enabledPlatforms);
      if (!allowed.includes(plat)) return false;
    }
    if (settings.enabledTypes && settings.enabledTypes.length > 0) {
      if (!settings.enabledTypes.includes(interaction.type)) return false;
    }
    return true;
  }

  /**
   * Determine if interaction is eligible for auto-reply (must match Organization.autoReplySettings).
   * Note: minConfidence in settings = minimum AI reply confidence (enforced in generateAutoReply), not sentiment score.
   */
  async canAutoReply(interaction, organizationSettings = {}) {
    // One document per DM thread (dm_*_*): replies[] is conversation history, not "already answered this turn"
    if (!isThreadStyleDm(interaction)) {
      if (interaction.status === 'replied' || interaction.status === 'resolved') {
        return false;
      }
      if (interaction.replies && interaction.replies.length > 0) {
        return false;
      }
    }

    // IMPORTANT: Don't reply to replies that are replies to our own replies
    // If this interaction has a parentId, check if the parent has a system reply
    if (interaction.parentId) {
      // This is a reply to another comment
      // We should check if the parent comment already has a system reply
      // If so, skip auto-replying to this reply
      // Note: We'll handle this check in the auto-reply processor where we have access to the Interaction model
      // For now, we'll add a flag to indicate this needs parent checking
      interaction._needsParentCheck = true;
    }

    // Respect organization settings (support plain object or Mongoose doc)
    const settings =
      organizationSettings.autoReplySettings ||
      organizationSettings?.toObject?.()?.autoReplySettings ||
      {};

    if (!settings.enabled) {
      return false;
    }

    // Platform filters (case-insensitive)
    if (settings.enabledPlatforms && settings.enabledPlatforms.length > 0) {
      const plat = (interaction.platform || '').toLowerCase();
      const allowed = this._normalizePlatformList(settings.enabledPlatforms);
      if (!allowed.includes(plat)) {
        console.warn(
          `⚠️  [canAutoReply] Blocked — platform "${plat}" not in enabledPlatforms [${allowed.join(', ')}]. ` +
          `Add "${plat}" in Auto-Reply settings → Enabled Platforms. Interaction: ${interaction._id}`
        );
        return false;
      }
    }

    // Interaction type (comment, dm, review, mention)
    if (settings.enabledTypes && settings.enabledTypes.length > 0) {
      if (!settings.enabledTypes.includes(interaction.type)) {
        console.warn(
          `⚠️  [canAutoReply] Blocked — type "${interaction.type}" not in enabledTypes [${settings.enabledTypes.join(', ')}]. ` +
          `Add "${interaction.type}" in Auto-Reply settings → Enabled Types. Interaction: ${interaction._id}`
        );
        return false;
      }
    }

    const sentimentFilter = settings.sentimentFilter || 'all';
    const sentiment = interaction.sentiment;

    // Any non-"all" filter requires a completed sentiment analysis
    if (sentimentFilter !== 'all' && !this._hasKnownSentiment(interaction)) {
      return false;
    }

    if (sentimentFilter !== 'all') {
      let blocked = false;
      switch (sentimentFilter) {
        case 'negative_only':
          if (sentiment !== 'negative') blocked = true;
          break;
        case 'positive_only':
          if (sentiment !== 'positive') blocked = true;
          break;
        case 'neutral_only':
          if (sentiment !== 'neutral') blocked = true;
          break;
        case 'positive_neutral':
          if (sentiment === 'negative') blocked = true;
          break;
        default:
          break;
      }
      if (blocked) {
        console.warn(
          `⚠️  [canAutoReply] Blocked — sentimentFilter is "${sentimentFilter}" but message sentiment is "${sentiment}". ` +
          `Set sentimentFilter to "all" in Auto-Reply settings to reply to all messages. Interaction: ${interaction._id}`
        );
        return false;
      }
    }

    // Per-bucket reply toggle
    if (interaction.intentBucket) {
      const IntentBucket = require('../models/IntentBucket');
      const bucket = await IntentBucket.findById(interaction.intentBucket).select('replyEnabled name').lean();
      if (bucket && bucket.replyEnabled === false) {
        console.warn(
          `⚠️  [canAutoReply] Blocked — bucket "${bucket.name}" has auto-reply disabled. ` +
          `Enable it in Settings → Intent Buckets → ${bucket.name} → Auto-Reply. ` +
          `Interaction: ${interaction._id}`
        );
        return false;
      }
    }

    return true;
  }

  /**
   * Generate AI reply with knowledge base for a single interaction
   */
  async generateAutoReply(interaction, organizationId, organizationSettings = {}) {
    try {
      // Check if eligible
      if (!(await this.canAutoReply(interaction, organizationSettings))) {
        return {
          eligible: false,
          reason: 'Interaction not eligible for auto-reply based on settings'
        };
      }

      // Check AI credits before generating (auto-reply = 1 credit)
      const creditCheck = await aiCreditService.checkCredits(organizationId, 1);

      if (!creditCheck.allowed) {
        console.warn(`❌ [Auto-Reply] AI credit limit reached for org ${organizationId}`);
        return {
          eligible: false,
          reason: creditCheck.error || 'Insufficient AI credits for auto-reply',
          code: creditCheck.code || 'AI_CREDITS_EXCEEDED',
          creditsNeeded: 1,
          creditsRemaining: creditCheck.remaining
        };
      }

      // Generate response with self-assessment (Layer 2: LLM reports resolvable flag)
      const { result: response, aiApiUsageId } = await runWithAiContextAndUsageId(
        {
          organizationId,
          userId: interaction.assignedTo || undefined,
          feature: 'inbox.auto_reply'
        },
        () => this.generateResponseOpenAI(interaction, organizationId, null, { withSelfAssessment: true })
      );

      if (!response) {
        return {
          eligible: false,
          reason: 'Failed to generate AI response'
        };
      }

      // Layer 2: AI self-assessed that it cannot resolve this query — route to human
      if (response.resolvable === false) {
        logger.info('[Auto-reply] AI self-assessed as unresolvable — routing to human', {
          interactionId: interaction._id?.toString(),
          reason: response.resolvableReason
        });
        // Deduct credits: we still made the AI call
        try {
          const User = require('../models/User');
          let uid = interaction.assignedTo;
          if (!uid) {
            const adminUser = await User.findOne({
              organization: organizationId,
              role: { $in: ['admin', 'manager'] }
            }).select('_id');
            uid = adminUser?._id;
          }
          await aiCreditService.deductCredits(
            organizationId, 1,
            { operation: 'auto_reply_unresolvable', userId: uid, interactionId: interaction._id.toString(), platform: interaction.platform },
            { aiApiUsageId }
          );
        } catch { /* credit deduction failure is non-fatal */ }

        return {
          eligible: true,
          resolvable: false,
          resolvableReason: response.resolvableReason,
          creditsUsed: 1
        };
      }

      // Check confidence threshold (applied only when AI thinks it can resolve)
      const minConfidence = organizationSettings.autoReplySettings?.minConfidence || 0.7;
      if (response.confidence < minConfidence) {
        return {
          eligible: false,
          reason: `Confidence ${response.confidence} below threshold ${minConfidence}`,
          response: response
        };
      }

      // Deduct AI credits after successful generation
      // Try to find a user to attribute this to (assigned user or an admin)
      const User = require('../models/User');
      let userId = interaction.assignedTo;
      if (!userId) {
        const adminUser = await User.findOne({ 
          organization: organizationId, 
          role: { $in: ['admin', 'manager'] } 
        }).select('_id');
        userId = adminUser?._id;
      }
      
      await aiCreditService.deductCredits(
        organizationId,
        1,
        {
          operation: 'auto_reply',
          userId: userId,
          interactionId: interaction._id.toString(),
          platform: interaction.platform
        },
        { aiApiUsageId }
      );

      return { eligible: true, response: response, creditsUsed: 1 };
    } catch (error) {
      console.error('Auto-reply generation error:', error.message);
      // If credits were deducted but something failed after, rollback
      // Since deduction is the last step before return, rollback only if deduction itself threw
      // (the aiCreditService.deductCredits rethrows on failure, so no credits were actually taken)
      return { eligible: false, reason: error.message };
    }
  }
}


module.exports = new AIService();

