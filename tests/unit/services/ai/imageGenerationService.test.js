/**
 * Tests for imageGenerationService.
 *
 * Covers:
 *   - Transient-error classification (isTransientImageGenError).
 *   - Endpoint routing: /images/generations vs /images/edits when reference
 *     images are present (referenceOnly mode).
 *   - Brand + occasion + enforcement prompt layering.
 *   - Retry loop: transient errors retry up to maxAttempts with exponential
 *     backoff; non-transient errors return null immediately.
 *   - Success paths: base64 response, URL response (secondary GET).
 *   - Usage is logged after a successful generation.
 *   - api-key gating, prompt truncation.
 */

jest.mock('axios', () => ({ post: jest.fn(), get: jest.fn() }));

jest.mock('../../../../src/services/ai/openaiClient', () => ({
  apiKey: 'test-key-do-not-use',
  hasApiKey: jest.fn(() => true),
  logImageUsage: jest.fn()
}));

jest.mock('../../../../src/services/ai/brandContextService', () => ({
  getVisualStyleContext: jest.fn(),
  getReferenceOnlyContext: jest.fn()
}));

// Organization and designMemoryService are lazy-required inside the module;
// we mock them through jest.doMock so they're intercepted on require().
jest.mock('../../../../src/models/Organization', () => ({
  findById: jest.fn(() => ({
    select: () => ({ lean: async () => null })
  }))
}));

jest.mock('../../../../src/services/designMemoryService', () => ({
  getTopStyleSpecs: jest.fn(async () => [])
}));

const axios = require('axios');
const openaiClient = require('../../../../src/services/ai/openaiClient');
const brandContextService = require('../../../../src/services/ai/brandContextService');
const Organization = require('../../../../src/models/Organization');
const designMemoryService = require('../../../../src/services/designMemoryService');
const {
  generateImage, isTransientImageGenError
} = require('../../../../src/services/ai/imageGenerationService');

beforeEach(() => {
  jest.useFakeTimers();
  axios.post.mockReset();
  axios.get.mockReset();
  openaiClient.hasApiKey.mockReset().mockReturnValue(true);
  openaiClient.logImageUsage.mockReset();
  brandContextService.getVisualStyleContext.mockReset().mockResolvedValue(null);
  brandContextService.getReferenceOnlyContext.mockReset().mockResolvedValue({
    stylePrompt: null, imageUrls: [], styleSpec: null
  });
  Organization.findById.mockReset().mockReturnValue({
    select: () => ({ lean: async () => null })
  });
  designMemoryService.getTopStyleSpecs.mockReset().mockResolvedValue([]);
  delete process.env.OPENAI_IMAGE_MODEL;
  delete process.env.OPENAI_IMAGE_MAX_RETRIES;
  delete process.env.OPENAI_IMAGE_TIMEOUT_MS;
});

afterEach(() => {
  jest.useRealTimers();
});

// Helper: let the retry loop's backoff sleeps flush against fake timers.
async function flushRetries(promise, steps = 10) {
  let settled = false;
  let result, error;
  promise.then(
    (v) => { settled = true; result = v; },
    (e) => { settled = true; error = e; }
  );
  for (let i = 0; i < steps && !settled; i += 1) {
    await Promise.resolve();
    await Promise.resolve();
    jest.advanceTimersByTime(16000); // max backoff step
  }
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
  if (error) throw error;
  return result;
}

// ────────────────────────────────────────────────────────────────────────────
describe('isTransientImageGenError()', () => {
  it.each([
    [{ response: { status: 429 } }, true],
    [{ response: { status: 502 } }, true],
    [{ response: { status: 503 } }, true],
    [{ response: { status: 504 } }, true],
    [{ response: { status: 400 } }, false],
    [{ response: { status: 401 } }, false],
    [{ response: { status: 500 } }, false],   // 500 is NOT in the transient set
    [{ code: 'ECONNRESET' }, true],
    [{ code: 'ETIMEDOUT' }, true],
    [{ code: 'EPIPE' }, true],
    [{ code: 'ENOTFOUND' }, true],
    [{ code: 'EACCES' }, false],
    [{ message: 'socket hang up' }, true],
    [{ message: 'network error' }, true],
    [{ message: 'request timeout' }, true],
    [{ message: 'aborted' }, true],
    [{ message: 'invalid api key' }, false],
    [{}, false],
  ])('isTransientImageGenError(%j) → %s', (err, expected) => {
    expect(isTransientImageGenError(err)).toBe(expected);
  });
});

// ────────────────────────────────────────────────────────────────────────────
describe('api key gating', () => {
  it('returns null without calling OpenAI if no key is configured', async () => {
    openaiClient.hasApiKey.mockReturnValue(false);
    const result = await generateImage('anything');
    expect(result).toBeNull();
    expect(axios.post).not.toHaveBeenCalled();
  });
});

// ────────────────────────────────────────────────────────────────────────────
describe('happy path — text-only generation', () => {
  it('POSTs to /images/generations and returns buffer from base64', async () => {
    const b64 = Buffer.from('PNGBYTES').toString('base64');
    axios.post.mockResolvedValue({
      data: {
        data: [{ b64_json: b64 }],
        usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 }
      }
    });

    const result = await generateImage('a cat');

    expect(result).not.toBeNull();
    expect(result.buffer).toBeInstanceOf(Buffer);
    expect(result.buffer.toString()).toBe('PNGBYTES');
    expect(result.styleSpec).toBeNull();
    expect(result.imagePrompt).toContain('a cat');
    expect(result.imagePrompt).toContain('ABSOLUTE RULE — TEXT QUALITY');

    expect(axios.post).toHaveBeenCalledWith(
      'https://api.openai.com/v1/images/generations',
      expect.objectContaining({ model: 'gpt-image-1', n: 1, size: '1024x1024', quality: 'medium' }),
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer test-key-do-not-use' }),
        timeout: 120000
      })
    );
    expect(openaiClient.logImageUsage).toHaveBeenCalledWith(
      'gpt-image-1', '1024x1024', 'medium', expect.any(String),
      { input_tokens: 10, output_tokens: 20, total_tokens: 30 }
    );
  });

  it('downloads from URL when b64_json is missing', async () => {
    axios.post.mockResolvedValue({
      data: { data: [{ url: 'https://cdn.openai.com/img/xyz.png' }] }
    });
    axios.get.mockResolvedValue({ data: Buffer.from('DOWNLOADED') });

    const result = await generateImage('a dog');

    expect(result.buffer.toString()).toBe('DOWNLOADED');
    expect(axios.get).toHaveBeenCalledWith(
      'https://cdn.openai.com/img/xyz.png',
      expect.objectContaining({
        responseType: 'arraybuffer',
        timeout: 60000
      })
    );
  });

  it('returns null when neither b64 nor url present', async () => {
    axios.post.mockResolvedValue({ data: { data: [{}] } });
    const result = await generateImage('x');
    expect(result).toBeNull();
    expect(openaiClient.logImageUsage).not.toHaveBeenCalled();
  });

  it('honours OPENAI_IMAGE_MODEL env override', async () => {
    process.env.OPENAI_IMAGE_MODEL = 'gpt-image-custom';
    axios.post.mockResolvedValue({
      data: { data: [{ b64_json: Buffer.from('X').toString('base64') }] }
    });
    await generateImage('x');
    expect(axios.post.mock.calls[0][1].model).toBe('gpt-image-custom');
  });
});

// ────────────────────────────────────────────────────────────────────────────
describe('reference-only endpoint routing', () => {
  it('uses /images/edits when reference images are present', async () => {
    brandContextService.getReferenceOnlyContext.mockResolvedValue({
      stylePrompt: 'Brand style: vintage',
      imageUrls: ['https://cdn/ref1.jpg', 'https://cdn/ref2.jpg'],
      styleSpec: { layoutType: 'grid' }
    });
    axios.post.mockResolvedValue({
      data: { data: [{ b64_json: Buffer.from('Y').toString('base64') }] }
    });

    const result = await generateImage('a sunset', 'org_1', { referenceOnly: true });

    expect(axios.post).toHaveBeenCalledWith(
      'https://api.openai.com/v1/images/edits',
      expect.objectContaining({
        images: [
          { image_url: 'https://cdn/ref1.jpg' },
          { image_url: 'https://cdn/ref2.jpg' }
        ]
      }),
      expect.any(Object)
    );
    // styleSpec is passed through
    expect(result.styleSpec).toEqual({ layoutType: 'grid' });
    // Brand style prompt prepended
    expect(result.imagePrompt).toContain('Brand style: vintage');
  });

  it('uses text style context (not references) in non-referenceOnly mode', async () => {
    brandContextService.getVisualStyleContext.mockResolvedValue('Brand vibe: minimal');
    axios.post.mockResolvedValue({
      data: { data: [{ b64_json: Buffer.from('z').toString('base64') }] }
    });

    const result = await generateImage('a logo', 'org_1');

    expect(axios.post.mock.calls[0][0]).toBe('https://api.openai.com/v1/images/generations');
    expect(result.imagePrompt).toContain('Brand vibe: minimal');
    // getReferenceOnlyContext NOT used in non-ref mode
    expect(brandContextService.getReferenceOnlyContext).not.toHaveBeenCalled();
  });

  it('appends the org logo as a trailing reference image when present', async () => {
    Organization.findById.mockReturnValue({
      select: () => ({ lean: async () => ({ logo: 'https://cdn/logo.png' }) })
    });
    brandContextService.getReferenceOnlyContext.mockResolvedValue({
      stylePrompt: null, imageUrls: ['https://cdn/r1.jpg'], styleSpec: null
    });
    axios.post.mockResolvedValue({
      data: { data: [{ b64_json: Buffer.from('a').toString('base64') }] }
    });

    await generateImage('a scene', 'org_1', { referenceOnly: true });

    expect(axios.post.mock.calls[0][1].images).toEqual([
      { image_url: 'https://cdn/r1.jpg' },
      { image_url: 'https://cdn/logo.png' }
    ]);
  });

  it('does not duplicate the logo if already in referenceImageUrls', async () => {
    Organization.findById.mockReturnValue({
      select: () => ({ lean: async () => ({ logo: 'https://cdn/logo.png' }) })
    });
    brandContextService.getReferenceOnlyContext.mockResolvedValue({
      stylePrompt: null, imageUrls: ['https://cdn/logo.png'], styleSpec: null
    });
    axios.post.mockResolvedValue({
      data: { data: [{ b64_json: Buffer.from('a').toString('base64') }] }
    });

    await generateImage('a scene', 'org_1', { referenceOnly: true });

    expect(axios.post.mock.calls[0][1].images).toEqual([
      { image_url: 'https://cdn/logo.png' }
    ]);
  });
});

// ────────────────────────────────────────────────────────────────────────────
describe('prompt layering', () => {
  it('appends the text-enforcement suffix', async () => {
    axios.post.mockResolvedValue({
      data: { data: [{ b64_json: Buffer.from('x').toString('base64') }] }
    });
    const result = await generateImage('hi');
    expect(result.imagePrompt).toMatch(/ABSOLUTE RULE — TEXT QUALITY/);
  });

  it('appends occasion visual style block when provided', async () => {
    axios.post.mockResolvedValue({
      data: { data: [{ b64_json: Buffer.from('x').toString('base64') }] }
    });
    const result = await generateImage('hi', null, {
      occasionVisualStyle: {
        dominantColors: ['red', 'gold'],
        mood: 'festive',
        layoutPattern: 'centered hero',
        typography: 'serif',
        decorativeElements: ['fireworks']
      }
    });
    expect(result.imagePrompt).toMatch(/Occasion visual style/);
    expect(result.imagePrompt).toMatch(/Dominant colors: red, gold/);
    expect(result.imagePrompt).toMatch(/Visual mood: festive/);
    expect(result.imagePrompt).toMatch(/Layout: centered hero/);
    expect(result.imagePrompt).toMatch(/Decorative elements: fireworks/);
  });

  it('uses default prompt when given empty string', async () => {
    axios.post.mockResolvedValue({
      data: { data: [{ b64_json: Buffer.from('x').toString('base64') }] }
    });
    const result = await generateImage('');
    expect(result.imagePrompt).toMatch(/Professional social media post image/);
  });

  it('truncates the final prompt to 4000 chars', async () => {
    axios.post.mockResolvedValue({
      data: { data: [{ b64_json: Buffer.from('x').toString('base64') }] }
    });
    const result = await generateImage('a'.repeat(10000));
    expect(result.imagePrompt.length).toBeLessThanOrEqual(4000);
  });
});

// ────────────────────────────────────────────────────────────────────────────
describe('retry logic', () => {
  it('retries a transient error and succeeds on attempt 2', async () => {
    const err = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    axios.post
      .mockRejectedValueOnce(err)
      .mockResolvedValueOnce({
        data: { data: [{ b64_json: Buffer.from('OK').toString('base64') }] }
      });

    const result = await flushRetries(generateImage('x'));

    expect(result).not.toBeNull();
    expect(result.buffer.toString()).toBe('OK');
    expect(axios.post).toHaveBeenCalledTimes(2);
  });

  it('does not retry non-transient errors (4xx, auth)', async () => {
    axios.post.mockRejectedValue({
      response: { status: 400, data: { error: { message: 'bad prompt' } } },
      message: 'Request failed with status code 400'
    });

    const result = await generateImage('x');

    expect(result).toBeNull();
    expect(axios.post).toHaveBeenCalledTimes(1);
  });

  it('stops after maxAttempts and returns null', async () => {
    process.env.OPENAI_IMAGE_MAX_RETRIES = '2';
    const err = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    axios.post.mockRejectedValue(err);

    const result = await flushRetries(generateImage('x'));

    expect(result).toBeNull();
    expect(axios.post).toHaveBeenCalledTimes(2);
  });

  it('clamps OPENAI_IMAGE_MAX_RETRIES above the max (5)', async () => {
    process.env.OPENAI_IMAGE_MAX_RETRIES = '99';
    const err = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    axios.post.mockRejectedValue(err);

    const result = await flushRetries(generateImage('x'), 30);

    expect(result).toBeNull();
    expect(axios.post).toHaveBeenCalledTimes(5);
  });
});

// ────────────────────────────────────────────────────────────────────────────
describe('design memory blending (referenceOnly)', () => {
  it('appends top-style hints to the prompt when available', async () => {
    brandContextService.getReferenceOnlyContext.mockResolvedValue({
      stylePrompt: 'Spec', imageUrls: ['https://cdn/a.jpg'], styleSpec: { layoutType: 'grid' }
    });
    designMemoryService.getTopStyleSpecs.mockResolvedValue([
      { layoutType: 'grid', colors: ['#ff0', '#f0f'], style: 'flat', medium: 'illustration', designScore: 92 },
      { layoutType: 'hero', colors: [], style: 'bold', designScore: 88 }
    ]);
    axios.post.mockResolvedValue({
      data: { data: [{ b64_json: Buffer.from('x').toString('base64') }] }
    });

    const result = await generateImage('hi', 'org_1', { referenceOnly: true });

    expect(result.imagePrompt).toMatch(/High-performing design patterns for this brand/);
    expect(result.imagePrompt).toMatch(/engagement score: 92/);
  });

  it('returns the base prompt unchanged if design memory throws', async () => {
    brandContextService.getReferenceOnlyContext.mockResolvedValue({
      stylePrompt: null, imageUrls: ['https://cdn/a.jpg'], styleSpec: null
    });
    designMemoryService.getTopStyleSpecs.mockRejectedValue(new Error('mongo dead'));
    axios.post.mockResolvedValue({
      data: { data: [{ b64_json: Buffer.from('x').toString('base64') }] }
    });

    const result = await generateImage('base topic', 'org_1', { referenceOnly: true });
    expect(result).not.toBeNull();
    expect(result.imagePrompt).not.toMatch(/High-performing design patterns/);
  });
});
