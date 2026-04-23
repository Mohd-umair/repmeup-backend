/**
 * Behavioural tests for openaiClient.
 *
 * Covers:
 *   - Constructor reads env and exposes the right fields.
 *   - hasApiKey() respects empty/whitespace keys.
 *   - chatCompletion() POSTs to /v1/chat/completions with Bearer auth and
 *     default 30s timeout, and records usage into AiApiUsage when the
 *     response includes a `usage` block.
 *   - Usage is NOT recorded when the response omits `usage`.
 *   - logImageUsage / logVideoUsage forward to aiApiUsageService with the
 *     context defaults applied.
 *   - _mergeAiLogContext falls back to AsyncLocalStorage when overrides are
 *     missing, and lets explicit overrides win.
 */

jest.mock('axios', () => ({ post: jest.fn() }));

const mockRecordChatUsage = jest.fn();
const mockRecordImageUsage = jest.fn();
const mockRecordVideoUsage = jest.fn();
jest.mock('../../../../src/services/aiApiUsageService', () => ({
  recordChatUsage: (...a) => mockRecordChatUsage(...a),
  recordImageUsage: (...a) => mockRecordImageUsage(...a),
  recordVideoUsage: (...a) => mockRecordVideoUsage(...a)
}));

const mockGetAiRequestContext = jest.fn(() => ({}));
jest.mock('../../../../src/services/aiRequestContext', () => ({
  getAiRequestContext: () => mockGetAiRequestContext()
}));

// Need the real module-level singleton, which reads env at construct time.
// tests/setup.js seeds OPENAI_API_KEY=test-key-do-not-use before this file
// loads, so the client is constructed as "configured".
const axios = require('axios');
const openaiClient = require('../../../../src/services/ai/openaiClient');

beforeEach(() => {
  axios.post.mockReset();
  mockRecordChatUsage.mockReset();
  mockRecordImageUsage.mockReset();
  mockRecordVideoUsage.mockReset();
  mockGetAiRequestContext.mockReset().mockReturnValue({});
});

// ────────────────────────────────────────────────────────────────────────────
describe('constructor / env wiring', () => {
  it('exposes the configured URL and provider', () => {
    expect(openaiClient.url).toBe('https://api.openai.com/v1/chat/completions');
    expect(openaiClient.provider).toBe('openai');
  });

  it('populates apiKey from OPENAI_API_KEY', () => {
    expect(openaiClient.apiKey).toBe('test-key-do-not-use');
  });

  it('exposes normalized model ids for chat / classification / vision', () => {
    // tests/setup.js does NOT set OPENAI_MODEL/_CLASSIFICATION/_VISION, so
    // defaults apply. The values are whatever normalizeOpenAIModelId returns
    // for those defaults; we just assert they're non-empty strings.
    expect(typeof openaiClient.chatModel).toBe('string');
    expect(typeof openaiClient.classificationModel).toBe('string');
    expect(typeof openaiClient.visionModel).toBe('string');
    expect(openaiClient.classificationModel.length).toBeGreaterThan(0);
    expect(openaiClient.visionModel.length).toBeGreaterThan(0);
  });
});

// ────────────────────────────────────────────────────────────────────────────
describe('hasApiKey()', () => {
  it('returns true when the key is a non-empty string', () => {
    expect(openaiClient.hasApiKey()).toBe(true);
  });

  it('returns false when the key is empty / whitespace / missing', () => {
    const original = openaiClient.apiKey;

    openaiClient.apiKey = '';
    expect(openaiClient.hasApiKey()).toBe(false);

    openaiClient.apiKey = '    ';
    expect(openaiClient.hasApiKey()).toBe(false);

    openaiClient.apiKey = undefined;
    expect(openaiClient.hasApiKey()).toBe(false);

    openaiClient.apiKey = original;
  });
});

// ────────────────────────────────────────────────────────────────────────────
describe('_mergeAiLogContext()', () => {
  it('falls back to AsyncLocalStorage values when no override is given', () => {
    mockGetAiRequestContext.mockReturnValue({
      organizationId: 'org_1',
      userId: 'user_1',
      feature: 'inbox.auto_reply'
    });
    const ctx = openaiClient._mergeAiLogContext();
    expect(ctx).toEqual({
      organizationId: 'org_1',
      userId: 'user_1',
      feature: 'inbox.auto_reply',
      metadata: {}
    });
  });

  it('lets explicit overrides win over the ALS context', () => {
    mockGetAiRequestContext.mockReturnValue({
      organizationId: 'org_1', userId: 'user_1', feature: 'inbox.auto_reply'
    });
    const ctx = openaiClient._mergeAiLogContext({
      organizationId: 'org_2', feature: 'post.generate', metadata: { foo: 'bar' }
    });
    expect(ctx).toEqual({
      organizationId: 'org_2',
      userId: 'user_1',
      feature: 'post.generate',
      metadata: { foo: 'bar' }
    });
  });

  it('defaults feature to "unknown" when neither override nor store has one', () => {
    mockGetAiRequestContext.mockReturnValue({});
    const ctx = openaiClient._mergeAiLogContext();
    expect(ctx.feature).toBe('unknown');
  });
});

// ────────────────────────────────────────────────────────────────────────────
describe('chatCompletion()', () => {
  const baseBody = {
    model: 'gpt-4o',
    messages: [{ role: 'user', content: 'hi' }]
  };
  const okResponse = {
    data: {
      choices: [{ message: { content: 'hello back' } }],
      usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 }
    }
  };

  it('POSTs to the configured URL with Bearer auth and the 30s default timeout', async () => {
    axios.post.mockResolvedValue(okResponse);

    await openaiClient.chatCompletion(baseBody, {
      organizationId: 'org_1', userId: 'u1', feature: 'test.feature'
    });

    expect(axios.post).toHaveBeenCalledTimes(1);
    const [url, body, config] = axios.post.mock.calls[0];
    expect(url).toBe('https://api.openai.com/v1/chat/completions');
    expect(body).toBe(baseBody);
    expect(config.headers.Authorization).toBe(`Bearer ${openaiClient.apiKey}`);
    expect(config.headers['Content-Type']).toBe('application/json');
    expect(config.timeout).toBe(30000);
  });

  it('lets the caller override the axios config (e.g. a longer timeout)', async () => {
    axios.post.mockResolvedValue(okResponse);

    await openaiClient.chatCompletion(baseBody, {}, { timeout: 90_000 });

    const [, , config] = axios.post.mock.calls[0];
    expect(config.timeout).toBe(90_000);
    // Default header still present (merge, not replace)
    expect(config.headers.Authorization).toMatch(/^Bearer /);
  });

  it('records usage when the response carries a usage block', async () => {
    axios.post.mockResolvedValue(okResponse);

    await openaiClient.chatCompletion(baseBody, {
      organizationId: 'org_1', userId: 'u1', feature: 'test.feature', metadata: { k: 'v' }
    });

    expect(mockRecordChatUsage).toHaveBeenCalledTimes(1);
    const payload = mockRecordChatUsage.mock.calls[0][0];
    expect(payload).toEqual(expect.objectContaining({
      organizationId: 'org_1',
      userId: 'u1',
      feature: 'test.feature',
      model: 'gpt-4o',
      promptTokens: 10,
      completionTokens: 20,
      totalTokens: 30,
      promptMessages: baseBody.messages,
      completionText: 'hello back',
      metadata: { k: 'v' }
    }));
  });

  it('does NOT record usage when the response has no usage block', async () => {
    axios.post.mockResolvedValue({ data: { choices: [{ message: { content: 'ok' } }] } });
    await openaiClient.chatCompletion(baseBody, {});
    expect(mockRecordChatUsage).not.toHaveBeenCalled();
  });

  it('falls back to this.chatModel when requestBody.model is missing', async () => {
    axios.post.mockResolvedValue(okResponse);
    await openaiClient.chatCompletion(
      { messages: [{ role: 'user', content: 'hi' }] },
      {}
    );
    expect(mockRecordChatUsage.mock.calls[0][0].model).toBe(openaiClient.chatModel);
  });

  it('propagates network errors (does not swallow them)', async () => {
    axios.post.mockRejectedValue(new Error('ECONNRESET'));
    await expect(openaiClient.chatCompletion(baseBody, {})).rejects.toThrow('ECONNRESET');
    expect(mockRecordChatUsage).not.toHaveBeenCalled();
  });
});

// ────────────────────────────────────────────────────────────────────────────
describe('logImageUsage()', () => {
  it('forwards flattened token counts with org/user from ALS context', () => {
    // NOTE: _mergeAiLogContext always returns feature='unknown' when neither
    // overrides nor store provide one, so the `|| 'image.generation'`
    // fallback in logImageUsage never fires. We test actual behaviour.
    mockGetAiRequestContext.mockReturnValue({ organizationId: 'org_1', userId: 'u1' });

    openaiClient.logImageUsage('gpt-image-1', '1024x1024', 'hd', 'a sunset', {
      input_tokens: 100,
      output_tokens: 200,
      total_tokens: 300,
      input_tokens_details: { text_tokens: 40, image_tokens: 60 }
    });

    expect(mockRecordImageUsage).toHaveBeenCalledTimes(1);
    expect(mockRecordImageUsage.mock.calls[0][0]).toEqual(expect.objectContaining({
      organizationId: 'org_1',
      userId: 'u1',
      feature: 'unknown',
      model: 'gpt-image-1',
      size: '1024x1024',
      quality: 'hd',
      promptTokens: 100,
      inputTextTokens: 40,
      inputImageTokens: 60,
      completionTokens: 200,
      totalTokens: 300,
      metadata: { prompt: 'a sunset' }
    }));
  });

  it('coerces missing usage numbers to 0', () => {
    openaiClient.logImageUsage('gpt-image-1', '1024x1024', 'hd', '');
    const payload = mockRecordImageUsage.mock.calls[0][0];
    expect(payload.promptTokens).toBe(0);
    expect(payload.inputTextTokens).toBe(0);
    expect(payload.inputImageTokens).toBe(0);
    expect(payload.completionTokens).toBe(0);
    expect(payload.totalTokens).toBe(0);
  });

  it('truncates the prompt field in metadata to 3000 chars', () => {
    const longPrompt = 'x'.repeat(5000);
    openaiClient.logImageUsage('gpt-image-1', '1024x1024', 'hd', longPrompt);
    expect(mockRecordImageUsage.mock.calls[0][0].metadata.prompt).toHaveLength(3000);
  });

  it('respects feature override from the ALS context', () => {
    mockGetAiRequestContext.mockReturnValue({ feature: 'post.generateImage' });
    openaiClient.logImageUsage('gpt-image-1', '1024x1024', 'hd', '');
    expect(mockRecordImageUsage.mock.calls[0][0].feature).toBe('post.generateImage');
  });
});

// ────────────────────────────────────────────────────────────────────────────
describe('logVideoUsage()', () => {
  it('forwards model + durationSeconds with org/user from ALS context', () => {
    // Same dead-fallback caveat as logImageUsage.
    mockGetAiRequestContext.mockReturnValue({ organizationId: 'org_1', userId: 'u1' });
    openaiClient.logVideoUsage('sora-1', 8);

    expect(mockRecordVideoUsage).toHaveBeenCalledTimes(1);
    expect(mockRecordVideoUsage.mock.calls[0][0]).toEqual(expect.objectContaining({
      organizationId: 'org_1',
      userId: 'u1',
      feature: 'unknown',
      model: 'sora-1',
      durationSeconds: 8,
      metadata: {}
    }));
  });

  it('uses ALS feature when one is present', () => {
    mockGetAiRequestContext.mockReturnValue({ feature: 'post.generateVideo' });
    openaiClient.logVideoUsage('sora-1', 4);
    expect(mockRecordVideoUsage.mock.calls[0][0].feature).toBe('post.generateVideo');
  });
});
