/**
 * Tests for replyGenerationService — the single most risky AI module
 * (drives human-facing replies + auto-reply routing).
 *
 * Covers:
 *   - generateText: happy path, no-api-key guard, error-wrapping.
 *   - generateResponseOpenAI standard mode:
 *       * Resolves KB via knowledgeBaseSearchService when not provided
 *       * Increments usage on real matches only (fromFallback=false)
 *       * Skips usage increment on top-priority fallbacks
 *       * Uses provided KB directly without searching
 *       * Truncates KB entries per MAX_KB_ENTRY_CHARS + MAX_KB_TOTAL_CHARS
 *       * Bucket context: tone from bucket, tone fallback to BrandConfig,
 *         includes replyLanguage (unless 'auto') and replyPrompt
 *       * Confidence math: base 0.78 + 0.04 per KB, cap 0.95
 *       * Maps OpenAI 401/429/5xx errors to user-facing Error messages
 *   - generateResponseOpenAI self-assessment mode:
 *       * Parses JSON response, clamps confidence to [0,1]
 *       * Uses raw text when JSON parse fails
 *       * Strips markdown fences / finds embedded JSON in chatter
 *   - generateResponse is an alias for generateResponseOpenAI.
 */

jest.mock('../../../../src/services/ai/openaiClient', () => ({
  chatModel: 'gpt-4o',
  hasApiKey: jest.fn(() => true),
  chatCompletion: jest.fn()
}));

jest.mock('../../../../src/services/ai/knowledgeBaseSearchService', () => ({
  searchKnowledgeBase: jest.fn()
}));

jest.mock('../../../../src/services/ai/brandContextService', () => ({
  getBrandContext: jest.fn()
}));

jest.mock('../../../../src/models/IntentBucket', () => {
  const state = { findByIdResult: null };
  globalThis.__intentBucketState = state;
  return {
    findById: () => ({
      select: () => ({ lean: async () => state.findByIdResult })
    })
  };
});

jest.mock('../../../../src/models/BrandConfig', () => {
  const state = { findOneResult: null };
  globalThis.__replyBrandConfigState = state;
  return {
    findOne: () => ({
      select: () => ({ lean: async () => state.findOneResult })
    })
  };
});

const openaiClient = require('../../../../src/services/ai/openaiClient');
const knowledgeBaseSearchService = require('../../../../src/services/ai/knowledgeBaseSearchService');
const brandContextService = require('../../../../src/services/ai/brandContextService');
// Force lazy-required mocks to run
require('../../../../src/models/IntentBucket');
require('../../../../src/models/BrandConfig');
const {
  generateResponse, generateResponseOpenAI, generateText
} = require('../../../../src/services/ai/replyGenerationService');

const bucketState = globalThis.__intentBucketState;
const brandState = globalThis.__replyBrandConfigState;

const okChat = (text) => ({ data: { choices: [{ message: { content: text } }] } });

beforeEach(() => {
  openaiClient.hasApiKey.mockReset().mockReturnValue(true);
  openaiClient.chatCompletion.mockReset();
  knowledgeBaseSearchService.searchKnowledgeBase.mockReset()
    .mockResolvedValue({ entries: [], fromFallback: false });
  brandContextService.getBrandContext.mockReset().mockResolvedValue(null);
  bucketState.findByIdResult = null;
  brandState.findOneResult = null;
});

// Build a minimal interaction fixture
const makeInteraction = (overrides = {}) => ({
  _id: 'int_1',
  content: 'Hey, do you ship internationally?',
  platform: 'instagram',
  type: 'comment',
  sentiment: 'neutral',
  ...overrides
});

// ═══════════════════════════════════════════════════════════════════════════
// generateText
// ═══════════════════════════════════════════════════════════════════════════
describe('generateText()', () => {
  it('throws a wrapped error when API key is missing', async () => {
    openaiClient.hasApiKey.mockReturnValue(false);
    await expect(generateText('sys', 'user'))
      .rejects.toThrow(/Failed to generate text.*OpenAI API key is not configured/);
  });

  it('POSTs with system + user messages and trims the response', async () => {
    openaiClient.chatCompletion.mockResolvedValue(okChat('  hello out  '));

    const result = await generateText('sys', 'user');

    expect(result).toBe('hello out');
    const body = openaiClient.chatCompletion.mock.calls[0][0];
    expect(body.messages).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'user' }
    ]);
    expect(body.model).toBe('gpt-4o');
  });

  it('respects temperature / maxTokens / model / feature overrides', async () => {
    openaiClient.chatCompletion.mockResolvedValue(okChat('ok'));

    await generateText('s', 'u', {
      temperature: 0.3,
      maxTokens: 1500,
      model: 'gpt-4o-mini',
      feature: 'summarisation'
    });

    const [body, ctxOverrides, config] = openaiClient.chatCompletion.mock.calls[0];
    expect(body.temperature).toBe(0.3);
    expect(body.model).toBe('gpt-4o-mini');
    expect(ctxOverrides).toEqual({ feature: 'summarisation' });
    expect(config.timeout).toBe(120000);
  });

  it('caps maxTokens when falsy (0) at TEXT_GEN_HARD_MAX (4000)', async () => {
    openaiClient.chatCompletion.mockResolvedValue(okChat('ok'));
    await generateText('s', 'u', { maxTokens: 0 });
    const body = openaiClient.chatCompletion.mock.calls[0][0];
    // For gpt-4o, the field is max_tokens
    expect(body.max_tokens).toBe(4000);
  });

  it('wraps upstream errors with "Failed to generate text:" prefix', async () => {
    openaiClient.chatCompletion.mockRejectedValue(new Error('rate limit'));
    await expect(generateText('s', 'u'))
      .rejects.toThrow('Failed to generate text: rate limit');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// generateResponseOpenAI — standard mode
// ═══════════════════════════════════════════════════════════════════════════
describe('generateResponseOpenAI() — standard mode', () => {
  it('throws a user-facing error when API key missing', async () => {
    openaiClient.hasApiKey.mockReturnValue(false);
    await expect(generateResponseOpenAI(makeInteraction()))
      .rejects.toThrow('OpenAI API key is not configured');
  });

  it('resolves KB via searchKnowledgeBase when none provided', async () => {
    const kb1 = {
      _id: 'kb1', title: 'Shipping', content: 'We ship worldwide.', usageCount: 0,
      incrementUsage: jest.fn().mockResolvedValue()
    };
    knowledgeBaseSearchService.searchKnowledgeBase.mockResolvedValue({
      entries: [kb1], fromFallback: false
    });
    openaiClient.chatCompletion.mockResolvedValue(okChat('Thanks for reaching out!'));

    const result = await generateResponseOpenAI(makeInteraction(), 'org_1');

    expect(knowledgeBaseSearchService.searchKnowledgeBase)
      .toHaveBeenCalledWith('org_1', 'Hey, do you ship internationally?', 5);
    expect(kb1.incrementUsage).toHaveBeenCalledTimes(1);
    expect(result.content).toBe('Thanks for reaching out!');
    expect(result.usedKnowledgeBase).toBe(true);
    expect(result.knowledgeBaseCount).toBe(1);
    expect(result.knowledgeBaseFallback).toBe(false);
    expect(result.confidence).toBeCloseTo(0.78 + 0.04, 5); // base + 1 KB
    expect(result.resolvable).toBe(true);
    expect(result.resolvableReason).toBeNull();
  });

  it('injects the current account-aware Brand Hub voice into reply prompts', async () => {
    brandContextService.getBrandContext.mockResolvedValue(
      'Writing style: concise luxury product copy. Brand character: refined, modern.'
    );
    openaiClient.chatCompletion.mockResolvedValue(okChat('We would be happy to help.'));

    await generateResponseOpenAI(makeInteraction(), 'org_1');

    const sysPrompt = openaiClient.chatCompletion.mock.calls[0][0].messages[0].content;
    expect(brandContextService.getBrandContext).toHaveBeenCalledWith('org_1');
    expect(sysPrompt).toContain('CURRENT BRAND VOICE');
    expect(sysPrompt).toContain('concise luxury product copy');
    expect(sysPrompt).not.toContain('cricket');
  });

  it('does NOT increment usage on top-priority fallback results', async () => {
    const kb = {
      _id: 'kb1', title: 'Always', content: 'brand info',
      incrementUsage: jest.fn().mockResolvedValue()
    };
    knowledgeBaseSearchService.searchKnowledgeBase.mockResolvedValue({
      entries: [kb], fromFallback: true
    });
    openaiClient.chatCompletion.mockResolvedValue(okChat('ok'));

    const result = await generateResponseOpenAI(makeInteraction(), 'org_1');

    expect(kb.incrementUsage).not.toHaveBeenCalled();
    expect(result.knowledgeBaseFallback).toBe(true);
    expect(result.usedKnowledgeBase).toBe(true);
  });

  it('uses provided knowledgeBase and skips search entirely', async () => {
    openaiClient.chatCompletion.mockResolvedValue(okChat('hi'));

    await generateResponseOpenAI(
      makeInteraction(), 'org_1',
      [{ title: 'Manual', content: 'Manual entry' }]
    );

    expect(knowledgeBaseSearchService.searchKnowledgeBase).not.toHaveBeenCalled();
    const sysPrompt = openaiClient.chatCompletion.mock.calls[0][0].messages[0].content;
    expect(sysPrompt).toContain('Manual: Manual entry');
  });

  it('does NOT search KB when organizationId is null (and none provided)', async () => {
    openaiClient.chatCompletion.mockResolvedValue(okChat('hi'));
    const result = await generateResponseOpenAI(makeInteraction(), null);
    expect(knowledgeBaseSearchService.searchKnowledgeBase).not.toHaveBeenCalled();
    expect(result.usedKnowledgeBase).toBe(false);
    expect(result.knowledgeBaseCount).toBe(0);
    expect(result.confidence).toBeCloseTo(0.78, 5);
  });

  it('caps each KB entry to MAX_KB_ENTRY_CHARS and adds ellipsis', async () => {
    const bigContent = 'a'.repeat(500); // 500 > 400 cap
    knowledgeBaseSearchService.searchKnowledgeBase.mockResolvedValue({
      entries: [{ title: 'Big', content: bigContent, incrementUsage: jest.fn().mockResolvedValue() }],
      fromFallback: false
    });
    openaiClient.chatCompletion.mockResolvedValue(okChat('ok'));

    await generateResponseOpenAI(makeInteraction(), 'org_1');

    const sys = openaiClient.chatCompletion.mock.calls[0][0].messages[0].content;
    // Entry shows 400 a's + ellipsis
    expect(sys).toMatch(/Big: a{400}…/);
    // Should NOT contain 401 a's in a row (capped at 400)
    expect(sys).not.toMatch(/a{401}/);
  });

  it('stops including KB entries after MAX_KB_TOTAL_CHARS (1200)', async () => {
    // Each entry contributes "Title: " (~7 chars) + up to 400 content.
    // 4 entries would be ~1628 chars → only ~3 fit.
    const entries = Array.from({ length: 5 }, (_, i) => ({
      title: `T${i}`, content: 'x'.repeat(400),
      incrementUsage: jest.fn().mockResolvedValue()
    }));
    knowledgeBaseSearchService.searchKnowledgeBase.mockResolvedValue({
      entries, fromFallback: false
    });
    openaiClient.chatCompletion.mockResolvedValue(okChat('ok'));

    await generateResponseOpenAI(makeInteraction(), 'org_1');

    const sys = openaiClient.chatCompletion.mock.calls[0][0].messages[0].content;
    // Count how many "T<n>:" appear in the KB section
    const kbSectionMatches = (sys.match(/T\d+:/g) || []).length;
    expect(kbSectionMatches).toBeGreaterThan(0);
    expect(kbSectionMatches).toBeLessThan(5);
  });

  it('confidence caps at 0.95 even with many KB matches', async () => {
    const entries = Array.from({ length: 20 }, (_, i) => ({
      title: `T${i}`, content: 'x',
      incrementUsage: jest.fn().mockResolvedValue()
    }));
    knowledgeBaseSearchService.searchKnowledgeBase.mockResolvedValue({
      entries, fromFallback: false
    });
    openaiClient.chatCompletion.mockResolvedValue(okChat('ok'));

    const result = await generateResponseOpenAI(makeInteraction(), 'org_1');
    expect(result.confidence).toBe(0.95);
  });

  it('tolerates KB usageCount being NaN / missing (normalises to 0)', async () => {
    const kb = {
      _id: 'k1', title: 'T', content: 'c',
      usageCount: 'weird',
      incrementUsage: jest.fn().mockResolvedValue()
    };
    knowledgeBaseSearchService.searchKnowledgeBase.mockResolvedValue({
      entries: [kb], fromFallback: false
    });
    openaiClient.chatCompletion.mockResolvedValue(okChat('ok'));

    await generateResponseOpenAI(makeInteraction(), 'org_1');
    expect(kb.usageCount).toBe(0);
    expect(kb.incrementUsage).toHaveBeenCalled();
  });

  it('survives incrementUsage() errors without failing the reply', async () => {
    const kb = {
      _id: 'k1', title: 'T', content: 'c', usageCount: 0,
      incrementUsage: jest.fn().mockRejectedValue(new Error('db down'))
    };
    knowledgeBaseSearchService.searchKnowledgeBase.mockResolvedValue({
      entries: [kb], fromFallback: false
    });
    openaiClient.chatCompletion.mockResolvedValue(okChat('ok'));

    await expect(generateResponseOpenAI(makeInteraction(), 'org_1'))
      .resolves.toMatchObject({ content: 'ok' });
  });

  // ─── Bucket context ────────────────────────────────────────────────────
  describe('bucket context', () => {
    it('emits bucket tone/language/prompt from IntentBucket', async () => {
      bucketState.findByIdResult = {
        name: 'Sales enquiries',
        replyTone: 'warm',
        replyLanguage: 'english',
        replyPrompt: 'Always suggest a call.'
      };
      openaiClient.chatCompletion.mockResolvedValue(okChat('ok'));

      await generateResponseOpenAI(
        makeInteraction({ intentBucket: 'bkt_1' }),
        'org_1'
      );

      const sys = openaiClient.chatCompletion.mock.calls[0][0].messages[0].content;
      expect(sys).toContain('Bucket: "Sales enquiries"');
      expect(sys).toContain('Tone: warm');
      expect(sys).toContain('Reply Language: english');
      expect(sys).toContain('Special Instructions: Always suggest a call.');
    });

    it('falls back to BrandConfig.toneOfVoice when bucket has no tone', async () => {
      bucketState.findByIdResult = { name: 'B', replyTone: null };
      brandState.findOneResult = { toneOfVoice: 'casual' };
      openaiClient.chatCompletion.mockResolvedValue(okChat('ok'));

      await generateResponseOpenAI(
        makeInteraction({ intentBucket: 'bkt_1' }),
        'org_1'
      );

      const sys = openaiClient.chatCompletion.mock.calls[0][0].messages[0].content;
      expect(sys).toContain('Tone: casual');
    });

    it('defaults tone to "professional" when BrandConfig is also missing', async () => {
      bucketState.findByIdResult = { name: 'B', replyTone: null };
      brandState.findOneResult = null;
      openaiClient.chatCompletion.mockResolvedValue(okChat('ok'));

      await generateResponseOpenAI(
        makeInteraction({ intentBucket: 'bkt_1' }),
        'org_1'
      );
      const sys = openaiClient.chatCompletion.mock.calls[0][0].messages[0].content;
      expect(sys).toContain('Tone: professional');
    });

    it('omits Reply Language line when bucket language is "auto"', async () => {
      bucketState.findByIdResult = {
        name: 'B', replyTone: 'friendly', replyLanguage: 'auto'
      };
      openaiClient.chatCompletion.mockResolvedValue(okChat('ok'));

      await generateResponseOpenAI(
        makeInteraction({ intentBucket: 'bkt_1' }),
        'org_1'
      );
      const sys = openaiClient.chatCompletion.mock.calls[0][0].messages[0].content;
      expect(sys).not.toMatch(/Reply Language/);
    });

    it('skips bucket context silently when IntentBucket lookup throws', async () => {
      const IntentBucket = require('../../../../src/models/IntentBucket');
      const original = IntentBucket.findById;
      IntentBucket.findById = () => { throw new Error('mongo dead'); };

      openaiClient.chatCompletion.mockResolvedValue(okChat('ok'));

      const result = await generateResponseOpenAI(
        makeInteraction({ intentBucket: 'bkt_1' }),
        'org_1'
      );
      expect(result.content).toBe('ok');
      IntentBucket.findById = original;
    });
  });

  // ─── Error mapping ─────────────────────────────────────────────────────
  describe('error mapping', () => {
    it.each([
      [401, /OpenAI API key is invalid or expired/],
      [429, /temporarily unavailable due to rate limits/],
      [500, /temporarily unavailable/],
      [502, /temporarily unavailable/],
      [503, /temporarily unavailable/],
      [400, /AI service error/]
    ])('maps HTTP %i → user-facing message', async (status, match) => {
      openaiClient.chatCompletion.mockRejectedValue({
        response: { status, data: { error: { message: 'upstream detail' } } }
      });
      await expect(generateResponseOpenAI(makeInteraction(), 'org_1'))
        .rejects.toThrow(match);
    });

    it('maps no-response (network) to a connection error', async () => {
      openaiClient.chatCompletion.mockRejectedValue({
        request: {}, message: 'socket hang up'
      });
      await expect(generateResponseOpenAI(makeInteraction(), 'org_1'))
        .rejects.toThrow(/Unable to connect to AI service/);
    });

    it('rethrows generic errors unchanged', async () => {
      openaiClient.chatCompletion.mockRejectedValue(new Error('boom'));
      await expect(generateResponseOpenAI(makeInteraction(), 'org_1'))
        .rejects.toThrow('boom');
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// generateResponseOpenAI — self-assessment mode
// ═══════════════════════════════════════════════════════════════════════════
describe('generateResponseOpenAI() — self-assessment mode', () => {
  it('parses the JSON reply and returns the structured shape', async () => {
    openaiClient.chatCompletion.mockResolvedValue(okChat(JSON.stringify({
      resolvable: true,
      reason: '',
      confidence: 0.9,
      reply: 'Absolutely! We ship to 30 countries.',
      messageType: 'business',
      noReply: false
    })));

    const result = await generateResponseOpenAI(
      makeInteraction(), 'org_1', null, { withSelfAssessment: true }
    );

    expect(result.content).toBe('Absolutely! We ship to 30 countries.');
    expect(result.confidence).toBe(0.9);
    expect(result.resolvable).toBe(true);
    expect(result.messageType).toBe('business');
    expect(result.noReply).toBe(false);
    expect(result.resolvableReason).toBeNull();
  });

  it('clamps confidence into [0, 1]', async () => {
    openaiClient.chatCompletion.mockResolvedValue(okChat(JSON.stringify({
      resolvable: true, reply: 'ok', confidence: 99
    })));

    const result = await generateResponseOpenAI(
      makeInteraction(), 'org_1', null, { withSelfAssessment: true }
    );
    expect(result.confidence).toBe(1);
  });

  it('falls back to kbBackedConfidence when JSON confidence is missing', async () => {
    openaiClient.chatCompletion.mockResolvedValue(okChat(JSON.stringify({
      resolvable: true, reply: 'ok'
    })));
    const result = await generateResponseOpenAI(
      makeInteraction(), null, null, { withSelfAssessment: true }
    );
    expect(result.confidence).toBeCloseTo(0.78, 5);
  });

  it('uses raw text when the model returns a non-JSON reply', async () => {
    openaiClient.chatCompletion.mockResolvedValue(okChat('  plain text reply  '));

    const result = await generateResponseOpenAI(
      makeInteraction(), null, null, { withSelfAssessment: true }
    );
    expect(result.content).toBe('plain text reply');
    expect(result.resolvable).toBe(true);
    expect(result.messageType).toBe('business');
  });

  it('extracts JSON when the model wraps it in extra chatter', async () => {
    const reply = `Sure, here's my analysis:\n\n{"resolvable":false,"reason":"needs account data","confidence":0.2,"reply":"I can't help with that."}\n\nLet me know!`;
    openaiClient.chatCompletion.mockResolvedValue(okChat(reply));

    const result = await generateResponseOpenAI(
      makeInteraction(), null, null, { withSelfAssessment: true }
    );
    expect(result.resolvable).toBe(false);
    expect(result.resolvableReason).toBe('needs account data');
    expect(result.content).toBe("I can't help with that.");
  });

  it('defaults resolvable=true when the JSON omits it (!== false)', async () => {
    openaiClient.chatCompletion.mockResolvedValue(okChat(JSON.stringify({
      reply: 'hi', confidence: 0.5
    })));
    const result = await generateResponseOpenAI(
      makeInteraction(), null, null, { withSelfAssessment: true }
    );
    expect(result.resolvable).toBe(true);
  });

  it('treats resolvable=false with a custom reason', async () => {
    openaiClient.chatCompletion.mockResolvedValue(okChat(JSON.stringify({
      resolvable: false, reason: 'needs system data', confidence: 0.1, reply: 'sorry'
    })));
    const result = await generateResponseOpenAI(
      makeInteraction(), null, null, { withSelfAssessment: true }
    );
    expect(result.resolvable).toBe(false);
    expect(result.resolvableReason).toBe('needs system data');
  });

  it('uses default resolvable reason when not provided', async () => {
    openaiClient.chatCompletion.mockResolvedValue(okChat(JSON.stringify({
      resolvable: false, reply: 'sorry'
    })));
    const result = await generateResponseOpenAI(
      makeInteraction(), null, null, { withSelfAssessment: true }
    );
    expect(result.resolvableReason).toBe('Requires access to private account or system data');
  });

  // ── JSON leak regression tests (Bug 1 fix) ─────────────────────────────────

  it('NEVER sends raw internal JSON when resolvable:false and reply is missing', async () => {
    // Exact payload that was delivered to customers — wrong business, no reply field
    const internalJson = JSON.stringify({
      resolvable: false,
      reason: 'Customer is repeatedly contacting the wrong business (Lulu Hypermarket UAE vs RepMeUp)',
      confidence: 0.94,
      messageType: 'business',
      noReply: false
    });
    openaiClient.chatCompletion.mockResolvedValue(okChat(internalJson));

    const result = await generateResponseOpenAI(
      makeInteraction(), null, null, { withSelfAssessment: true }
    );

    // Must NOT contain the raw JSON string as content
    expect(result.content).not.toContain('"resolvable"');
    expect(result.content).not.toContain('Lulu Hypermarket');
    // Must route to human
    expect(result.resolvable).toBe(false);
    expect(result.resolvableReason).toBeTruthy();
  });

  it('routes to human when JSON has resolvable:false with no reply field', async () => {
    openaiClient.chatCompletion.mockResolvedValue(okChat(JSON.stringify({
      resolvable: false,
      reason: 'Cannot access private account data',
      confidence: 0.85,
      messageType: 'business'
    })));

    const result = await generateResponseOpenAI(
      makeInteraction(), null, null, { withSelfAssessment: true }
    );

    expect(result.resolvable).toBe(false);
    expect(result.resolvableReason).toBe('Cannot access private account data');
    expect(result.content).toBe('');
  });

  it('returns noReply:true and empty content for closing/pleasantries JSON', async () => {
    openaiClient.chatCompletion.mockResolvedValue(okChat(JSON.stringify({
      resolvable: true,
      confidence: 1.0,
      messageType: 'closing',
      noReply: true,
      reply: ''
    })));

    const result = await generateResponseOpenAI(
      makeInteraction(), null, null, { withSelfAssessment: true }
    );

    expect(result.noReply).toBe(true);
    expect(result.messageType).toBe('closing');
  });

  it('blocks raw JSON-shaped text that failed to parse as content', async () => {
    // Malformed JSON — parse will fail, but it looks like internal metadata
    const malformedJson = '{"resolvable":false,"messageType":"business","confidence":0.9 BROKEN';
    openaiClient.chatCompletion.mockResolvedValue(okChat(malformedJson));

    const result = await generateResponseOpenAI(
      makeInteraction(), null, null, { withSelfAssessment: true }
    );

    // Should not send the broken JSON as content; should route to human
    expect(result.content).not.toContain('"resolvable"');
    expect(result.resolvable).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// generateResponse (alias)
// ═══════════════════════════════════════════════════════════════════════════
describe('generateResponse() alias', () => {
  it('delegates to generateResponseOpenAI (same standard-mode shape)', async () => {
    openaiClient.chatCompletion.mockResolvedValue(okChat('hello'));
    const result = await generateResponse(makeInteraction(), null);
    expect(result).toMatchObject({
      content: 'hello',
      resolvable: true,
      usedKnowledgeBase: false
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Order-context handling — regression for the "every message → order confirmed" bug
// ═══════════════════════════════════════════════════════════════════════════
const {
  isOpaqueOrderPlaceholder,
  resolveLatestMessageForPrompt
} = require('../../../../src/services/ai/replyGenerationService');

describe('isOpaqueOrderPlaceholder()', () => {
  it.each(['[Product order]', 'product order', '[Order]', 'checkout', '  [cart] ', ''])(
    'treats "%s" as an opaque placeholder', (v) => expect(isOpaqueOrderPlaceholder(v)).toBe(true)
  );
  it.each(['hi', 'hooooo', 'hhggfgh', 'do you ship to Dubai?', 'I want the black kurti'])(
    'treats real message "%s" as NOT a placeholder', (v) => expect(isOpaqueOrderPlaceholder(v)).toBe(false)
  );
});

describe('resolveLatestMessageForPrompt()', () => {
  const order = 'ORDER ORD-1006 (just placed via WhatsApp): 1× Y2K Black Beaded Kurti. Total $1400.';

  it('uses the customer\'s REAL words when they typed a message, even with an open order', () => {
    const r = resolveLatestMessageForPrompt({ content: 'hiii' }, order);
    expect(r.usedOrderAsMessage).toBe(false);
    expect(r.line).toBe('"hiii"');
    expect(r.line).not.toMatch(/placed an order/);
  });

  it('substitutes the order ONLY for an opaque native-cart placeholder', () => {
    const r = resolveLatestMessageForPrompt({ content: '[Product order]' }, order);
    expect(r.usedOrderAsMessage).toBe(true);
    expect(r.line).toContain('placed an order');
    expect(r.line).toContain('ORD-1006');
  });

  it('uses the real message when there is no order context', () => {
    const r = resolveLatestMessageForPrompt({ content: 'hooooo' }, '');
    expect(r).toEqual({ line: '"hooooo"', usedOrderAsMessage: false });
  });
});

describe('generateResponseOpenAI() with an active order', () => {
  const order = 'ORDER ORD-1006 (just placed via WhatsApp): 1× Y2K Black Beaded Kurti. Total $1400.';
  const selfAssessJson = JSON.stringify({
    resolvable: true, confidence: 1, reply: 'Hey! How can I help? 😊',
    messageType: 'small_talk', noReply: false
  });

  it('sends the customer\'s ACTUAL message to the model — not the order — for a real message', async () => {
    openaiClient.chatCompletion.mockResolvedValue(okChat(selfAssessJson));

    await generateResponseOpenAI(
      makeInteraction({ content: 'hiii', platform: 'whatsapp', type: 'dm' }),
      'org_1', null, { withSelfAssessment: true, orderContext: order }
    );

    const userMsg = openaiClient.chatCompletion.mock.calls[0][0].messages[1].content;
    expect(userMsg).toContain('hiii');
    expect(userMsg).not.toContain('the customer placed an order');
  });

  it('still describes the order when the message is an opaque native-cart placeholder', async () => {
    openaiClient.chatCompletion.mockResolvedValue(okChat(selfAssessJson));

    await generateResponseOpenAI(
      makeInteraction({ content: '[Product order]', platform: 'whatsapp', type: 'dm' }),
      'org_1', null, { withSelfAssessment: true, orderContext: order }
    );

    const userMsg = openaiClient.chatCompletion.mock.calls[0][0].messages[1].content;
    expect(userMsg).toContain('the customer placed an order');
  });
});
