const axios = require('axios');
const KnowledgeBase = require('../models/KnowledgeBase');

class AIService {
  constructor() {
    // Ollama configuration (for development with Gemma3)
    this.ollamaUrl = process.env.OLLAMA_URL || 'http://localhost:11434';
    this.ollamaModel = process.env.OLLAMA_MODEL || 'gemma3:270m';

    // OpenAI configuration (for production)
    this.openaiApiKey = process.env.OPENAI_API_KEY;
    this.openaiApiUrl = 'https://api.openai.com/v1/chat/completions';
    this.openaiModel = process.env.OPENAI_MODEL || 'gpt-4';

    // Provider selection: Auto-detect based on availability
    // Priority: 1. Explicit AI_PROVIDER env var, 2. OpenAI if key exists, 3. Ollama
    const explicitProvider = process.env.AI_PROVIDER;

    if (explicitProvider) {
      this.provider = explicitProvider.toLowerCase();
    } else if (this.openaiApiKey && this.openaiApiKey.trim() !== '') {
      // Auto-detect: Use OpenAI if API key is present
      this.provider = 'openai';
      console.log('✅ Auto-detected OpenAI provider (API key found)');
    } else {
      // Fallback to Ollama if no OpenAI key
      this.provider = 'ollama';
      console.log('⚠️  Using Ollama provider (no OpenAI API key found)');
    }

    console.log(`🤖 AI Provider: ${this.provider.toUpperCase()}`);
    if (this.provider === 'openai') {
      console.log(`📝 OpenAI Model: ${this.openaiModel}`);
    } else {
      console.log(`📝 Ollama Model: ${this.ollamaModel}`);
    }
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

        if (queryWords.length > 0) {
          const keywordResults = await KnowledgeBase.find({
            organization: organizationId,
            isActive: true,
            $or: [
              { keywords: { $in: queryWords } },
              { title: { $regex: queryWords.join('|'), $options: 'i' } }
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
   * Analyze sentiment of text using AI
   * This is a centralized sentiment analysis function used across all platforms
   * Supports both Ollama (local) and OpenAI (cloud)
   */
  async analyzeSentiment(content) {
    try {
      console.log(`🔍 [AI] Analyzing sentiment for: "${content.substring(0, 50)}..."`);

      if (this.provider === 'ollama') {
        // Use Ollama (Gemma3) for sentiment analysis
        const response = await axios.post(
          `${this.ollamaUrl}/api/chat`,
          {
            model: this.ollamaModel,
            messages: [
              {
                role: 'system',
                content: `You are an expert sentiment analysis AI. Analyze the sentiment of customer interactions.

RESPONSE FORMAT (return ONLY this JSON, nothing else):
{
  "sentiment": "positive" | "negative" | "neutral",
  "score": number between -1 and 1,
  "confidence": number between 0 and 1,
  "reasoning": "brief explanation"
}

CLASSIFICATION RULES:
- positive: Praise, gratitude, satisfaction, enthusiasm, love, excitement
- negative: Complaints, anger, disappointment, frustration, hate, problems
- neutral: Questions, information requests, factual statements, neutral observations

SCORING:
- Very positive: 0.7 to 1.0
- Mildly positive: 0.3 to 0.7
- Neutral: -0.3 to 0.3
- Mildly negative: -0.7 to -0.3
- Very negative: -1.0 to -0.7

Consider: emojis, capitalization, punctuation, context, sarcasm`
              },
              {
                role: 'user',
                content: `Analyze this text: "${content}"`
              }
            ],
            stream: false,
            options: {
              temperature: 0.2, // Lower temperature for more consistent results
              num_predict: 150
            }
          },
          { timeout: 30000 }
        );

        const result = response.data.message.content.trim();

        // Try to parse JSON response
        let parsedResult;
        try {
          // Extract JSON from response (sometimes AI adds extra text)
          const jsonMatch = result.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            parsedResult = JSON.parse(jsonMatch[0]);
          } else {
            throw new Error('No JSON found in response');
          }
        } catch (parseError) {
          // Fallback to text parsing
          console.warn('Failed to parse JSON, using text parsing:', result);
          const sentiment = result.includes('positive') ? 'positive' :
            result.includes('negative') ? 'negative' : 'neutral';
          parsedResult = {
            sentiment,
            score: sentiment === 'positive' ? 0.7 : sentiment === 'negative' ? -0.7 : 0,
            confidence: 0.75,
            reasoning: 'Fallback text parsing'
          };
        }

        console.log(`✅ [AI] Sentiment: ${parsedResult.sentiment} (score: ${parsedResult.score}, confidence: ${parsedResult.confidence})`);

        return {
          sentiment: parsedResult.sentiment,
          sentimentScore: parsedResult.score,
          sentimentConfidence: parsedResult.confidence,
          sentimentReasoning: parsedResult.reasoning
        };
      } else {
        // Use OpenAI for sentiment analysis
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
                'Authorization': `Bearer ${this.openaiApiKey}`,
                'Content-Type': 'application/json'
              },
              timeout: 30000
            }
          );

          const responseContent = response.data.choices[0].message.content.trim();

          // Try to parse JSON response
          let result;
          try {
            // Extract JSON from response (sometimes AI adds extra text)
            const jsonMatch = responseContent.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
              result = JSON.parse(jsonMatch[0]);
            } else {
              throw new Error('No JSON found in OpenAI response');
            }
          } catch (parseError) {
            // Fallback to text parsing
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
          // Log detailed error for debugging
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
          throw apiError; // Re-throw to trigger fallback
        }
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
      'hate': 2, 'terrible': 2, 'awful': 2, 'worst': 2, 'horrible': 2,
      'bad': 1.5, 'poor': 1.5, 'disappointed': 2, 'disappointing': 2,
      'useless': 2, 'waste': 1.5, 'scam': 2, 'fraud': 2, 'never': 1,
      'pathetic': 2, 'disgusting': 2, 'angry': 1.5, 'furious': 2,
      '😡': 2, '😠': 2, '👎': 2, '😤': 1.5, '💔': 2
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

    console.log(`⚠️  [AI] Fallback sentiment: ${sentiment} (pos: ${positiveScore}, neg: ${negativeScore})`);

    return {
      sentiment,
      sentimentScore: score,
      sentimentConfidence: 0.6, // Lower confidence for keyword-based
      sentimentReasoning: 'Fallback keyword analysis (AI unavailable)'
    };
  }

  /**
   * Generate AI response using Ollama (Gemma3)
   */
  async generateResponseOllama(interaction, organizationId = null, knowledgeBase = null) {
    try {
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

      const userPrompt = `Customer message: "${interaction.content}"\n\nPlatform: ${interaction.platform}\nType: ${interaction.type}\nSentiment: ${interaction.sentiment || 'unknown'}`;

      // Check if Ollama is running
      try {
        await axios.get(`${this.ollamaUrl}/api/tags`, { timeout: 5000 });
      } catch (error) {
        throw new Error('Ollama is not running. Please start it with: ollama serve');
      }

      // Generate response using Ollama Chat API
      const response = await axios.post(
        `${this.ollamaUrl}/api/chat`,
        {
          model: this.ollamaModel,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt }
          ],
          stream: false,
          options: {
            temperature: 0.7,
            num_predict: 250  // max tokens
          }
        },
        {
          timeout: 60000  // 60 second timeout
        }
      );

      const generatedResponse = response.data.message.content.trim();

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
      if (error.code === 'ECONNREFUSED' || error.message.includes('not running')) {
        console.error('Ollama service is not running. Please start it with: ollama serve');
        throw new Error('Ollama service is not running. Please start it with: ollama serve');
      } else if (error.response) {
        console.error('Ollama API error:', error.response.data);
        throw new Error(`Ollama API error: ${error.response.data?.error || error.message}`);
      } else {
        console.error('Ollama error:', error.message);
        throw new Error(`Ollama error: ${error.message}`);
      }
    }
  }

  /**
   * Generate AI response using OpenAI (for production)
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
   * Generate AI response (main method - routes to provider)
   */
  async generateResponse(interaction, organizationId = null, knowledgeBase = null) {
    if (this.provider === 'ollama') {
      return await this.generateResponseOllama(interaction, organizationId, knowledgeBase);
    } else {
      return await this.generateResponseOpenAI(interaction, organizationId, knowledgeBase);
    }
  }

  /**
   * Detect intent/category of interaction
   */
  async detectIntent(content) {
    try {
      if (this.provider === 'ollama') {
        // Use Ollama (Gemma3) for intent detection
        const response = await axios.post(
          `${this.ollamaUrl}/api/chat`,
          {
            model: this.ollamaModel,
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
            stream: false,
            options: {
              temperature: 0.3,
              num_predict: 10
            }
          },
          { timeout: 30000 }
        );

        const intent = response.data.message.content.toLowerCase().trim();
        const validIntents = ['inquiry', 'complaint', 'praise', 'feedback', 'support'];

        return validIntents.includes(intent) ? intent : 'other';
      } else {
        // Use OpenAI for intent detection
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
              'Authorization': `Bearer ${this.openaiApiKey}`,
              'Content-Type': 'application/json'
            }
          }
        );

        const intent = response.data.choices[0].message.content.toLowerCase().trim();
        const validIntents = ['inquiry', 'complaint', 'praise', 'feedback', 'support'];

        return validIntents.includes(intent) ? intent : 'other';
      }
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
      if (this.provider === 'ollama') {
        // Use Ollama (Gemma3) for topic extraction
        const response = await axios.post(
          `${this.ollamaUrl}/api/chat`,
          {
            model: this.ollamaModel,
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
            stream: false,
            options: {
              temperature: 0.3,
              num_predict: 50
            }
          },
          { timeout: 30000 }
        );

        const topicsStr = response.data.message.content.trim();
        return topicsStr.split(',').map(t => t.trim()).filter(t => t);
      } else {
        // Use OpenAI for topic extraction
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
              'Authorization': `Bearer ${this.openaiApiKey}`,
              'Content-Type': 'application/json'
            }
          }
        );

        const topicsStr = response.data.choices[0].message.content.trim();
        return topicsStr.split(',').map(t => t.trim()).filter(t => t);
      }
    } catch (error) {
      console.error('Topic extraction error:', error.message);
      return [];
    }
  }

  /**
   * Determine if interaction is eligible for auto-reply
   */
  canAutoReply(interaction, organizationSettings = {}) {
    // Check if already replied
    if (interaction.status === 'replied' || interaction.status === 'resolved') {
      return false;
    }

    // Check if it has replies
    if (interaction.replies && interaction.replies.length > 0) {
      return false;
    }

    // Respect organization settings
    const settings = organizationSettings.autoReplySettings || {};

    if (!settings.enabled) {
      return false;
    }

    // Check platform filters
    if (settings.enabledPlatforms && settings.enabledPlatforms.length > 0) {
      if (!settings.enabledPlatforms.includes(interaction.platform)) {
        return false;
      }
    }

    // Sentiment filter: control which sentiments to auto-reply to
    const sentimentFilter = settings.sentimentFilter || 'all';
    const sentiment = interaction.sentiment;

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
      }
    }

    // Legacy: Don't auto-reply to negative sentiment (unless explicitly enabled)
    // This is kept for backward compatibility but sentimentFilter takes precedence
    if (sentimentFilter === 'all' && interaction.sentiment === 'negative' && !settings.replyToNegative) {
      return false;
    }

    // Don't auto-reply if confidence is too low
    if (interaction.sentimentConfidence && interaction.sentimentConfidence < (settings.minConfidence || 0.7)) {
      return false;
    }

    // Don't auto-reply to complaints (unless explicitly enabled)
    if (interaction.intent === 'complaint' && !settings.replyToComplaints) {
      return false;
    }

    // Check interaction type filters
    if (settings.enabledTypes && settings.enabledTypes.length > 0) {
      if (!settings.enabledTypes.includes(interaction.type)) {
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
      if (!this.canAutoReply(interaction, organizationSettings)) {
        return {
          eligible: false,
          reason: 'Interaction not eligible for auto-reply based on settings'
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

      return {
        eligible: true,
        response: response
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

