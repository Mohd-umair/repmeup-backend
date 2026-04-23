/**
 * Intent Classification Service
 *
 * Classifies inbound messages along several axes:
 *   - detectIntent(content)            → coarse single-word intent
 *   - extractTopics(content)           → 2-3 keyword topics
 *   - classifyIntoBucket(content, bs)  → keyword-first, AI-second routing into IntentBucket
 *   - analyzeInteraction(content, bs)  → ONE prompt that returns sentiment+intent+topics+bucket
 *                                         (used by the inbox processor to collapse 4 calls into 1)
 */

const openaiClient = require('./openaiClient');
const {
  openAIChatCompletionTemperatureField,
  openAIChatCompletionMaxTokensField
} = require('../../utils/openaiModelHelpers');

const VALID_INTENTS = Object.freeze(['inquiry', 'complaint', 'praise', 'feedback', 'support']);

/**
 * Coarse intent classification — returns one of:
 *   "inquiry" | "complaint" | "praise" | "feedback" | "support" | "other"
 */
async function detectIntent(content) {
  try {
    if (!openaiClient.hasApiKey()) {
      return 'other';
    }
    const response = await openaiClient.chatCompletion(
      {
        model: openaiClient.classificationModel,
        messages: [
          {
            role: 'system',
            content: 'Classify the intent of this message. Respond with ONLY one word: "inquiry", "complaint", "praise", "feedback", "support", or "other".'
          },
          { role: 'user', content: `Classify: "${content}"` }
        ],
        ...openAIChatCompletionTemperatureField(openaiClient.classificationModel, 0.3),
        ...openAIChatCompletionMaxTokensField(openaiClient.classificationModel, 10)
      },
      {}
    );

    const intent = response.data.choices[0].message.content.toLowerCase().trim();
    return VALID_INTENTS.includes(intent) ? intent : 'other';
  } catch (error) {
    console.error('Intent detection error:', error.message);
    return 'other';
  }
}

/**
 * Extract 2-3 topic keywords from the message text.
 */
async function extractTopics(content) {
  try {
    if (!openaiClient.hasApiKey()) {
      return [];
    }
    const response = await openaiClient.chatCompletion(
      {
        model: openaiClient.classificationModel,
        messages: [
          {
            role: 'system',
            content: 'Extract 2-3 main topics or keywords from the text. Return them as a comma-separated list.'
          },
          { role: 'user', content: `Extract topics: "${content}"` }
        ],
        ...openAIChatCompletionTemperatureField(openaiClient.classificationModel, 0.3),
        ...openAIChatCompletionMaxTokensField(openaiClient.classificationModel, 50)
      },
      {}
    );

    const topicsStr = response.data.choices[0].message.content.trim();
    return topicsStr.split(',').map((t) => t.trim()).filter(Boolean);
  } catch (error) {
    console.error('Topic extraction error:', error.message);
    return [];
  }
}

/**
 * Classify a message into an intent bucket.
 *   1) Keyword match — first bucket whose keywords appear in content wins.
 *   2) AI fallback — model picks the best bucket from the descriptions.
 *   3) Default fallback — bucket flagged isDefault.
 *
 * @param {string} content
 * @param {Array} buckets - Active IntentBucket docs ({ _id, name, keywords[], aiPromptHint, isDefault })
 * @returns {{ bucketId: string|null, method: 'keyword'|'ai'|'default' }}
 */
async function classifyIntoBucket(content, buckets) {
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
    if (openaiClient.hasApiKey()) {
      const bucketDescriptions = buckets
        .filter((b) => !b.isDefault)
        .map((b) => `- "${b.name}": ${b.aiPromptHint || 'No description'}`)
        .join('\n');

      const defaultBucket = buckets.find((b) => b.isDefault);
      const defaultName = defaultBucket ? defaultBucket.name : 'General Queries';

      const systemPrompt = `You are a message classifier. Classify the following message into exactly one of these categories. Respond with ONLY the category name, nothing else.

Categories:
${bucketDescriptions}
- "${defaultName}": Anything that does not clearly fit the above categories`;

      const response = await openaiClient.chatCompletion(
        {
          model: openaiClient.classificationModel,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: `Classify: "${content}"` }
          ],
          ...openAIChatCompletionTemperatureField(openaiClient.classificationModel, 0.2),
          ...openAIChatCompletionMaxTokensField(openaiClient.classificationModel, 20)
        },
        {}
      );

      const aiChoice = response.data.choices[0].message.content.trim().replace(/^["']|["']$/g, '');
      const matched = buckets.find((b) => b.name.toLowerCase() === aiChoice.toLowerCase());
      if (matched) {
        return { bucketId: matched._id.toString(), method: 'ai' };
      }
    }
  } catch (error) {
    console.error('Bucket AI classification error:', error.message);
  }

  // Step 3: Default fallback
  const defaultBucket = buckets.find((b) => b.isDefault);
  return { bucketId: defaultBucket ? defaultBucket._id.toString() : null, method: 'default' };
}

/**
 * Combined single-call analysis: sentiment + intent + topics + optional bucket classification.
 * Replaces 4 separate calls in processAI for ~4x reduction in HTTP round trips and
 * system-prompt overhead per interaction.
 */
async function analyzeInteraction(content, buckets = []) {
  // Keyword bucket match first — no AI cost, lets us short-circuit the bucket section in the prompt.
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
  const defaultBucket = buckets.find((b) => b.isDefault);
  const defaultName = defaultBucket ? defaultBucket.name : 'General Queries';

  const bucketJsonField = includeBucketAI ? ',\n  "bucketName": "exact bucket name, or null"' : '';
  const bucketSection = includeBucketAI
    ? `\n\nBucket categories (assign exactly one or null):\n${
        buckets
          .filter((b) => !b.isDefault)
          .map((b) => `- "${b.name}": ${b.aiPromptHint || 'No description'}`)
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

  const response = await openaiClient.chatCompletion(
    {
      model: openaiClient.classificationModel,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `Message: "${content}"` }
      ],
      ...openAIChatCompletionTemperatureField(openaiClient.classificationModel, 0.2),
      ...openAIChatCompletionMaxTokensField(openaiClient.classificationModel, includeBucketAI ? 150 : 120)
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
  const validIntentsExtended = ['inquiry', 'complaint', 'praise', 'feedback', 'support', 'other'];

  const sentiment = validSentiments.includes(parsed.sentiment) ? parsed.sentiment : 'neutral';
  const sentimentScore = typeof parsed.score === 'number'
    ? Math.max(-1, Math.min(1, parsed.score))
    : 0;
  const sentimentConfidence = typeof parsed.confidence === 'number'
    ? Math.max(0, Math.min(1, parsed.confidence))
    : 0.5;
  const intent = validIntentsExtended.includes(parsed.intent) ? parsed.intent : 'other';
  const topics = Array.isArray(parsed.topics)
    ? parsed.topics.map((t) => String(t).trim()).filter(Boolean)
    : [];

  // Resolve final bucket assignment.
  let bucketResult = keywordBucketResult;
  if (!bucketResult && includeBucketAI && parsed.bucketName) {
    const matched = buckets.find((b) => b.name.toLowerCase() === String(parsed.bucketName).toLowerCase());
    if (matched) {
      bucketResult = { bucketId: matched._id.toString(), method: 'ai' };
    }
  }
  if (!bucketResult && defaultBucket) {
    bucketResult = { bucketId: defaultBucket._id.toString(), method: 'default' };
  }

  return { sentiment, sentimentScore, sentimentConfidence, intent, topics, bucketResult };
}

module.exports = {
  detectIntent,
  extractTopics,
  classifyIntoBucket,
  analyzeInteraction
};
