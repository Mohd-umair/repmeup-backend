/**
 * Tests for brandContextService.
 *
 * Covers:
 *   - getBrandContext: no org → null, no config → null, assembles parts from
 *     BrandConfig with brandProfile + overrides precedence.
 *   - getVisualStyleContext: combines BrandConfig visual fields + aggregated
 *     reference-image analysis, returns null when nothing matches.
 *   - getReferenceOnlyContext:
 *       * empty org → empty shape
 *       * no reference images → empty shape
 *       * style cache HIT → skips vision call
 *       * style cache MISS → downloads refs, calls vision API, parses JSON,
 *         saves cache (non-blocking)
 *       * markdown-wrapped JSON is stripped before parse
 *       * JSON parse error → falls back to raw text
 */

jest.mock('axios', () => ({ get: jest.fn() }));

// Model mocks — state held inside the factory, exposed via globalThis.
jest.mock('../../../../src/models/BrandConfig', () => {
  const state = { findOneResult: null, updateOneMock: jest.fn(() => Promise.resolve()) };
  globalThis.__brandConfigState = state;
  return {
    findOne: () => ({
      select: () => ({ lean: async () => state.findOneResult }),
      lean: async () => state.findOneResult
    }),
    updateOne: (...args) => state.updateOneMock(...args)
  };
});

jest.mock('../../../../src/models/BrandReferenceImage', () => {
  const state = { findResult: [] };
  globalThis.__brandRefImgState = state;
  const chain = {
    sort: () => chain,
    limit: () => chain,
    lean: async () => state.findResult
  };
  return {
    find: () => chain
  };
});

jest.mock('../../../../src/services/ai/openaiClient', () => ({
  apiKey: 'test-key-do-not-use',
  visionModel: 'gpt-4o',
  hasApiKey: jest.fn(() => true),
  chatCompletion: jest.fn()
}));

const axios = require('axios');
const BrandConfig = require('../../../../src/models/BrandConfig');
const openaiClient = require('../../../../src/services/ai/openaiClient');
const {
  getBrandContext, getVisualStyleContext, getReferenceOnlyContext
} = require('../../../../src/services/ai/brandContextService');

const cfgState = globalThis.__brandConfigState;
const refState = globalThis.__brandRefImgState;

beforeEach(() => {
  axios.get.mockReset();
  openaiClient.chatCompletion.mockReset();
  cfgState.findOneResult = null;
  cfgState.updateOneMock.mockReset().mockResolvedValue();
  refState.findResult = [];
});

// ═══════════════════════════════════════════════════════════════════════════
// getBrandContext
// ═══════════════════════════════════════════════════════════════════════════
describe('getBrandContext()', () => {
  it('returns null when organizationId is missing', async () => {
    expect(await getBrandContext(null)).toBeNull();
    expect(await getBrandContext(undefined)).toBeNull();
    expect(await getBrandContext('')).toBeNull();
  });

  it('returns null when no BrandConfig exists', async () => {
    cfgState.findOneResult = null;
    expect(await getBrandContext('org_1')).toBeNull();
  });

  it('defaults tone to "professional" and emits just that line on a bare config', async () => {
    cfgState.findOneResult = {};
    expect(await getBrandContext('org_1')).toBe('Brand tone: professional.');
  });

  it('assembles all top-level fields', async () => {
    cfgState.findOneResult = {
      toneOfVoice: 'playful',
      personalityTags: ['bold', 'cheeky'],
      bannedWords: ['cheap', 'discount'],
      approvedHashtags: ['#repmeup', '#ai'],
      legalDisclaimers: '  Terms apply.  '
    };
    const ctx = await getBrandContext('org_1');
    expect(ctx).toContain('Brand tone: playful.');
    expect(ctx).toContain('Brand personality: bold, cheeky.');
    expect(ctx).toContain('Never use these words: cheap, discount.');
    expect(ctx).toContain('Prefer these hashtags when relevant: #repmeup, #ai.');
    expect(ctx).toContain('Include this disclaimer when relevant: Terms apply.');
  });

  it('lets brandProfileOverrides win over brandProfile', async () => {
    cfgState.findOneResult = {
      toneOfVoice: 'professional',
      brandProfile: {
        analyzedAt: new Date(),
        writingStyle: 'stiff',
        emojiUsage: 'heavy',
        recurringEmojis: ['🔥'],
        personalityDescriptors: ['formal'],
        hashtagStrategy: { avgCount: 10 },
        ctaStyle: ['hard-sell'],
        imageMood: 'corporate',
        colorPalette: ['#000']
      },
      brandProfileOverrides: {
        writingStyle: 'casual',
        emojiUsage: 'light',
        recurringEmojis: ['✨', '💜'],
        personalityDescriptors: ['friendly'],
        hashtagStrategy: { avgCount: 3 },
        ctaStyle: ['soft ask'],
        imageMood: 'warm',
        colorPalette: ['#fff', '#purple']
      }
    };
    const ctx = await getBrandContext('org_1');
    expect(ctx).toContain('Writing style: casual.');
    expect(ctx).toContain('Emoji usage: light.');
    expect(ctx).toContain('Frequently uses emojis: ✨, 💜.');
    expect(ctx).toContain('Brand character: friendly.');
    expect(ctx).toContain('Hashtag count: use approximately 3 hashtags per post.');
    expect(ctx).toContain('CTA style: soft ask.');
    expect(ctx).toContain('Visual mood: warm.');
    expect(ctx).toContain('Color palette: #fff, #purple.');
    // Originals NOT present
    expect(ctx).not.toContain('stiff');
    expect(ctx).not.toContain('corporate');
  });

  it('omits brandProfile parts when analyzedAt is missing', async () => {
    cfgState.findOneResult = {
      brandProfile: { writingStyle: 'casual' } // no analyzedAt
    };
    const ctx = await getBrandContext('org_1');
    expect(ctx).toBe('Brand tone: professional.');
  });

  it('omits emoji usage when set to "moderate" (default)', async () => {
    cfgState.findOneResult = {
      brandProfile: { analyzedAt: new Date(), emojiUsage: 'moderate' }
    };
    const ctx = await getBrandContext('org_1');
    expect(ctx).not.toMatch(/Emoji usage/);
  });

  it('returns null on DB errors (non-blocking)', async () => {
    BrandConfig.findOne = () => {
      throw new Error('mongo dead');
    };
    const ctx = await getBrandContext('org_1');
    expect(ctx).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// getVisualStyleContext
// ═══════════════════════════════════════════════════════════════════════════
describe('getVisualStyleContext()', () => {
  beforeEach(() => {
    // Re-register the mock .findOne (previous test may have overwritten it)
    BrandConfig.findOne = () => ({
      select: () => ({ lean: async () => cfgState.findOneResult }),
      lean: async () => cfgState.findOneResult
    });
  });

  it('returns null when organizationId missing', async () => {
    expect(await getVisualStyleContext(null)).toBeNull();
  });

  it('returns null when no config and no reference images', async () => {
    cfgState.findOneResult = null;
    refState.findResult = [];
    expect(await getVisualStyleContext('org_1')).toBeNull();
  });

  it('builds a block from brandProfile visual fields', async () => {
    cfgState.findOneResult = {
      brandProfile: {
        colorPalette: ['#111', '#eee'],
        visualComposition: 'centered hero',
        typographyStyle: 'bold sans',
        imageMood: 'minimal',
        logoPlacement: 'top-left'
      }
    };
    refState.findResult = [];
    const ctx = await getVisualStyleContext('org_1');
    expect(ctx).toContain('Visual style requirements');
    expect(ctx).toContain('Color palette: #111, #eee');
    expect(ctx).toContain('Composition: centered hero');
    expect(ctx).toContain('Typography: bold sans');
    expect(ctx).toContain('Mood: minimal');
    expect(ctx).toContain('Logo: top-left');
  });

  it('omits logo line when value is "none detected"', async () => {
    cfgState.findOneResult = {
      brandProfile: { logoPlacement: 'none detected', imageMood: 'calm' }
    };
    const ctx = await getVisualStyleContext('org_1');
    expect(ctx).not.toMatch(/Logo:/);
  });

  it('aggregates reference-image analysis when palette/comp/mood are missing', async () => {
    cfgState.findOneResult = null;
    refState.findResult = [
      { analysis: { dominantColors: ['red', 'blue'], compositionType: 'grid', mood: 'calm' } },
      { analysis: { dominantColors: ['red', 'green'], compositionType: 'grid', mood: 'energetic' } },
      { analysis: { dominantColors: ['red'], compositionType: 'hero', mood: 'calm' } }
    ];
    const ctx = await getVisualStyleContext('org_1');
    expect(ctx).toContain('Reference colors: red'); // red appears 3x → first
    expect(ctx).toContain('Reference composition: grid'); // grid has 2, hero 1
    expect(ctx).toContain('Reference mood: calm'); // calm 2, energetic 1
  });

  it('does NOT override existing palette/comp/mood with reference aggregates', async () => {
    cfgState.findOneResult = {
      brandProfile: { colorPalette: ['#fixed'], visualComposition: 'my layout', imageMood: 'my mood' }
    };
    refState.findResult = [
      { analysis: { dominantColors: ['other'], compositionType: 'xxx', mood: 'yyy' } }
    ];
    const ctx = await getVisualStyleContext('org_1');
    expect(ctx).toContain('Color palette: #fixed');
    expect(ctx).toContain('Composition: my layout');
    expect(ctx).toContain('Mood: my mood');
    expect(ctx).not.toMatch(/Reference colors:/);
    expect(ctx).not.toMatch(/Reference composition:/);
    expect(ctx).not.toMatch(/Reference mood:/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// getReferenceOnlyContext
// ═══════════════════════════════════════════════════════════════════════════
describe('getReferenceOnlyContext()', () => {
  beforeEach(() => {
    // Ensure BrandConfig.findOne works again
    BrandConfig.findOne = () => ({
      select: () => ({ lean: async () => cfgState.findOneResult }),
      lean: async () => cfgState.findOneResult
    });
  });

  it('returns empty shape when organizationId missing', async () => {
    expect(await getReferenceOnlyContext(null)).toEqual({
      stylePrompt: null, imageUrls: [], styleSpec: null
    });
  });

  it('returns empty shape when there are no reference images', async () => {
    refState.findResult = [];
    const result = await getReferenceOnlyContext('org_1');
    expect(result).toEqual({ stylePrompt: null, imageUrls: [], styleSpec: null });
    expect(openaiClient.chatCompletion).not.toHaveBeenCalled();
  });

  describe('style cache HIT', () => {
    it('skips vision + download when cache is valid and hash matches', async () => {
      refState.findResult = [
        { imageUrl: 'https://cdn/a.jpg' },
        { imageUrl: 'https://cdn/b.jpg' }
      ];
      const imageUrls = ['https://cdn/a.jpg', 'https://cdn/b.jpg'];
      const crypto = require('crypto');
      const imageUrlsHash = crypto
        .createHash('md5')
        .update(imageUrls.join('|') + 'v2-no-text')
        .digest('hex');

      cfgState.findOneResult = {
        styleCache: {
          spec: 'CACHED style prompt',
          imageUrlsHash,
          analyzedAt: new Date()
        }
      };

      const result = await getReferenceOnlyContext('org_1');

      expect(result.stylePrompt).toBe('CACHED style prompt');
      expect(result.imageUrls).toEqual(imageUrls);
      expect(result.styleSpec).toBeNull();
      expect(axios.get).not.toHaveBeenCalled();
      expect(openaiClient.chatCompletion).not.toHaveBeenCalled();
    });

    it('misses when the hash does not match (refs changed)', async () => {
      refState.findResult = [{ imageUrl: 'https://cdn/a.jpg' }];
      cfgState.findOneResult = {
        styleCache: {
          spec: 'STALE', imageUrlsHash: 'wrong-hash', analyzedAt: new Date()
        }
      };
      axios.get.mockResolvedValue({
        data: Buffer.from('img'),
        headers: { 'content-type': 'image/jpeg' }
      });
      openaiClient.chatCompletion.mockResolvedValue({
        data: { choices: [{ message: { content: '{"style":"x","mood":"calm"}' } }] }
      });

      const result = await getReferenceOnlyContext('org_1');
      expect(result.stylePrompt).not.toBe('STALE');
      expect(openaiClient.chatCompletion).toHaveBeenCalled();
    });

    it('misses when cache is older than 24h', async () => {
      refState.findResult = [{ imageUrl: 'https://cdn/a.jpg' }];
      const crypto = require('crypto');
      const imageUrlsHash = crypto
        .createHash('md5')
        .update('https://cdn/a.jpg' + 'v2-no-text')
        .digest('hex');
      cfgState.findOneResult = {
        styleCache: {
          spec: 'OLD', imageUrlsHash,
          analyzedAt: new Date(Date.now() - 25 * 60 * 60 * 1000)
        }
      };
      axios.get.mockResolvedValue({
        data: Buffer.from('img'), headers: { 'content-type': 'image/jpeg' }
      });
      openaiClient.chatCompletion.mockResolvedValue({
        data: { choices: [{ message: { content: '{"style":"x"}' } }] }
      });

      const result = await getReferenceOnlyContext('org_1');
      expect(result.stylePrompt).not.toBe('OLD');
      expect(openaiClient.chatCompletion).toHaveBeenCalled();
    });
  });

  describe('style cache MISS — vision analysis', () => {
    beforeEach(() => {
      refState.findResult = [
        { imageUrl: 'https://cdn/1.jpg' },
        { imageUrl: 'https://cdn/2.jpg' },
        { imageUrl: 'https://cdn/3.jpg' }
      ];
      cfgState.findOneResult = null;
      axios.get.mockResolvedValue({
        data: Buffer.from('imgbytes'),
        headers: { 'content-type': 'image/png' }
      });
    });

    it('downloads up to 3 images and calls chat completion with the vision model', async () => {
      openaiClient.chatCompletion.mockResolvedValue({
        data: {
          choices: [{ message: {
            content: JSON.stringify({
              medium: 'graphic design',
              style: 'bold flat vector',
              colorPalette: ['#ff0', '#f0f'],
              background: 'solid purple',
              layout: 'centered',
              typography: 'bold sans',
              mood: 'energetic'
            })
          } }]
        }
      });

      const result = await getReferenceOnlyContext('org_1');

      expect(axios.get).toHaveBeenCalledTimes(3);
      expect(openaiClient.chatCompletion).toHaveBeenCalledTimes(1);
      const [body, ctx, config] = openaiClient.chatCompletion.mock.calls[0];
      expect(body.model).toBe('gpt-4o');
      expect(body.max_tokens).toBe(800);
      // 3 images attached to user content
      const userContent = body.messages[1].content;
      expect(userContent.filter((c) => c.type === 'image_url')).toHaveLength(3);
      expect(userContent[1].image_url.url).toMatch(/^data:image\/png;base64,/);
      expect(ctx).toEqual({ feature: 'content_studio.reference_style_analysis' });
      expect(config).toEqual({ timeout: 45000 });

      // Final prompt block includes parsed fields
      expect(result.stylePrompt).toContain('CRITICAL — You MUST replicate this EXACT visual style');
      expect(result.stylePrompt).toContain('Medium: graphic design');
      expect(result.stylePrompt).toContain('Style: bold flat vector');
      expect(result.stylePrompt).toContain('Color palette: #ff0, #f0f');
      expect(result.stylePrompt).toContain('Layout: centered');
      expect(result.stylePrompt).toContain('Mood: energetic');
      expect(result.styleSpec).toEqual(expect.objectContaining({ style: 'bold flat vector' }));

      // Passes top-2 URLs
      expect(result.imageUrls).toEqual(['https://cdn/1.jpg', 'https://cdn/2.jpg']);

      // Cache save is attempted (non-blocking)
      expect(cfgState.updateOneMock).toHaveBeenCalledWith(
        { organization: 'org_1' },
        expect.objectContaining({
          $set: expect.objectContaining({
            styleCache: expect.objectContaining({ spec: result.stylePrompt })
          })
        }),
        { upsert: false }
      );
    });

    it('strips markdown fences before JSON parse', async () => {
      openaiClient.chatCompletion.mockResolvedValue({
        data: {
          choices: [{ message: {
            content: '```json\n{"style":"wrapped","mood":"calm"}\n```'
          } }]
        }
      });

      const result = await getReferenceOnlyContext('org_1');
      expect(result.styleSpec).toEqual({ style: 'wrapped', mood: 'calm' });
      expect(result.stylePrompt).toContain('Style: wrapped');
    });

    it('falls back to raw text when JSON parse fails', async () => {
      openaiClient.chatCompletion.mockResolvedValue({
        data: { choices: [{ message: { content: 'this is not json at all' } }] }
      });

      const result = await getReferenceOnlyContext('org_1');
      expect(result.styleSpec).toBeNull();
      expect(result.stylePrompt).toContain('STYLE SPECIFICATION from reference images');
      expect(result.stylePrompt).toContain('this is not json at all');
    });

    it('returns null stylePrompt when vision returns no content', async () => {
      openaiClient.chatCompletion.mockResolvedValue({
        data: { choices: [{ message: {} }] }
      });
      const result = await getReferenceOnlyContext('org_1');
      expect(result).toEqual({
        stylePrompt: null,
        imageUrls: ['https://cdn/1.jpg', 'https://cdn/2.jpg'],
        styleSpec: null
      });
    });

    it('survives individual image download failures', async () => {
      axios.get
        .mockRejectedValueOnce(new Error('404'))
        .mockResolvedValueOnce({ data: Buffer.from('ok'), headers: { 'content-type': 'image/jpeg' } })
        .mockRejectedValueOnce(new Error('timeout'));
      openaiClient.chatCompletion.mockResolvedValue({
        data: { choices: [{ message: { content: '{"style":"x"}' } }] }
      });

      const result = await getReferenceOnlyContext('org_1');
      // One image was attached even though 2 failed
      const body = openaiClient.chatCompletion.mock.calls[0][0];
      const userContent = body.messages[1].content;
      expect(userContent.filter((c) => c.type === 'image_url')).toHaveLength(1);
      expect(result.stylePrompt).toContain('Style: x');
    });

    it('returns { stylePrompt: null, imageUrls } when ALL image downloads fail', async () => {
      axios.get.mockRejectedValue(new Error('404'));
      const result = await getReferenceOnlyContext('org_1');
      expect(result.stylePrompt).toBeNull();
      expect(result.imageUrls).toEqual(['https://cdn/1.jpg', 'https://cdn/2.jpg']);
      expect(openaiClient.chatCompletion).not.toHaveBeenCalled();
    });
  });

  it('returns empty shape on any fatal error (non-blocking)', async () => {
    refState.findResult = [{ imageUrl: 'https://cdn/a.jpg' }];
    axios.get.mockResolvedValue({ data: Buffer.from('x'), headers: { 'content-type': 'image/jpeg' } });
    openaiClient.chatCompletion.mockRejectedValue(new Error('rate limit'));

    const result = await getReferenceOnlyContext('org_1');
    expect(result).toEqual({ stylePrompt: null, imageUrls: [], styleSpec: null });
  });
});
