/**
 * Sentiment Service
 *
 * Two layers:
 *   1. analyzeSentiment(content)         → AI call to OpenAI; returns {sentiment, score, confidence, reasoning}
 *   2. fallbackSentimentAnalysis(content) → keyword-only heuristic; returns same shape
 *
 * The first layer falls back to the second on any error (rate limit, network,
 * malformed response). Both return the same response shape so callers don't care.
 */

const openaiClient = require('./openaiClient');
const logger = require('../../config/logger');
const {
  openAIChatCompletionTemperatureField,
  openAIChatCompletionMaxTokensField
} = require('../../utils/openaiModelHelpers');

const POSITIVE_WORDS = Object.freeze({
  'love': 2, 'amazing': 2, 'awesome': 2, 'excellent': 2, 'perfect': 2,
  'great': 1.5, 'good': 1.5, 'wonderful': 2, 'fantastic': 2, 'best': 2,
  'nice': 1, 'thanks': 1.5, 'thank you': 2, 'appreciate': 1.5, 'helpful': 1.5,
  '😍': 2, '❤️': 2, '🥰': 2, '😊': 1.5, '👍': 1.5, '🙏': 1.5, '⭐': 1
});

const NEGATIVE_WORDS = Object.freeze({
  'hate': 2, 'terrible': 2, 'awful': 2, 'worst': 2, 'horrible': 2,
  'bad': 1.5, 'poor': 1.5, 'disappointed': 2, 'disappointing': 2,
  'useless': 2, 'waste': 1.5, 'scam': 2, 'fraud': 2, 'pathetic': 2,
  'disgusting': 2, 'angry': 1.5, 'furious': 2, 'annoying': 1.5, 'annoyed': 1.5,
  'upset': 1.5, 'sad': 1.5, 'unhappy': 1.5, 'dislike': 1.5, 'sucks': 2,
  'stupid': 2, 'dumb': 1.5, 'ridiculous': 1.5, 'joke': 1, 'broken': 1.5,
  'fail': 1.5, 'failed': 1.5, 'failure': 2, 'problem': 1, 'issue': 1,
  'bug': 1, 'error': 1, 'wrong': 1, 'not working': 1.5, "doesn't work": 1.5,
  '😡': 2, '😠': 2, '👎': 2, '😤': 1.5, '💔': 2, '😢': 1.5, '😭': 2,
  '😞': 1.5, '😔': 1.5, '😟': 1.5, '😕': 1, '🙁': 1.5, '☹️': 1.5,
  '😩': 1.5, '😫': 1.5, '😖': 1.5, '💀': 1, '🤬': 2, '🖕': 2
});

const SENTIMENT_SYSTEM_PROMPT = `You are an expert sentiment analysis AI. Analyze customer interactions.

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

Scoring: very positive 0.7-1.0, neutral -0.3 to 0.3, very negative -1.0 to -0.7`;

/**
 * Keyword-based fallback. Used when the AI call fails or before AI is wired up.
 */
function fallbackSentimentAnalysis(content) {
  const text = (content || '').toLowerCase();
  let positiveScore = 0;
  let negativeScore = 0;

  Object.entries(POSITIVE_WORDS).forEach(([word, weight]) => {
    if (text.includes(word)) positiveScore += weight;
  });
  Object.entries(NEGATIVE_WORDS).forEach(([word, weight]) => {
    if (text.includes(word)) negativeScore += weight;
  });

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
    sentimentConfidence: 0.6,
    sentimentReasoning: 'Fallback keyword analysis (AI unavailable)'
  };
}

/**
 * AI-powered sentiment analysis with automatic fallback to keyword heuristics.
 */
async function analyzeSentiment(content) {
  try {
    logger.debug('[AI] Analyzing sentiment', { preview: (content || '').substring(0, 50) });

    try {
      const response = await openaiClient.chatCompletion(
        {
          model: openaiClient.classificationModel,
          messages: [
            { role: 'system', content: SENTIMENT_SYSTEM_PROMPT },
            { role: 'user', content: `Analyze: "${content}"` }
          ],
          ...openAIChatCompletionTemperatureField(openaiClient.classificationModel, 0.2),
          ...openAIChatCompletionMaxTokensField(openaiClient.classificationModel, 80)
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
        logger.warn('[AI] Failed to parse OpenAI JSON, using text parsing', {
          error: parseError.message
        });
        const lowered = responseContent.toLowerCase();
        const sentiment = lowered.includes('positive') ? 'positive'
          : lowered.includes('negative') ? 'negative'
            : 'neutral';
        result = {
          sentiment,
          score: sentiment === 'positive' ? 0.7 : sentiment === 'negative' ? -0.7 : 0,
          confidence: 0.75,
          reasoning: 'Fallback text parsing'
        };
      }

      logger.debug('[AI] Sentiment resolved', {
        sentiment: result.sentiment,
        score: result.score,
        confidence: result.confidence
      });

      return {
        sentiment: result.sentiment,
        sentimentScore: result.score,
        sentimentConfidence: result.confidence,
        sentimentReasoning: result.reasoning
      };
    } catch (apiError) {
      if (apiError.response) {
        logger.error('[AI] OpenAI API Error', {
          status: apiError.response.status,
          statusText: apiError.response.statusText,
          data: apiError.response.data,
          model: openaiClient.chatModel
        });
      } else {
        logger.error('[AI] OpenAI Request Error', { error: apiError.message });
      }
      throw apiError;
    }
  } catch (error) {
    logger.error('[AI] Sentiment analysis error', { error: error.message });
    return fallbackSentimentAnalysis(content);
  }
}

module.exports = {
  analyzeSentiment,
  fallbackSentimentAnalysis
};
