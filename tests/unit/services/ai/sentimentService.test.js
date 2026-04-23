/**
 * Behavioural tests for sentimentService.
 *
 * Covers the contract that callers depend on:
 *   - Both code paths (AI + fallback) return the same response shape.
 *   - Any error in the AI path silently falls back to keyword analysis.
 *   - Successful AI responses are JSON-parsed and mapped to the canonical shape.
 *   - Malformed AI responses still produce a usable result.
 */

jest.mock('../../../../src/services/ai/openaiClient', () => ({
  apiKey: 'mock-key',
  url: 'https://example.test/v1/chat',
  chatModel: 'mock-chat',
  classificationModel: 'mock-classification',
  visionModel: 'mock-vision',
  provider: 'openai',
  hasApiKey: () => true,
  chatCompletion: jest.fn(),
  logImageUsage: jest.fn(),
  logVideoUsage: jest.fn()
}));

const openaiClient = require('../../../../src/services/ai/openaiClient');
const sentimentService = require('../../../../src/services/ai/sentimentService');

const RESPONSE_SHAPE = expect.objectContaining({
  sentiment: expect.stringMatching(/^(positive|negative|neutral)$/),
  sentimentScore: expect.any(Number),
  sentimentConfidence: expect.any(Number)
});

function fakeApiResponse(json) {
  return { data: { choices: [{ message: { content: json } }] } };
}

describe('sentimentService.fallbackSentimentAnalysis', () => {
  it('returns the canonical shape for empty input', () => {
    const r = sentimentService.fallbackSentimentAnalysis('');
    expect(r).toEqual(expect.objectContaining({
      sentiment: 'neutral',
      sentimentScore: 0,
      sentimentConfidence: 0.6
    }));
  });

  it('classifies obvious positive text as positive', () => {
    const r = sentimentService.fallbackSentimentAnalysis('I love this — it is amazing and perfect!');
    expect(r.sentiment).toBe('positive');
    expect(r.sentimentScore).toBeGreaterThan(0);
  });

  it('classifies obvious negative text as negative', () => {
    const r = sentimentService.fallbackSentimentAnalysis('This is terrible, the worst, totally broken.');
    expect(r.sentiment).toBe('negative');
    expect(r.sentimentScore).toBeLessThan(0);
  });

  it('classifies neutral text as neutral with score 0', () => {
    const r = sentimentService.fallbackSentimentAnalysis('What time do you open tomorrow?');
    expect(r.sentiment).toBe('neutral');
    expect(r.sentimentScore).toBe(0);
  });

  it('clamps positive score at 0.8', () => {
    const r = sentimentService.fallbackSentimentAnalysis(
      'love love love amazing amazing perfect best wonderful fantastic awesome excellent'
    );
    expect(r.sentimentScore).toBeLessThanOrEqual(0.8);
  });

  it('clamps negative score at -0.8', () => {
    const r = sentimentService.fallbackSentimentAnalysis(
      'hate hate terrible awful worst horrible disappointed useless scam fraud pathetic disgusting'
    );
    expect(r.sentimentScore).toBeGreaterThanOrEqual(-0.8);
  });

  it('handles emoji-only positive input', () => {
    const r = sentimentService.fallbackSentimentAnalysis('😍❤️🥰');
    expect(r.sentiment).toBe('positive');
  });

  it('handles emoji-only negative input', () => {
    const r = sentimentService.fallbackSentimentAnalysis('😡👎💔');
    expect(r.sentiment).toBe('negative');
  });

  it('tolerates null/undefined input without throwing', () => {
    expect(() => sentimentService.fallbackSentimentAnalysis(null)).not.toThrow();
    expect(() => sentimentService.fallbackSentimentAnalysis(undefined)).not.toThrow();
  });
});

describe('sentimentService.analyzeSentiment', () => {
  beforeEach(() => {
    openaiClient.chatCompletion.mockReset();
  });

  it('returns the canonical shape on a clean OpenAI JSON response', async () => {
    openaiClient.chatCompletion.mockResolvedValue(fakeApiResponse(
      JSON.stringify({ sentiment: 'positive', score: 0.85, confidence: 0.9 })
    ));

    const r = await sentimentService.analyzeSentiment('Great service!');
    expect(r).toEqual(RESPONSE_SHAPE);
    expect(r.sentiment).toBe('positive');
    expect(r.sentimentScore).toBe(0.85);
    expect(r.sentimentConfidence).toBe(0.9);
  });

  it('extracts the JSON object even when surrounded by other text', async () => {
    openaiClient.chatCompletion.mockResolvedValue(fakeApiResponse(
      'Here is my answer: {"sentiment":"negative","score":-0.7,"confidence":0.8} — done.'
    ));

    const r = await sentimentService.analyzeSentiment('Bad!');
    expect(r.sentiment).toBe('negative');
    expect(r.sentimentScore).toBe(-0.7);
  });

  it('falls back to keyword analysis when OpenAI throws (network/rate limit)', async () => {
    openaiClient.chatCompletion.mockRejectedValue(new Error('rate limit'));

    const r = await sentimentService.analyzeSentiment('I love this!');
    expect(r).toEqual(RESPONSE_SHAPE);
    expect(r.sentiment).toBe('positive');
    expect(r.sentimentReasoning).toMatch(/Fallback/);
  });

  it('falls back to keyword analysis when OpenAI returns 429 with response body', async () => {
    const err = new Error('Too Many Requests');
    err.response = { status: 429, statusText: 'Too Many Requests', data: { error: 'rate' } };
    openaiClient.chatCompletion.mockRejectedValue(err);

    const r = await sentimentService.analyzeSentiment('terrible product');
    expect(r.sentiment).toBe('negative');
  });

  it('uses text-parsing fallback when OpenAI returns no JSON', async () => {
    openaiClient.chatCompletion.mockResolvedValue(
      fakeApiResponse('I think this is positive overall, no formal JSON.')
    );

    const r = await sentimentService.analyzeSentiment('Whatever');
    expect(r).toEqual(RESPONSE_SHAPE);
    // The text-parse path keys on the word "positive" appearing in the response.
    expect(r.sentiment).toBe('positive');
  });

  it('passes the configured classification model to openaiClient', async () => {
    openaiClient.chatCompletion.mockResolvedValue(fakeApiResponse(
      JSON.stringify({ sentiment: 'neutral', score: 0, confidence: 0.5 })
    ));

    await sentimentService.analyzeSentiment('Hi');

    expect(openaiClient.chatCompletion).toHaveBeenCalledTimes(1);
    const requestBody = openaiClient.chatCompletion.mock.calls[0][0];
    expect(requestBody.model).toBe('mock-classification');
    expect(requestBody.messages).toHaveLength(2);
    expect(requestBody.messages[0].role).toBe('system');
    expect(requestBody.messages[1].role).toBe('user');
  });
});
