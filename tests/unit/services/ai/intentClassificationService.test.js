/**
 * Behavioural tests for intentClassificationService.
 *
 * Focused on routing/contract behaviour, not LLM accuracy:
 *   - detectIntent normalizes to a fixed enum and falls back to 'other'.
 *   - extractTopics tolerates missing API key + bad responses.
 *   - classifyIntoBucket is keyword-first, AI-second, default-fallback.
 *   - analyzeInteraction collapses 4 calls into 1; respects keyword short-circuit.
 */

const mockChatCompletion = jest.fn();
const mockHasApiKey = jest.fn(() => true);

jest.mock('../../../../src/services/ai/openaiClient', () => ({
  apiKey: 'mock-key',
  url: 'x',
  chatModel: 'mock-chat',
  classificationModel: 'mock-classification',
  visionModel: 'mock-vision',
  provider: 'openai',
  hasApiKey: mockHasApiKey,
  chatCompletion: mockChatCompletion,
  logImageUsage: jest.fn(),
  logVideoUsage: jest.fn()
}));

const intent = require('../../../../src/services/ai/intentClassificationService');

const fakeApiResponse = (text) => ({
  data: { choices: [{ message: { content: text } }] }
});

beforeEach(() => {
  mockChatCompletion.mockReset();
  mockHasApiKey.mockReset();
  mockHasApiKey.mockReturnValue(true);
});

describe('detectIntent', () => {
  it('returns "other" when no API key is configured (no LLM call)', async () => {
    mockHasApiKey.mockReturnValue(false);
    const r = await intent.detectIntent('hello');
    expect(r).toBe('other');
    expect(mockChatCompletion).not.toHaveBeenCalled();
  });

  it('passes through a valid intent enum value', async () => {
    mockChatCompletion.mockResolvedValue(fakeApiResponse('inquiry'));
    expect(await intent.detectIntent('what time?')).toBe('inquiry');
  });

  it('lowercases and trims the model response', async () => {
    mockChatCompletion.mockResolvedValue(fakeApiResponse('  COMPLAINT  '));
    expect(await intent.detectIntent('this is broken')).toBe('complaint');
  });

  it('coerces an invalid label to "other"', async () => {
    mockChatCompletion.mockResolvedValue(fakeApiResponse('ambiguous'));
    expect(await intent.detectIntent('whatever')).toBe('other');
  });

  it('returns "other" when openaiClient throws', async () => {
    mockChatCompletion.mockRejectedValue(new Error('network'));
    expect(await intent.detectIntent('hi')).toBe('other');
  });
});

describe('extractTopics', () => {
  it('returns [] when no API key is configured', async () => {
    mockHasApiKey.mockReturnValue(false);
    expect(await intent.extractTopics('hi')).toEqual([]);
  });

  it('splits a comma-separated response and trims each item', async () => {
    mockChatCompletion.mockResolvedValue(fakeApiResponse('refund, shipping , product quality '));
    const r = await intent.extractTopics('I want a refund');
    expect(r).toEqual(['refund', 'shipping', 'product quality']);
  });

  it('drops empty entries from a malformed response', async () => {
    mockChatCompletion.mockResolvedValue(fakeApiResponse(',,,refund,,,'));
    expect(await intent.extractTopics('x')).toEqual(['refund']);
  });

  it('returns [] when openaiClient throws', async () => {
    mockChatCompletion.mockRejectedValue(new Error('429'));
    expect(await intent.extractTopics('x')).toEqual([]);
  });
});

describe('classifyIntoBucket', () => {
  const billingBucket = {
    _id: 'bucket_billing',
    name: 'Billing',
    keywords: ['refund', 'invoice'],
    aiPromptHint: 'Money related questions',
    isDefault: false
  };
  const supportBucket = {
    _id: 'bucket_support',
    name: 'Support',
    keywords: ['broken', 'error'],
    aiPromptHint: 'Things not working',
    isDefault: false
  };
  const defaultBucket = {
    _id: 'bucket_general',
    name: 'General Queries',
    keywords: [],
    isDefault: true
  };

  it('returns null/default when buckets is empty', async () => {
    expect(await intent.classifyIntoBucket('hi', [])).toEqual({ bucketId: null, method: 'default' });
    expect(mockChatCompletion).not.toHaveBeenCalled();
  });

  it('matches by keyword without calling the LLM (fast path)', async () => {
    const r = await intent.classifyIntoBucket('I want a refund please', [billingBucket, supportBucket, defaultBucket]);
    expect(r).toEqual({ bucketId: 'bucket_billing', method: 'keyword' });
    expect(mockChatCompletion).not.toHaveBeenCalled();
  });

  it('keyword match is case-insensitive', async () => {
    const r = await intent.classifyIntoBucket('My INVOICE is wrong', [billingBucket, defaultBucket]);
    expect(r.bucketId).toBe('bucket_billing');
  });

  it('falls through to AI when no keyword matches', async () => {
    mockChatCompletion.mockResolvedValue(fakeApiResponse('Support'));
    const r = await intent.classifyIntoBucket('app crashes randomly', [billingBucket, supportBucket, defaultBucket]);
    expect(r).toEqual({ bucketId: 'bucket_support', method: 'ai' });
    expect(mockChatCompletion).toHaveBeenCalledTimes(1);
  });

  it('strips quotes around the AI choice when matching bucket names', async () => {
    mockChatCompletion.mockResolvedValue(fakeApiResponse('"Support"'));
    const r = await intent.classifyIntoBucket('app issue', [billingBucket, supportBucket, defaultBucket]);
    expect(r.bucketId).toBe('bucket_support');
  });

  it('falls back to the default bucket when AI returns an unknown name', async () => {
    mockChatCompletion.mockResolvedValue(fakeApiResponse('Unknown Bucket'));
    const r = await intent.classifyIntoBucket('weird message', [billingBucket, supportBucket, defaultBucket]);
    expect(r).toEqual({ bucketId: 'bucket_general', method: 'default' });
  });

  it('falls back to default when the AI call throws', async () => {
    mockChatCompletion.mockRejectedValue(new Error('boom'));
    const r = await intent.classifyIntoBucket('weird', [billingBucket, defaultBucket]);
    expect(r).toEqual({ bucketId: 'bucket_general', method: 'default' });
  });

  it('returns { bucketId: null, method: default } when no default bucket exists and AI fails', async () => {
    mockChatCompletion.mockRejectedValue(new Error('boom'));
    const r = await intent.classifyIntoBucket('weird', [billingBucket]);
    expect(r).toEqual({ bucketId: null, method: 'default' });
  });

  it('skips the AI step entirely when API key is missing', async () => {
    mockHasApiKey.mockReturnValue(false);
    const r = await intent.classifyIntoBucket('weird', [billingBucket, defaultBucket]);
    expect(r).toEqual({ bucketId: 'bucket_general', method: 'default' });
    expect(mockChatCompletion).not.toHaveBeenCalled();
  });
});

describe('analyzeInteraction', () => {
  // The AI is prompted to return { sentiment, score, confidence, intent, topics, bucketName? }
  // — the function then remaps `score` → sentimentScore, `confidence` → sentimentConfidence.
  const fakeAiJson = {
    sentiment: 'negative',
    score: -0.6,
    confidence: 0.85,
    intent: 'complaint',
    topics: ['refund', 'delay']
  };

  it('returns the canonical 4-axis shape (remaps score/confidence)', async () => {
    mockChatCompletion.mockResolvedValue(fakeApiResponse(JSON.stringify(fakeAiJson)));
    const r = await intent.analyzeInteraction('Where is my refund?', []);

    expect(r).toEqual(expect.objectContaining({
      sentiment: 'negative',
      sentimentScore: -0.6,
      sentimentConfidence: 0.85,
      intent: 'complaint',
      topics: ['refund', 'delay']
    }));
  });

  it('clamps an out-of-range score to [-1, 1]', async () => {
    mockChatCompletion.mockResolvedValue(fakeApiResponse(
      JSON.stringify({ ...fakeAiJson, score: -5 })
    ));
    const r = await intent.analyzeInteraction('hi', []);
    expect(r.sentimentScore).toBe(-1);
  });

  it('defaults sentimentConfidence to 0.5 when missing', async () => {
    mockChatCompletion.mockResolvedValue(fakeApiResponse(
      JSON.stringify({ sentiment: 'neutral', intent: 'inquiry', topics: [] })
    ));
    const r = await intent.analyzeInteraction('hi', []);
    expect(r.sentimentConfidence).toBe(0.5);
  });

  it('coerces an invalid intent to "other"', async () => {
    mockChatCompletion.mockResolvedValue(fakeApiResponse(
      JSON.stringify({ ...fakeAiJson, intent: 'wibble' })
    ));
    const r = await intent.analyzeInteraction('hi', []);
    expect(r.intent).toBe('other');
  });

  it('returns sane defaults when JSON parsing fails entirely', async () => {
    mockChatCompletion.mockResolvedValue(fakeApiResponse('totally not json'));
    const r = await intent.analyzeInteraction('hi', []);
    expect(r.sentiment).toBe('neutral');
    expect(r.sentimentScore).toBe(0);
    expect(r.intent).toBe('other');
    expect(r.topics).toEqual([]);
  });

  it('uses the keyword bucket result without including bucket section in the AI prompt', async () => {
    const billing = { _id: 'b1', name: 'Billing', keywords: ['refund'], isDefault: false };
    const general = { _id: 'g1', name: 'General', keywords: [], isDefault: true };

    mockChatCompletion.mockResolvedValue(fakeApiResponse(JSON.stringify(fakeAiJson)));
    const r = await intent.analyzeInteraction('I want a refund', [billing, general]);

    expect(r.bucketResult).toEqual({ bucketId: 'b1', method: 'keyword' });

    // The system prompt should NOT include the bucket section because keyword already won.
    const sentSystemPrompt = mockChatCompletion.mock.calls[0][0].messages[0].content;
    expect(sentSystemPrompt).not.toMatch(/Bucket categories/);
  });

  it('includes the bucket section in the prompt when no keyword match and resolves AI choice', async () => {
    const billing = { _id: 'b1', name: 'Billing', keywords: ['refund'], isDefault: false };
    const support = { _id: 's1', name: 'Support', keywords: ['broken'], isDefault: false };
    const general = { _id: 'g1', name: 'General', keywords: [], isDefault: true };

    mockChatCompletion.mockResolvedValue(fakeApiResponse(
      JSON.stringify({ ...fakeAiJson, bucketName: 'Support' })
    ));
    const r = await intent.analyzeInteraction('something weird', [billing, support, general]);

    expect(r.bucketResult).toEqual({ bucketId: 's1', method: 'ai' });
    const sentSystemPrompt = mockChatCompletion.mock.calls[0][0].messages[0].content;
    expect(sentSystemPrompt).toMatch(/Bucket categories/);
  });

  it('falls back to the default bucket when AI bucketName is unknown', async () => {
    const billing = { _id: 'b1', name: 'Billing', keywords: ['refund'], isDefault: false };
    const general = { _id: 'g1', name: 'General', keywords: [], isDefault: true };

    mockChatCompletion.mockResolvedValue(fakeApiResponse(
      JSON.stringify({ ...fakeAiJson, bucketName: 'Mystery' })
    ));
    const r = await intent.analyzeInteraction('weird', [billing, general]);
    expect(r.bucketResult).toEqual({ bucketId: 'g1', method: 'default' });
  });
});

describe('resolveIntentBucketWithoutAi', () => {
  it('keyword match wins; no LLM', () => {
    const buckets = [
      { _id: 'b1', name: 'Ship', keywords: ['delivery', 'ship'], isDefault: false },
      { _id: 'g1', name: 'Gen', keywords: [], isDefault: true }
    ];
    expect(intent.resolveIntentBucketWithoutAi('Where is my delivery', buckets)).toEqual({
      bucketId: 'b1',
      method: 'keyword'
    });
    expect(mockChatCompletion).not.toHaveBeenCalled();
  });

  it('ignores null / invalid bucket rows', () => {
    const buckets = [
      null,
      { _id: 'b1', name: 'Ship', keywords: ['delivery'], isDefault: false }
    ];
    expect(intent.resolveIntentBucketWithoutAi('delivery help', buckets)).toEqual({ bucketId: 'b1', method: 'keyword' });
  });

  it('uses default bucket when no keyword match', () => {
    const buckets = [
      { _id: 'b1', name: 'Ship', keywords: ['delivery'], isDefault: false },
      { _id: 'g1', name: 'Gen', keywords: [], isDefault: true }
    ];
    expect(intent.resolveIntentBucketWithoutAi('hello there', buckets)).toEqual({
      bucketId: 'g1',
      method: 'default'
    });
    expect(mockChatCompletion).not.toHaveBeenCalled();
  });

  it('null bucketId when no default bucket exists', () => {
    const buckets = [{ _id: 'b1', name: 'Ship', keywords: ['only'], isDefault: false }];
    expect(intent.resolveIntentBucketWithoutAi('unmatched text', buckets)).toEqual({
      bucketId: null,
      method: 'default'
    });
  });
});
