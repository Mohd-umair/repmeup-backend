/**
 * Behavioural tests for autoReplyService — the most policy-heavy module
 * in the AI layer. Every branch in the eligibility decision matters
 * because a wrong answer either spams customers (false positive) or
 * silently drops support tickets (false negative).
 *
 * Mocking strategy:
 *   - replyGenerationService → produces a fake LLM result; lets us drive
 *     resolvability and confidence directly.
 *   - aiCreditService → controls credit availability without touching Mongo.
 *   - aiRequestContext → trivially calls through (no AsyncLocalStorage in tests).
 *   - models/IntentBucket → only the .findById().select().lean() chain is mocked.
 *   - utils/interactionThreadDm → we drive isThreadStyleDm explicitly per case.
 */

const mockGenerateResponseOpenAI = jest.fn();
jest.mock('../../../../src/services/ai/replyGenerationService', () => ({
  generateResponseOpenAI: mockGenerateResponseOpenAI
}));

const mockCheckCredits = jest.fn();
const mockDeductCredits = jest.fn(async () => true);
jest.mock('../../../../src/services/aiCreditService', () => ({
  checkCredits: mockCheckCredits,
  deductCredits: mockDeductCredits
}));

jest.mock('../../../../src/services/aiRequestContext', () => ({
  // Pass-through with a fake aiApiUsageId so the unresolvable / success branches both work.
  runWithAiContextAndUsageId: jest.fn(async (_ctx, fn) => ({
    result: await fn(),
    aiApiUsageId: 'fake-usage-id'
  }))
}));

const mockIsThreadStyleDm = jest.fn(() => false);
jest.mock('../../../../src/utils/interactionThreadDm', () => ({
  isThreadStyleDm: (...args) => mockIsThreadStyleDm(...args)
}));

const mockBucketFindById = jest.fn();
jest.mock('../../../../src/models/IntentBucket', () => ({
  findById: (id) => ({
    select: () => ({
      lean: () => mockBucketFindById(id)
    })
  })
}));

// User model: only used by deductCreditsSafely → resolveAttributableUserId.
// The deduct path is non-fatal (try/catch swallows), so we just stub a no-op.
jest.mock('../../../../src/models/User', () => ({
  findOne: () => ({ select: async () => null })
}));

const autoReplyService = require('../../../../src/services/ai/autoReplyService');

beforeEach(() => {
  mockGenerateResponseOpenAI.mockReset();
  mockCheckCredits.mockReset();
  mockDeductCredits.mockReset();
  mockBucketFindById.mockReset();
  mockIsThreadStyleDm.mockReset().mockReturnValue(false);
});

const baseInteraction = (over = {}) => ({
  _id: 'interaction_1',
  platform: 'instagram',
  type: 'comment',
  status: 'new',
  replies: [],
  sentiment: 'positive',
  ...over
});

const enabledOrg = (over = {}) => ({
  autoReplySettings: {
    enabled: true,
    triggerMode: 'immediate',
    sentimentFilter: 'all',
    ...over
  }
});

// ────────────────────────────────────────────────────────────────────────────
describe('shouldQueueImmediateAutoReply (cheap pre-queue gate)', () => {
  it('returns false when org has no autoReplySettings', () => {
    expect(autoReplyService.shouldQueueImmediateAutoReply(baseInteraction(), {})).toBe(false);
  });

  it('returns false when autoReply is disabled', () => {
    const org = enabledOrg({ enabled: false });
    expect(autoReplyService.shouldQueueImmediateAutoReply(baseInteraction(), org)).toBe(false);
  });

  it('returns false when interaction.platform is not in enabledPlatforms', () => {
    const org = enabledOrg({ enabledPlatforms: ['facebook', 'whatsapp'] });
    expect(autoReplyService.shouldQueueImmediateAutoReply(baseInteraction(), org)).toBe(false);
  });

  it('returns true when interaction.platform IS in enabledPlatforms (case-insensitive)', () => {
    const org = enabledOrg({ enabledPlatforms: ['Instagram', 'whatsapp'] });
    expect(autoReplyService.shouldQueueImmediateAutoReply(baseInteraction({ platform: 'INSTAGRAM' }), org)).toBe(true);
  });

  it('returns false when interaction.type is not in enabledTypes', () => {
    const org = enabledOrg({ enabledTypes: ['dm'] });
    expect(autoReplyService.shouldQueueImmediateAutoReply(baseInteraction({ type: 'comment' }), org)).toBe(false);
  });

  it('returns true when no platform/type filter is configured', () => {
    expect(autoReplyService.shouldQueueImmediateAutoReply(baseInteraction(), enabledOrg())).toBe(true);
  });

  it('does NOT consult sentiment (still async at this point)', () => {
    // sentimentFilter would block in canAutoReply, but the cheap gate ignores it.
    const org = enabledOrg({ sentimentFilter: 'negative_only' });
    expect(autoReplyService.shouldQueueImmediateAutoReply(baseInteraction({ sentiment: 'positive' }), org)).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────────────────
describe('canAutoReply (full eligibility)', () => {
  it('blocks when status is "replied"', async () => {
    expect(await autoReplyService.canAutoReply(baseInteraction({ status: 'replied' }), enabledOrg())).toBe(false);
  });

  it('blocks when status is "resolved"', async () => {
    expect(await autoReplyService.canAutoReply(baseInteraction({ status: 'resolved' }), enabledOrg())).toBe(false);
  });

  it('blocks when interaction already has replies (non-thread)', async () => {
    const i = baseInteraction({ replies: [{ content: 'hi' }] });
    expect(await autoReplyService.canAutoReply(i, enabledOrg())).toBe(false);
  });

  it('does NOT enforce already-replied for DM threads (replies[] = history)', async () => {
    mockIsThreadStyleDm.mockReturnValue(true);
    const i = baseInteraction({ replies: [{ content: 'hi' }], status: 'replied' });
    expect(await autoReplyService.canAutoReply(i, enabledOrg())).toBe(true);
  });

  it('blocks when org settings disable autoReply', async () => {
    expect(await autoReplyService.canAutoReply(baseInteraction(), enabledOrg({ enabled: false }))).toBe(false);
  });

  it('blocks by platform filter', async () => {
    const org = enabledOrg({ enabledPlatforms: ['whatsapp'] });
    expect(await autoReplyService.canAutoReply(baseInteraction({ platform: 'instagram' }), org)).toBe(false);
  });

  it('blocks by type filter', async () => {
    const org = enabledOrg({ enabledTypes: ['dm'] });
    expect(await autoReplyService.canAutoReply(baseInteraction({ type: 'comment' }), org)).toBe(false);
  });

  describe('sentimentFilter', () => {
    it('"all" allows any sentiment', async () => {
      const org = enabledOrg({ sentimentFilter: 'all' });
      for (const s of ['positive', 'negative', 'neutral', 'unknown']) {
        expect(await autoReplyService.canAutoReply(baseInteraction({ sentiment: s }), org)).toBe(true);
      }
    });

    it('blocks when filter is set but sentiment is unknown (analysis incomplete)', async () => {
      const org = enabledOrg({ sentimentFilter: 'negative_only' });
      const i = baseInteraction({ sentiment: undefined });
      expect(await autoReplyService.canAutoReply(i, org)).toBe(false);
    });

    it('"negative_only" rejects positive', async () => {
      const org = enabledOrg({ sentimentFilter: 'negative_only' });
      expect(await autoReplyService.canAutoReply(baseInteraction({ sentiment: 'positive' }), org)).toBe(false);
    });

    it('"negative_only" allows negative', async () => {
      const org = enabledOrg({ sentimentFilter: 'negative_only' });
      expect(await autoReplyService.canAutoReply(baseInteraction({ sentiment: 'negative' }), org)).toBe(true);
    });

    it('"positive_neutral" rejects negative', async () => {
      const org = enabledOrg({ sentimentFilter: 'positive_neutral' });
      expect(await autoReplyService.canAutoReply(baseInteraction({ sentiment: 'negative' }), org)).toBe(false);
    });

    it('"positive_neutral" allows neutral and positive', async () => {
      const org = enabledOrg({ sentimentFilter: 'positive_neutral' });
      expect(await autoReplyService.canAutoReply(baseInteraction({ sentiment: 'neutral' }), org)).toBe(true);
      expect(await autoReplyService.canAutoReply(baseInteraction({ sentiment: 'positive' }), org)).toBe(true);
    });
  });

  describe('per-bucket reply toggle', () => {
    it('blocks when bucket.replyEnabled is explicitly false', async () => {
      mockBucketFindById.mockResolvedValue({ name: 'Spam', replyEnabled: false });
      const i = baseInteraction({ intentBucket: 'b_spam' });
      expect(await autoReplyService.canAutoReply(i, enabledOrg())).toBe(false);
      expect(mockBucketFindById).toHaveBeenCalledWith('b_spam');
    });

    it('allows when bucket.replyEnabled is true', async () => {
      mockBucketFindById.mockResolvedValue({ name: 'Support', replyEnabled: true });
      const i = baseInteraction({ intentBucket: 'b_support' });
      expect(await autoReplyService.canAutoReply(i, enabledOrg())).toBe(true);
    });

    it('allows when bucket lookup returns null (bucket may have been deleted)', async () => {
      mockBucketFindById.mockResolvedValue(null);
      const i = baseInteraction({ intentBucket: 'b_missing' });
      expect(await autoReplyService.canAutoReply(i, enabledOrg())).toBe(true);
    });
  });

  it('accepts a Mongoose-doc-shaped settings object via toObject()', async () => {
    const orgDoc = {
      toObject() { return { autoReplySettings: { enabled: true, sentimentFilter: 'all' } }; }
    };
    expect(await autoReplyService.canAutoReply(baseInteraction(), orgDoc)).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────────────────
describe('generateAutoReply (end-to-end orchestration)', () => {
  const ORG_ID = 'org_42';

  it('returns ineligible when canAutoReply gate fails', async () => {
    const result = await autoReplyService.generateAutoReply(
      baseInteraction({ status: 'replied' }),
      ORG_ID,
      enabledOrg()
    );
    expect(result.eligible).toBe(false);
    expect(mockCheckCredits).not.toHaveBeenCalled();
  });

  it('returns ineligible with credit error when org has no AI credits', async () => {
    mockCheckCredits.mockResolvedValue({
      allowed: false,
      error: 'Credits exhausted',
      code: 'AI_CREDITS_EXCEEDED',
      remaining: 0
    });
    const result = await autoReplyService.generateAutoReply(baseInteraction(), ORG_ID, enabledOrg());
    expect(result.eligible).toBe(false);
    expect(result.code).toBe('AI_CREDITS_EXCEEDED');
    expect(result.creditsNeeded).toBe(1);
    expect(result.creditsRemaining).toBe(0);
    expect(mockGenerateResponseOpenAI).not.toHaveBeenCalled();
  });

  it('returns ineligible when LLM returns null', async () => {
    mockCheckCredits.mockResolvedValue({ allowed: true });
    mockGenerateResponseOpenAI.mockResolvedValue(null);
    const result = await autoReplyService.generateAutoReply(baseInteraction(), ORG_ID, enabledOrg());
    expect(result.eligible).toBe(false);
    expect(result.reason).toBe('Failed to generate AI response');
    expect(mockDeductCredits).not.toHaveBeenCalled();
  });

  it('returns route-to-human shape when LLM self-assesses as unresolvable, but still charges credits', async () => {
    mockCheckCredits.mockResolvedValue({ allowed: true });
    mockGenerateResponseOpenAI.mockResolvedValue({
      resolvable: false,
      resolvableReason: 'Needs human empathy'
    });

    const result = await autoReplyService.generateAutoReply(baseInteraction(), ORG_ID, enabledOrg());

    expect(result).toEqual(expect.objectContaining({
      eligible: true,
      resolvable: false,
      resolvableReason: 'Needs human empathy',
      creditsUsed: 1
    }));
    expect(mockDeductCredits).toHaveBeenCalledTimes(1);
    const [, , metadata] = mockDeductCredits.mock.calls[0];
    expect(metadata.operation).toBe('auto_reply_unresolvable');
  });

  it('returns ineligible when LLM confidence is below the org threshold (no credit deduction)', async () => {
    mockCheckCredits.mockResolvedValue({ allowed: true });
    mockGenerateResponseOpenAI.mockResolvedValue({
      content: 'maybe',
      confidence: 0.4
    });

    const org = enabledOrg();
    org.autoReplySettings.minConfidence = 0.7;

    const result = await autoReplyService.generateAutoReply(baseInteraction(), ORG_ID, org);
    expect(result.eligible).toBe(false);
    expect(result.reason).toMatch(/Confidence 0.4 below threshold 0.7/);
    expect(result.response.confidence).toBe(0.4);
    expect(mockDeductCredits).not.toHaveBeenCalled();
  });

  it('uses the default minConfidence (0.7) when org does not set one', async () => {
    mockCheckCredits.mockResolvedValue({ allowed: true });
    mockGenerateResponseOpenAI.mockResolvedValue({ content: 'x', confidence: 0.69 });
    const result = await autoReplyService.generateAutoReply(baseInteraction(), ORG_ID, enabledOrg());
    expect(result.eligible).toBe(false);
  });

  it('returns success shape and deducts credits when confidence meets threshold', async () => {
    mockCheckCredits.mockResolvedValue({ allowed: true });
    mockGenerateResponseOpenAI.mockResolvedValue({
      content: 'Sure, here is your answer.',
      confidence: 0.9
    });

    const result = await autoReplyService.generateAutoReply(baseInteraction(), ORG_ID, enabledOrg());

    expect(result.eligible).toBe(true);
    expect(result.response.confidence).toBe(0.9);
    expect(result.creditsUsed).toBe(1);
    expect(mockDeductCredits).toHaveBeenCalledTimes(1);
    const [orgArg, costArg, metadata] = mockDeductCredits.mock.calls[0];
    expect(orgArg).toBe(ORG_ID);
    expect(costArg).toBe(1);
    expect(metadata.operation).toBe('auto_reply');
  });

  it('returns ineligible with the error message if generation throws', async () => {
    mockCheckCredits.mockResolvedValue({ allowed: true });
    mockGenerateResponseOpenAI.mockRejectedValue(new Error('boom'));
    const result = await autoReplyService.generateAutoReply(baseInteraction(), ORG_ID, enabledOrg());
    expect(result.eligible).toBe(false);
    expect(result.reason).toBe('boom');
  });
});
