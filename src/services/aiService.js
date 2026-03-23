const axios = require('axios');
const KnowledgeBase = require('../models/KnowledgeBase');
const BrandConfig = require('../models/BrandConfig');
const aiCreditService = require('./aiCreditService');
const logger = require('../config/logger');
const { escapeRegex } = require('../utils/sanitize');
const { isThreadStyleDm } = require('../utils/interactionThreadDm');

class AIService {
  constructor() {
    this.openaiApiKey = process.env.OPENAI_API_KEY;
    this.openaiApiUrl = 'https://api.openai.com/v1/chat/completions';
    this.openaiImagesUrl = 'https://api.openai.com/v1/images/generations';
    this.openaiModel = process.env.OPENAI_MODEL || 'gpt-4';

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

  /**
   * Search relevant knowledge base entries for a given query
   */
  async searchKnowledgeBase(organizationId, query, limit = 5) {
    try {
      // Use MongoDB text search for relevant entries
      const results = await KnowledgeBase.find({
        organization: organizationId,
        isActive: true,
        $text: { $search: query }
      })
        .select('title content category priority keywords')
        .sort({ score: { $meta: 'textScore' }, priority: -1 })
        .limit(limit);

      // If no results from text search, try keyword matching
      if (results.length === 0) {
        const queryWords = query.toLowerCase().split(/\s+/).filter(w => w.length > 3);
        const escapedForRegex = queryWords.map(w => escapeRegex(w));

        if (queryWords.length > 0) {
          const keywordResults = await KnowledgeBase.find({
            organization: organizationId,
            isActive: true,
            $or: [
              { keywords: { $in: queryWords } },
              { title: { $regex: escapedForRegex.join('|'), $options: 'i' } }
            ]
          })
            .select('title content category priority keywords')
            .sort({ priority: -1, usageCount: -1 })
            .limit(limit);

          return keywordResults;
        }
      }

      return results;
    } catch (error) {
      console.error('Knowledge base search error:', error.message);
      return [];
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
      return parts.length ? parts.join(' ') : null;
    } catch (err) {
      logger.warn('Brand context fetch failed', { organizationId, err: err.message });
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

${platformGuidelines}
${brandSection}
Guidelines:
- Be authentic and engaging
- Use appropriate emojis sparingly
- Include relevant hashtags (3-5 for Instagram, 1-2 for others)
- Keep tone professional yet conversational
- Match platform best practices
- For stories: Keep it casual and time-sensitive
- For reels/shorts: Hook in first 3 seconds

Generate ONLY the post content. No explanations or meta-commentary.`;

    if (!this.openaiApiKey || this.openaiApiKey.trim() === '') {
      throw new Error('OpenAI API key is not configured');
    }
    const response = await axios.post(
      this.openaiApiUrl,
      {
        model: this.openaiModel,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: prompt }
        ],
        temperature: 0.8,
        max_tokens: 500
      },
      {
        headers: {
          Authorization: `Bearer ${this.openaiApiKey}`,
          'Content-Type': 'application/json'
        },
        timeout: 30000
      }
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
    const includeTrend = options.includeTrend;
    let userPrompt = prompt;
    if (audience) userPrompt += ` Target audience: ${audience}.`;
    if (intent) userPrompt += ` Content intent: ${intent}.`;
    if (includeTrend) userPrompt += ' Weave in a relevant current trend or seasonal angle.';

    const brandContext = organizationId ? await this._getBrandContext(organizationId) : null;
    const variants = [];
    const temperatures = [0.7, 0.85, 0.95].slice(0, count);
    for (let i = 0; i < count; i++) {
      const content = await this._generateSinglePostWithTemperature(
        userPrompt,
        platforms,
        postType,
        brandContext,
        temperatures[i] || 0.8
      );
      variants.push({ content: content || '' });
    }
    return { variants };
  }

  async _generateSinglePostWithTemperature(prompt, platforms, postType, brandContext, temperature = 0.8) {
    const platformNames = platforms.join(', ');
    const platformGuidelines = this._getPlatformGuidelines(platforms, postType);
    const brandSection = brandContext ? `\nBrand guidelines (follow strictly):\n${brandContext}\n` : '';
    const systemPrompt = `You are a professional social media content creator. Generate engaging ${postType} content for ${platformNames}.
${platformGuidelines}
${brandSection}
Guidelines:
- Be authentic and engaging. Use appropriate emojis sparingly.
- Include relevant hashtags (3-5 for Instagram, 1-2 for others).
- Generate ONLY the post content. No explanations or meta-commentary.`;

    if (!this.openaiApiKey || this.openaiApiKey.trim() === '') {
      throw new Error('OpenAI API key is not configured');
    }
    const response = await axios.post(
      this.openaiApiUrl,
      {
        model: this.openaiModel,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: prompt }
        ],
        temperature: Math.min(1, Math.max(0, temperature)),
        max_tokens: 500
      },
      {
        headers: {
          Authorization: `Bearer ${this.openaiApiKey}`,
          'Content-Type': 'application/json'
        },
        timeout: 30000
      }
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
   * Generate an image from a text prompt using OpenAI DALL-E (when provider is OpenAI).
   * @param {string} prompt - Description of the image to generate (e.g. post topic or caption)
   * @returns {Promise<Buffer|null>} Image buffer or null if not supported / error
   */
  async generateImage(prompt) {
    if (!this.openaiApiKey || this.openaiApiKey.trim() === '') {
      return null;
    }
    try {
      const imagePrompt = typeof prompt === 'string' && prompt.length > 0
        ? prompt.substring(0, 1000)
        : 'Professional social media post image, modern, high quality';
      const model = process.env.OPENAI_IMAGE_MODEL || 'dall-e-2';
      const isDallE3 = model.startsWith('dall-e-3');
      const body = {
        model,
        prompt: imagePrompt,
        n: 1,
        size: isDallE3 ? '1024x1024' : '1024x1024',
        response_format: 'url'
      };
      if (isDallE3) {
        body.quality = 'standard';
      }
      const response = await axios.post(
        this.openaiImagesUrl,
        body,
        {
          headers: {
            Authorization: `Bearer ${this.openaiApiKey}`,
            'Content-Type': 'application/json'
          },
          timeout: 60000
        }
      );
      const imageUrl = response.data?.data?.[0]?.url;
      if (!imageUrl) return null;
      const imgResponse = await axios.get(imageUrl, { responseType: 'arraybuffer' });
      return Buffer.from(imgResponse.data);
    } catch (error) {
      const status = error.response?.status;
      const data = error.response?.data;
      logger.warn('AI image generation failed', {
        error: error.message,
        status,
        openaiError: data?.error?.message || data?.message
      });
      return null;
    }
  }

  /**
   * Analyze sentiment of text using OpenAI
   */
  async analyzeSentiment(content) {
    try {
      console.log(`🔍 [AI] Analyzing sentiment for: "${content.substring(0, 50)}..."`);

      try {
        const response = await axios.post(
          this.openaiApiUrl,
          {
            model: this.openaiModel,
            messages: [
              {
                role: 'system',
                content: `You are an expert sentiment analysis AI. Analyze customer interactions.

Respond with ONLY this JSON structure (no other text):
{
  "sentiment": "positive" or "negative" or "neutral",
  "score": number between -1 and 1,
  "confidence": number between 0 and 1,
  "reasoning": "brief explanation"
}

Rules:
- positive: Praise, gratitude, satisfaction, enthusiasm
- negative: Complaints, anger, disappointment, frustration
- neutral: Questions, information requests, factual statements

Scoring:
- Very positive: 0.7 to 1.0
- Neutral: -0.3 to 0.3
- Very negative: -1.0 to -0.7`
              },
              {
                role: 'user',
                content: `Analyze: "${content}"`
              }
            ],
            temperature: 0.2,
            max_tokens: 150
          },
          {
            headers: {
              Authorization: `Bearer ${this.openaiApiKey}`,
              'Content-Type': 'application/json'
            },
            timeout: 30000
          }
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
   */
  async generateResponseOpenAI(interaction, organizationId = null, knowledgeBase = null) {
    try {
      // Check if API key is configured
      if (!this.openaiApiKey || this.openaiApiKey.trim() === '') {
        console.error('OpenAI API key is not configured. Please set OPENAI_API_KEY environment variable.');
        throw new Error('OpenAI API key is not configured. Please contact your administrator.');
      }

      // If knowledgeBase not provided, search for relevant entries
      let relevantKB = knowledgeBase;
      if (!relevantKB && organizationId) {
        relevantKB = await this.searchKnowledgeBase(organizationId, interaction.content, 5);

        // Increment usage count for used KB entries (with error handling)
        for (const kb of relevantKB) {
          try {
            // Ensure usageCount is valid before incrementing
            if (typeof kb.usageCount !== 'number' || isNaN(kb.usageCount)) {
              kb.usageCount = 0;
            }
            await kb.incrementUsage();
          } catch (usageError) {
            console.error('Error incrementing KB usage:', usageError);
            // Continue processing even if usage increment fails
          }
        }
      }

      // Build context from knowledge base
      const kbContext = relevantKB && relevantKB.length > 0
        ? relevantKB.map(kb => `${kb.title}: ${kb.content}`).join('\n\n')
        : '';

      const systemPrompt = `You are a professional customer service representative. 
Your task is to generate a helpful, friendly, and professional response to customer inquiries.

IMPORTANT GUIDELINES:
- Be polite, empathetic, and professional
- Keep responses concise and clear (2-4 sentences)
- Use a friendly and conversational tone
- Address the customer's concern directly
- If the knowledge base contains relevant information, use it to provide accurate answers
- If you don't have enough information, acknowledge it professionally
- Do not make promises you can't keep
- Match the tone to the platform (casual for social media, professional for reviews)
${kbContext ? `\n\nKNOWLEDGE BASE (Use this information to answer):\n${kbContext}` : '\n\nNote: No specific knowledge base available. Provide a general helpful response.'}

Generate a response that addresses the customer's message appropriately.`;

      const response = await axios.post(
        this.openaiApiUrl,
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
          temperature: 0.7,
          max_tokens: 250
        },
        {
          headers: {
            'Authorization': `Bearer ${this.openaiApiKey}`,
            'Content-Type': 'application/json'
          }
        }
      );

      const generatedResponse = response.data.choices[0].message.content.trim();

      // Calculate confidence based on KB matches
      let confidence = 0.7; // Default confidence
      if (relevantKB && relevantKB.length > 0) {
        confidence = Math.min(0.95, 0.7 + (relevantKB.length * 0.05));
      }

      return {
        content: generatedResponse,
        confidence: confidence,
        generatedAt: new Date(),
        usedKnowledgeBase: relevantKB && relevantKB.length > 0,
        knowledgeBaseCount: relevantKB ? relevantKB.length : 0
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
      model = null
    } = options;

    try {
      console.log('🤖 [AI] Generating text (OpenAI)');
      console.log(`📝 [AI] System prompt length: ${systemPrompt.length} chars`);
      console.log(`📝 [AI] User prompt length: ${userPrompt.length} chars`);

      if (!this.openaiApiKey || this.openaiApiKey.trim() === '') {
        throw new Error('OpenAI API key is not configured');
      }

      console.log(`🔵 [AI] Using OpenAI model: ${model || this.openaiModel}`);
      const response = await axios.post(
        this.openaiApiUrl,
        {
          model: model || this.openaiModel,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt }
          ],
          temperature,
          max_tokens: maxTokens || 4000
        },
        {
          headers: {
            Authorization: `Bearer ${this.openaiApiKey}`,
            'Content-Type': 'application/json'
          },
          timeout: 60000
        }
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
      const response = await axios.post(
        this.openaiApiUrl,
        {
          model: this.openaiModel,
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
          temperature: 0.3,
          max_tokens: 10
        },
        {
          headers: {
            Authorization: `Bearer ${this.openaiApiKey}`,
            'Content-Type': 'application/json'
          }
        }
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
   * Extract topics/keywords from text
   */
  async extractTopics(content) {
    try {
      if (!this.openaiApiKey || this.openaiApiKey.trim() === '') {
        return [];
      }
      const response = await axios.post(
        this.openaiApiUrl,
        {
          model: this.openaiModel,
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
          temperature: 0.3,
          max_tokens: 50
        },
        {
          headers: {
            Authorization: `Bearer ${this.openaiApiKey}`,
            'Content-Type': 'application/json'
          }
        }
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
  canAutoReply(interaction, organizationSettings = {}) {
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
        return false;
      }
    }

    // Interaction type (comment, dm, review, mention)
    if (settings.enabledTypes && settings.enabledTypes.length > 0) {
      if (!settings.enabledTypes.includes(interaction.type)) {
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
      switch (sentimentFilter) {
        case 'negative_only':
          if (sentiment !== 'negative') {
            return false;
          }
          break;
        case 'positive_only':
          if (sentiment !== 'positive') {
            return false;
          }
          break;
        case 'neutral_only':
          if (sentiment !== 'neutral') {
            return false;
          }
          break;
        case 'positive_neutral':
          if (sentiment === 'negative') {
            return false;
          }
          break;
        default:
          break;
      }
    }

    // Legacy: with filter "all", block negative unless replyToNegative is explicitly true (undefined/false = do not reply to negative)
    if (sentimentFilter === 'all' && settings.replyToNegative !== true) {
      if (!this._hasKnownSentiment(interaction)) {
        return false;
      }
      if (sentiment === 'negative') {
        return false;
      }
    }

    // Complaints: only block when intent is explicitly classified as complaint
    if (interaction.intent === 'complaint' && !settings.replyToComplaints) {
      return false;
    }

    return true;
  }

  /**
   * Generate AI reply with knowledge base for a single interaction
   */
  async generateAutoReply(interaction, organizationId, organizationSettings = {}) {
    try {
      // Check if eligible
      if (!this.canAutoReply(interaction, organizationSettings)) {
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

      // Generate response
      const response = await this.generateResponse(interaction, organizationId);

      if (!response) {
        return {
          eligible: false,
          reason: 'Failed to generate AI response'
        };
      }

      // Check confidence threshold
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
      
      await aiCreditService.deductCredits(organizationId, 1, {
        operation: 'auto_reply',
        userId: userId,
        interactionId: interaction._id.toString(),
        platform: interaction.platform
      });

      return {
        eligible: true,
        response: response,
        creditsUsed: 1
      };
    } catch (error) {
      console.error('Auto-reply generation error:', error.message);
      return {
        eligible: false,
        reason: error.message
      };
    }
  }
}


module.exports = new AIService();

