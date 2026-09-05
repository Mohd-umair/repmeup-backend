/**
 * Tests for postGenerationService.
 *
 * Covers:
 *   - Platform guidelines selection per postType (post/story/reel).
 *   - generatePost 'same' vs 'custom' mode (single call vs per-platform loop).
 *   - Brand context injection when organizationId is present.
 *   - generatePostVariants:
 *       * clamps count to MAX_VARIANTS (5)
 *       * uses different temperatures per variant (0.7 / 0.85 / 0.95)
 *       * skips brand context in 'instant' mode, uses it in 'brand-voice' mode
 *       * drops empty / failed variants from the result
 *       * includes occasion context in system prompt when provided
 *       * appends audience/intent/mood/trend to user prompt
 *   - generateEventPost composites brand + event template + user intent.
 */

jest.mock('../../../../src/services/ai/openaiClient', () => ({
  chatModel: 'gpt-4o',
  hasApiKey: jest.fn(() => true),
  chatCompletion: jest.fn()
}));

jest.mock('../../../../src/services/ai/brandContextService', () => ({
  getBrandContext: jest.fn(),
  getVisualStyleContext: jest.fn()
}));

jest.mock('../../../../src/services/aiRequestContext', () => ({
  runWithAiContext: (ctx, fn) => fn(),
  getAiRequestContext: () => ({})
}));

jest.mock('../../../../src/models/EventTemplate', () => {
  const state = { findByIdResult: null };
  globalThis.__eventTemplateState = state;
  return {
    findById: () => ({ lean: async () => state.findByIdResult })
  };
});

const openaiClient = require('../../../../src/services/ai/openaiClient');
const brandContextService = require('../../../../src/services/ai/brandContextService');
const {
  generatePost, generatePostVariants, generateEventPost, _internal
} = require('../../../../src/services/ai/postGenerationService');
// Force the EventTemplate mock factory to run so __eventTemplateState is set.
require('../../../../src/models/EventTemplate');

const eventState = globalThis.__eventTemplateState;

const okChatResponse = (text = 'Generated!') => ({
  data: { choices: [{ message: { content: text } }] }
});

beforeEach(() => {
  openaiClient.hasApiKey.mockReset().mockReturnValue(true);
  openaiClient.chatCompletion.mockReset();
  brandContextService.getBrandContext.mockReset().mockResolvedValue(null);
  brandContextService.getVisualStyleContext.mockReset().mockResolvedValue(null);
  eventState.findByIdResult = null;
});

// ═══════════════════════════════════════════════════════════════════════════
describe('_internal.getPlatformGuidelines()', () => {
  it('picks the "story" flavour when postType=story', () => {
    const g = _internal.getPlatformGuidelines(['instagram', 'facebook'], 'story');
    expect(g).toMatch(/Instagram Story/);
    expect(g).toMatch(/Facebook Story/);
    expect(g).not.toMatch(/2200 char/); // That's the default Instagram line
  });

  it('picks the "reel" flavour when postType=reel', () => {
    const g = _internal.getPlatformGuidelines(['instagram', 'facebook'], 'reel');
    expect(g).toMatch(/Instagram Reel/);
    expect(g).toMatch(/Facebook Reel/);
  });

  it('defaults to the "post" flavour', () => {
    const g = _internal.getPlatformGuidelines(['instagram'], 'post');
    expect(g).toMatch(/2200 char max/);
  });

  it('always uses the same LinkedIn guideline regardless of postType', () => {
    expect(_internal.getPlatformGuidelines(['linkedin'], 'story')).toMatch(/LinkedIn: Professional tone/);
    expect(_internal.getPlatformGuidelines(['linkedin'], 'reel')).toMatch(/LinkedIn: Professional tone/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('generatePost()', () => {
  it('throws when no API key is configured', async () => {
    openaiClient.hasApiKey.mockReturnValue(false);
    await expect(generatePost('p', ['instagram'])).rejects.toThrow('OpenAI API key is not configured');
  });

  it('same mode: one call, posts.all carries the content, 1 credit', async () => {
    openaiClient.chatCompletion.mockResolvedValue(okChatResponse('  my post  '));

    const result = await generatePost('about our sale', ['instagram', 'facebook']);

    expect(openaiClient.chatCompletion).toHaveBeenCalledTimes(1);
    expect(result.mode).toBe('same');
    expect(result.posts).toEqual({ all: 'my post' }); // trimmed
    expect(result.creditsUsed).toBe(1);
  });

  it('custom mode: one call per platform, creditsUsed=platforms.length', async () => {
    openaiClient.chatCompletion
      .mockResolvedValueOnce(okChatResponse('ig post'))
      .mockResolvedValueOnce(okChatResponse('fb post'));

    const result = await generatePost('x', ['instagram', 'facebook'], 'custom');

    expect(openaiClient.chatCompletion).toHaveBeenCalledTimes(2);
    expect(result.mode).toBe('custom');
    expect(result.posts).toEqual({ instagram: 'ig post', facebook: 'fb post' });
    expect(result.creditsUsed).toBe(2);

    // First call's system prompt mentions only instagram
    const firstSys = openaiClient.chatCompletion.mock.calls[0][0].messages[0].content;
    const secondSys = openaiClient.chatCompletion.mock.calls[1][0].messages[0].content;
    expect(firstSys).toMatch(/instagram/);
    expect(firstSys).not.toMatch(/facebook/);
    expect(secondSys).toMatch(/facebook/);
    expect(secondSys).not.toMatch(/instagram/);
  });

  it('injects brand context into the system prompt when organizationId is present', async () => {
    brandContextService.getBrandContext.mockResolvedValue('Brand tone: bold.');
    openaiClient.chatCompletion.mockResolvedValue(okChatResponse('p'));

    await generatePost('hi', ['instagram'], 'same', 'post', 'org_1');

    expect(brandContextService.getBrandContext).toHaveBeenCalledWith('org_1');
    const sys = openaiClient.chatCompletion.mock.calls[0][0].messages[0].content;
    expect(sys).toContain('Brand guidelines (follow strictly):');
    expect(sys).toContain('Brand tone: bold.');
  });

  it('does NOT fetch brand context when organizationId is null', async () => {
    openaiClient.chatCompletion.mockResolvedValue(okChatResponse('p'));
    await generatePost('hi', ['instagram']);
    expect(brandContextService.getBrandContext).not.toHaveBeenCalled();
  });

  it('re-throws and logs when chatCompletion rejects', async () => {
    openaiClient.chatCompletion.mockRejectedValue(new Error('rate limit'));
    await expect(generatePost('hi', ['instagram'])).rejects.toThrow('rate limit');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('generatePostVariants()', () => {
  it('defaults to 3 variants using VARIANT_TEMPERATURES [0.7, 0.85, 0.95]', async () => {
    openaiClient.chatCompletion.mockImplementation((body) =>
      Promise.resolve(okChatResponse(`temp=${body.temperature}`))
    );

    const { variants } = await generatePostVariants('hi', ['instagram']);

    expect(variants).toHaveLength(3);
    expect(openaiClient.chatCompletion).toHaveBeenCalledTimes(3);
    const temps = openaiClient.chatCompletion.mock.calls.map((c) => c[0].temperature);
    expect(temps).toEqual([0.7, 0.85, 0.95]);
  });

  it('clamps count to MAX_VARIANTS (5) but only uses available VARIANT_TEMPERATURES slice', async () => {
    openaiClient.chatCompletion.mockResolvedValue(okChatResponse('v'));
    const { variants } = await generatePostVariants('hi', ['ig'], { count: 99 });
    // VARIANT_TEMPERATURES has only 3 entries — that caps actual calls.
    expect(variants).toHaveLength(3);
    expect(openaiClient.chatCompletion).toHaveBeenCalledTimes(3);
  });

  it('drops empty variants from the result', async () => {
    openaiClient.chatCompletion
      .mockResolvedValueOnce(okChatResponse('first'))
      .mockResolvedValueOnce(okChatResponse(''))      // empty after trim
      .mockRejectedValueOnce(new Error('timeout'));   // error → empty

    const { variants } = await generatePostVariants('hi', ['ig']);
    expect(variants).toEqual([{ content: 'first' }]);
  });

  it('instant mode (default) skips brand context', async () => {
    brandContextService.getBrandContext.mockResolvedValue('BRAND');
    openaiClient.chatCompletion.mockResolvedValue(okChatResponse('v'));

    await generatePostVariants('hi', ['ig'], { organizationId: 'org_1' });

    expect(brandContextService.getBrandContext).not.toHaveBeenCalled();
    const sys = openaiClient.chatCompletion.mock.calls[0][0].messages[0].content;
    expect(sys).not.toContain('BRAND');
  });

  it('brand-voice mode pulls brand context and injects it', async () => {
    brandContextService.getBrandContext.mockResolvedValue('Brand tone: warm.');
    openaiClient.chatCompletion.mockResolvedValue(okChatResponse('v'));

    await generatePostVariants('hi', ['ig'], {
      organizationId: 'org_1',
      generationMode: 'brand-voice'
    });

    expect(brandContextService.getBrandContext).toHaveBeenCalledWith('org_1');
    const sys = openaiClient.chatCompletion.mock.calls[0][0].messages[0].content;
    expect(sys).toContain('Brand tone: warm.');
  });

  it('reference mode does NOT pull brand context (visual style applied at image stage)', async () => {
    brandContextService.getBrandContext.mockResolvedValue('BRAND');
    openaiClient.chatCompletion.mockResolvedValue(okChatResponse('v'));

    await generatePostVariants('hi', ['ig'], {
      organizationId: 'org_1',
      generationMode: 'reference'
    });

    expect(brandContextService.getBrandContext).not.toHaveBeenCalled();
  });

  it('appends audience/intent/mood/trend hints to the user prompt', async () => {
    openaiClient.chatCompletion.mockResolvedValue(okChatResponse('v'));

    await generatePostVariants('Launch event', ['ig'], {
      audience: 'Gen Z shoppers',
      intent: 'Drive signups',
      mood: 'excited',
      includeTrend: true
    });

    const userPrompt = openaiClient.chatCompletion.mock.calls[0][0].messages[1].content;
    expect(userPrompt).toContain('Launch event');
    expect(userPrompt).toContain('Target audience: Gen Z shoppers.');
    expect(userPrompt).toContain('Content intent: Drive signups.');
    expect(userPrompt).toContain('Writing tone/mood: excited.');
    expect(userPrompt).toContain('current trend');
  });

  it('injects occasion context block when provided', async () => {
    openaiClient.chatCompletion.mockResolvedValue(okChatResponse('v'));

    await generatePostVariants('hi', ['ig'], {
      occasionContext: {
        name: 'Diwali',
        eventType: 'festival',
        sampleCaption: 'Wishing you light.',
        hashtags: ['#Diwali', '#Festival'],
        cta: 'Shop our festive drop.'
      }
    });

    const sys = openaiClient.chatCompletion.mock.calls[0][0].messages[0].content;
    expect(sys).toContain('Occasion: Diwali (festival).');
    expect(sys).toContain('Sample tone/caption: "Wishing you light."');
    expect(sys).toContain('Include these hashtags: #Diwali #Festival.');
    expect(sys).toContain('CTA style: Shop our festive drop.');
  });

  it('clamps negative temperatures to 0 and >1 to 1 (defence against count juggling)', async () => {
    // Can't trigger via public API (VARIANT_TEMPERATURES is fixed), so invoke
    // the internal helper directly.
    openaiClient.chatCompletion.mockResolvedValue(okChatResponse('v'));

    await _internal.generateSinglePostWithTemperature('sys', 'user', 2.5);
    expect(openaiClient.chatCompletion.mock.calls[0][0].temperature).toBe(1);

    openaiClient.chatCompletion.mockClear();
    await _internal.generateSinglePostWithTemperature('sys', 'user', -0.5);
    expect(openaiClient.chatCompletion.mock.calls[0][0].temperature).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('generateEventPost()', () => {
  it('throws when the event template is not found', async () => {
    eventState.findByIdResult = null;
    await expect(generateEventPost({
      organizationId: 'org_1', eventTemplateId: 'et_1', prompt: 'hi', platforms: ['ig']
    })).rejects.toThrow('Event template not found');
  });

  it('composites brand + event template + user prompt into text, returns imagePrompt separately', async () => {
    eventState.findByIdResult = {
      name: 'Diwali',
      eventType: 'festival',
      eventStyle: {
        dominantColors: ['gold', 'maroon'],
        decorativeElements: ['diyas', 'rangoli'],
        mood: 'festive',
        typography: 'ornate serif'
      }
    };
    brandContextService.getBrandContext.mockResolvedValue('Brand tone: joyful.');
    brandContextService.getVisualStyleContext.mockResolvedValue('Visual style: warm.');
    openaiClient.chatCompletion.mockResolvedValue(okChatResponse('Happy Diwali! 🪔 #Diwali'));

    const result = await generateEventPost({
      organizationId: 'org_1',
      eventTemplateId: 'et_1',
      prompt: 'Wishing everyone a bright Diwali',
      platforms: ['instagram'],
      userId: 'u1'
    });

    expect(result.text).toBe('Happy Diwali! 🪔 #Diwali');
    expect(result.imagePrompt).toContain('Create a social media post image for Diwali');
    expect(result.imagePrompt).toContain('Visual style: warm.');
    expect(result.imagePrompt).toContain('Event accent colors: gold, maroon');
    expect(result.imagePrompt).toContain('Content: "Wishing everyone a bright Diwali"');

    const textSys = openaiClient.chatCompletion.mock.calls[0][0].messages[0].content;
    expect(textSys).toContain('Write a Diwali post for instagram');
    expect(textSys).toContain('Brand tone: joyful.');
    expect(textSys).toContain('Event mood: festive');
  });

  it('falls back to "Event: {name}" when eventStyle has no descriptive fields', async () => {
    eventState.findByIdResult = {
      name: 'PlainEvent', eventType: 'promo', eventStyle: {}
    };
    openaiClient.chatCompletion.mockResolvedValue(okChatResponse('ok'));
    const result = await generateEventPost({
      organizationId: 'org_1', eventTemplateId: 'et_1', prompt: 'x', platforms: ['ig']
    });
    expect(result.imagePrompt).toContain('Event: PlainEvent');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('_internal.tempTokenConfig()', () => {
  it('uses max_completion_tokens for gpt-5 family', () => {
    openaiClient.chatModel = 'gpt-5.3-chat-latest';
    const cfg = _internal.tempTokenConfig(0.8, 500);
    expect(cfg).toEqual({ temperature: 0.8, max_completion_tokens: 500 });
  });

  it('uses max_completion_tokens for o1/o3/o4 models', () => {
    openaiClient.chatModel = 'o1-preview';
    expect(_internal.tempTokenConfig(0.8, 500)).toEqual({
      temperature: 0.8, max_completion_tokens: 500
    });
  });

  it('uses max_tokens for gpt-4 family', () => {
    openaiClient.chatModel = 'gpt-4o';
    expect(_internal.tempTokenConfig(0.8, 500)).toEqual({
      temperature: 0.8, max_tokens: 500
    });
  });

  it('handles null/undefined model gracefully', () => {
    openaiClient.chatModel = null;
    expect(_internal.tempTokenConfig(0.5, 200)).toEqual({
      temperature: 0.5, max_tokens: 200
    });
  });
});
