/**
 * Unit tests for inboxAiAssistService.
 *
 * Strategy: mock all external collaborators (Mongoose models, aiService,
 * aiCreditService, cacheService, ALS context wrapper) and verify the
 * orchestration contracts:
 *   - InboxAiError statusCode/code/payload
 *   - 404 / 403 / 400 ownership and validation guards
 *   - credit deduct + rollback atomicity
 *   - shared conversation context + KB context primitives
 *   - batch auto-reply: pre-loop guards throw, per-item failures don't
 */

'use strict';

// ─── jest.mock for all collaborators ────────────────────────────────────────

const chainable = (final) => ({
  sort: jest.fn().mockReturnThis(),
  limit: jest.fn().mockReturnThis(),
  populate: jest.fn().mockReturnThis(),
  lean: jest.fn().mockResolvedValue(final ?? [])
});

jest.mock('../../../../src/models/Interaction', () => ({
  findById: jest.fn(),
  find: jest.fn()
}));

jest.mock('../../../../src/models/Organization', () => ({
  findById: jest.fn()
}));

jest.mock('../../../../src/services/aiService', () => ({
  generateResponse: jest.fn(),
  generateText: jest.fn(),
  generateAutoReply: jest.fn(),
  searchKnowledgeBase: jest.fn()
}));

jest.mock('../../../../src/services/ai/brandContextService', () => ({
  getBrandContext: jest.fn()
}));

jest.mock('../../../../src/services/aiCreditService', () => ({
  checkCredits: jest.fn(),
  deductCredits: jest.fn(),
  rollbackCredits: jest.fn(),
  getUsage: jest.fn()
}));

jest.mock('../../../../src/services/cacheService', () => ({
  delPattern: jest.fn().mockResolvedValue(undefined),
  invalidateInteractionCaches: jest.fn().mockResolvedValue(undefined)
}));

jest.mock('../../../../src/services/aiRequestContext', () => ({
  // Pass-through wrapper: invoke the fn, return { result, aiApiUsageId }
  runWithAiContextAndUsageId: jest.fn(async (_ctx, fn) => ({
    result: await fn(),
    aiApiUsageId: 'usage_test_1'
  }))
}));

jest.mock('../../../../src/integrations/google/youtubeService', () => ({
  replyToComment: jest.fn()
}));

jest.mock('../../../../src/config/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn()
}));

const Interaction = require('../../../../src/models/Interaction');
const Organization = require('../../../../src/models/Organization');
const aiService = require('../../../../src/services/aiService');
const brandContextService = require('../../../../src/services/ai/brandContextService');
const aiCreditService = require('../../../../src/services/aiCreditService');
const cacheService = require('../../../../src/services/cacheService');
const youtubeService = require('../../../../src/integrations/google/youtubeService');

const svc = require('../../../../src/services/inbox/inboxAiAssistService');

// ─── fixtures ───────────────────────────────────────────────────────────────

const ORG_ID = 'org_001';
const USER_ID = 'user_001';

function makeUser() {
  return {
    _id: USER_ID,
    organization: { _id: ORG_ID }
  };
}

function makeInteraction(overrides = {}) {
  return {
    _id: { toString: () => 'int_42' },
    organization: { toString: () => ORG_ID },
    platformId: 'plat_int_42',
    platform: 'instagram',
    type: 'comment',
    content: 'Hello world',
    sentiment: 'positive',
    author: { name: 'Customer A' },
    replies: [],
    lastMessage: { content: 'older msg' },
    ...overrides
  };
}

beforeEach(() => {
  // resetAllMocks (not clearAllMocks) is required: clearAllMocks does NOT
  // drain the `mockReturnValueOnce` queue, which would leak between tests.
  jest.resetAllMocks();

  // Re-prime defaults the resetAllMocks just nuked.
  aiCreditService.checkCredits.mockResolvedValue({ allowed: true, current: 5, limit: 100, remaining: 95 });
  aiCreditService.deductCredits.mockResolvedValue(undefined);
  aiCreditService.rollbackCredits.mockResolvedValue(undefined);
  aiCreditService.getUsage.mockResolvedValue({ current: 6, limit: 100, remaining: 94 });
  Interaction.find.mockReturnValue(chainable([]));
  aiService.searchKnowledgeBase.mockResolvedValue({ entries: [], fromFallback: false });
  brandContextService.getBrandContext.mockResolvedValue(null);
  cacheService.delPattern.mockResolvedValue(undefined);
  cacheService.invalidateInteractionCaches.mockResolvedValue(undefined);
  // ALS context wrapper: pass-through
  const ctx = require('../../../../src/services/aiRequestContext');
  ctx.runWithAiContextAndUsageId.mockImplementation(async (_c, fn) => ({
    result: await fn(),
    aiApiUsageId: 'usage_test_1'
  }));
});

// ─── error class + response helper ──────────────────────────────────────────

describe('InboxAiError', () => {
  test('default statusCode is 500 when not specified', () => {
    const e = new svc.InboxAiError('boom');
    expect(e.statusCode).toBe(500);
    expect(e.code).toBeNull();
    expect(e.payload).toBeNull();
  });
  test('preserves provided statusCode/code/payload', () => {
    const e = new svc.InboxAiError('forbidden', { statusCode: 403, code: 'NOPE', payload: { credits: { remaining: 0 } } });
    expect(e.statusCode).toBe(403);
    expect(e.code).toBe('NOPE');
    expect(e.payload.credits.remaining).toBe(0);
  });
});

describe('respondInboxAiError', () => {
  function mockRes() {
    return { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
  }
  test('writes statusCode + standard body shape', () => {
    const res = mockRes();
    svc.respondInboxAiError(res, new svc.InboxAiError('not found', { statusCode: 404, code: 'X' }));
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ success: false, error: 'not found', code: 'X' });
  });
  test('merges payload object into body', () => {
    const res = mockRes();
    svc.respondInboxAiError(res, new svc.InboxAiError('quota', {
      statusCode: 403, code: 'AI_CREDITS_EXCEEDED', payload: { credits: { remaining: 0 } }
    }));
    expect(res.json).toHaveBeenCalledWith({
      success: false, error: 'quota', code: 'AI_CREDITS_EXCEEDED', credits: { remaining: 0 }
    });
  });
});

// ─── primitives ─────────────────────────────────────────────────────────────

describe('loadOwnedInteraction', () => {
  test('throws 400 when interactionId is falsy', async () => {
    await expect(svc.loadOwnedInteraction(null, ORG_ID))
      .rejects.toMatchObject({ statusCode: 400, code: 'MISSING_INTERACTION_ID' });
  });
  test('throws 404 when not found', async () => {
    Interaction.findById.mockResolvedValue(null);
    await expect(svc.loadOwnedInteraction('int_x', ORG_ID))
      .rejects.toMatchObject({ statusCode: 404, code: 'INTERACTION_NOT_FOUND' });
  });
  test('throws 403 when org mismatch', async () => {
    Interaction.findById.mockResolvedValue({
      organization: { toString: () => 'OTHER_ORG' }
    });
    await expect(svc.loadOwnedInteraction('int_x', ORG_ID))
      .rejects.toMatchObject({ statusCode: 403, code: 'FORBIDDEN' });
  });
  test('returns interaction when owned', async () => {
    const i = makeInteraction();
    Interaction.findById.mockResolvedValue(i);
    await expect(svc.loadOwnedInteraction('int_42', ORG_ID)).resolves.toBe(i);
  });
});

describe('ensureCreditsAvailable', () => {
  test('returns the check when allowed', async () => {
    const r = await svc.ensureCreditsAvailable(ORG_ID, 1);
    expect(r.allowed).toBe(true);
    expect(aiCreditService.checkCredits).toHaveBeenCalledWith(ORG_ID, 1);
  });
  test('throws InboxAiError 403 with credits payload when not allowed', async () => {
    aiCreditService.checkCredits.mockResolvedValueOnce({
      allowed: false, current: 100, limit: 100, remaining: 0,
      code: 'AI_CREDITS_EXCEEDED', error: 'Quota exhausted'
    });
    let caught;
    try { await svc.ensureCreditsAvailable(ORG_ID, 1); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(svc.InboxAiError);
    expect(caught.statusCode).toBe(403);
    expect(caught.code).toBe('AI_CREDITS_EXCEEDED');
    expect(caught.payload).toEqual({ credits: { current: 100, limit: 100, remaining: 0 } });
  });
});

describe('buildConversationContext', () => {
  test('joins parent + children + replies in order', async () => {
    Interaction.find.mockReturnValueOnce(chainable([
      { content: 'child msg 1' },
      { content: 'child msg 2' }
    ]));
    const interaction = makeInteraction({
      content: 'parent msg',
      replies: [
        { content: 'agent reply', isPlatformReply: false, status: 'active' },
        { content: 'cust follow', isPlatformReply: true, status: 'active' },
        { content: 'deleted one', status: 'deleted' }
      ]
    });
    const ctx = await svc.buildConversationContext(interaction, ORG_ID);
    expect(ctx.replyCount).toBe(2);
    expect(ctx.childCount).toBe(2);
    expect(ctx.chatContext).toContain('Customer (Customer A): "parent msg"');
    expect(ctx.chatContext).toContain('Customer: "child msg 2"');
    expect(ctx.chatContext).toContain('Agent: "agent reply"');
    expect(ctx.chatContext).toContain('Customer: "cust follow"');
    expect(ctx.chatContext).not.toContain('deleted one');
  });

  test('limits to MAX_CHILD_INTERACTIONS via limit() chain', async () => {
    const limitSpy = jest.fn().mockReturnThis();
    Interaction.find.mockReturnValueOnce({
      sort: jest.fn().mockReturnThis(),
      limit: limitSpy,
      lean: jest.fn().mockResolvedValue([])
    });
    await svc.buildConversationContext(makeInteraction(), ORG_ID);
    expect(limitSpy).toHaveBeenCalledWith(svc.MAX_CHILD_INTERACTIONS);
  });
});

describe('fetchKnowledgeBaseContext', () => {
  test('empty entries → empty context', async () => {
    aiService.searchKnowledgeBase.mockResolvedValueOnce({ entries: [], fromFallback: false });
    const r = await svc.fetchKnowledgeBaseContext(ORG_ID, 'q');
    expect(r.kbContext).toBe('');
    expect(r.usedKnowledgeBase).toBe(false);
    expect(r.knowledgeBaseCount).toBe(0);
  });

  test('caps each entry to maxEntryChars and appends ellipsis', async () => {
    const long = 'x'.repeat(800);
    aiService.searchKnowledgeBase.mockResolvedValueOnce({
      entries: [{ title: 'A', content: long, incrementUsage: jest.fn().mockResolvedValue() }],
      fromFallback: false
    });
    const r = await svc.fetchKnowledgeBaseContext(ORG_ID, 'q', { maxEntryChars: 100 });
    expect(r.kbContext).toBe(`A: ${'x'.repeat(100)}…`);
    expect(r.usedKnowledgeBase).toBe(true);
    expect(r.knowledgeBaseCount).toBe(1);
  });

  test('fallback results do NOT increment usage', async () => {
    const inc = jest.fn().mockResolvedValue();
    aiService.searchKnowledgeBase.mockResolvedValueOnce({
      entries: [{ title: 'A', content: 'a', incrementUsage: inc }],
      fromFallback: true
    });
    await svc.fetchKnowledgeBaseContext(ORG_ID, 'q');
    expect(inc).not.toHaveBeenCalled();
  });

  test('non-fallback results DO increment usage (best-effort)', async () => {
    const inc1 = jest.fn().mockResolvedValue();
    const inc2 = jest.fn().mockRejectedValue(new Error('db down'));
    aiService.searchKnowledgeBase.mockResolvedValueOnce({
      entries: [
        { title: 'A', content: 'a', incrementUsage: inc1 },
        { title: 'B', content: 'b', incrementUsage: inc2 }
      ],
      fromFallback: false
    });
    await svc.fetchKnowledgeBaseContext(ORG_ID, 'q');
    expect(inc1).toHaveBeenCalled();
    expect(inc2).toHaveBeenCalled();
    // No throw — best-effort
  });

  test('searchKnowledgeBase failure → empty context, no throw', async () => {
    aiService.searchKnowledgeBase.mockRejectedValueOnce(new Error('boom'));
    const r = await svc.fetchKnowledgeBaseContext(ORG_ID, 'q');
    expect(r).toEqual({ kbContext: '', kbEntries: [], usedKnowledgeBase: false, knowledgeBaseCount: 0 });
  });
});

describe('runWithCreditDeductAndRollback', () => {
  test('happy path: invokes aiCall, then deducts 1 credit', async () => {
    const out = await svc.runWithCreditDeductAndRollback({
      orgId: ORG_ID, user: makeUser(), operation: 'op_x', metadata: { x: 1 },
      aiCall: async () => ({ result: 'OK', aiApiUsageId: 'u1' })
    });
    expect(out).toEqual({ result: 'OK', aiApiUsageId: 'u1', deducted: 1 });
    expect(aiCreditService.deductCredits).toHaveBeenCalledWith(
      ORG_ID, 1,
      expect.objectContaining({ operation: 'op_x', userId: USER_ID, x: 1 }),
      { aiApiUsageId: 'u1' }
    );
    expect(aiCreditService.rollbackCredits).not.toHaveBeenCalled();
  });

  test('aiCall throws BEFORE deduct → no rollback (nothing deducted yet)', async () => {
    await expect(svc.runWithCreditDeductAndRollback({
      orgId: ORG_ID, user: makeUser(), operation: 'op_x', metadata: {},
      aiCall: async () => { throw new Error('AI down'); }
    })).rejects.toThrow('AI down');
    expect(aiCreditService.deductCredits).not.toHaveBeenCalled();
    expect(aiCreditService.rollbackCredits).not.toHaveBeenCalled();
  });

  test('translates 401 into AI_CREDENTIALS_INVALID InboxAiError', async () => {
    const err401 = Object.assign(new Error('unauth'), { response: { status: 401 } });
    let caught;
    try {
      await svc.runWithCreditDeductAndRollback({
        orgId: ORG_ID, user: makeUser(), operation: 'op_x', metadata: {},
        aiCall: async () => { throw err401; }
      });
    } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(svc.InboxAiError);
    expect(caught.code).toBe('AI_CREDENTIALS_INVALID');
    expect(caught.statusCode).toBe(500);
  });
});

// ─── orchestrators ──────────────────────────────────────────────────────────

describe('suggestReplyFor', () => {
  beforeEach(() => {
    Interaction.findById.mockResolvedValue(makeInteraction());
    aiService.generateResponse.mockResolvedValue({
      content: 'AI suggested reply',
      confidence: 0.9,
      usedKnowledgeBase: false,
      knowledgeBaseCount: 0
    });
  });

  test('happy path: returns data + credits, deducts once', async () => {
    const out = await svc.suggestReplyFor({ interactionId: 'int_42', user: makeUser() });
    expect(out.data.suggestedReply).toBe('AI suggested reply');
    expect(out.data.confidence).toBe(0.9);
    expect(out.credits).toEqual({ current: 6, limit: 100, remaining: 94 });
    expect(aiCreditService.deductCredits).toHaveBeenCalledTimes(1);
  });

  test('insufficient credits → InboxAiError 403, no AI call', async () => {
    aiCreditService.checkCredits.mockResolvedValueOnce({
      allowed: false, current: 100, limit: 100, remaining: 0
    });
    await expect(svc.suggestReplyFor({ interactionId: 'int_42', user: makeUser() }))
      .rejects.toMatchObject({ statusCode: 403, code: 'INSUFFICIENT_CREDITS' });
    expect(aiService.generateResponse).not.toHaveBeenCalled();
    expect(aiCreditService.deductCredits).not.toHaveBeenCalled();
  });

  test('AI returns null → InboxAiError AI_GENERATION_FAILED + no deduct', async () => {
    aiService.generateResponse.mockResolvedValueOnce(null);
    await expect(svc.suggestReplyFor({ interactionId: 'int_42', user: makeUser() }))
      .rejects.toMatchObject({ code: 'AI_GENERATION_FAILED' });
    expect(aiCreditService.deductCredits).not.toHaveBeenCalled();
    expect(aiCreditService.rollbackCredits).not.toHaveBeenCalled();
  });

  test('AI 401 → translated to AI_CREDENTIALS_INVALID', async () => {
    aiService.generateResponse.mockRejectedValueOnce(
      Object.assign(new Error('bad key'), { response: { status: 401 } })
    );
    await expect(svc.suggestReplyFor({ interactionId: 'int_42', user: makeUser() }))
      .rejects.toMatchObject({ code: 'AI_CREDENTIALS_INVALID', statusCode: 500 });
  });
});

describe('generateAssistTriple', () => {
  beforeEach(() => {
    Interaction.findById.mockResolvedValue(makeInteraction());
    // Real aiService.generateText returns a string (the generated text).
    aiService.generateText.mockResolvedValue('reply text');
  });

  test('happy path: fires 3 generateText calls, deducts ONCE total', async () => {
    const out = await svc.generateAssistTriple({ interactionId: 'int_42', user: makeUser() });
    expect(aiService.generateText).toHaveBeenCalledTimes(3);
    expect(aiCreditService.deductCredits).toHaveBeenCalledTimes(1);
    expect(out.data).toMatchObject({
      short: 'reply text',
      detailed: 'reply text',
      sales: 'reply text',
      usedKnowledgeBase: false,
      knowledgeBaseCount: 0
    });
  });

  test('includes current Brand Hub voice in every assist variant', async () => {
    brandContextService.getBrandContext.mockResolvedValue(
      'Writing style: premium watch specialist. Brand character: refined.'
    );

    await svc.generateAssistTriple({ interactionId: 'int_42', user: makeUser() });

    expect(brandContextService.getBrandContext).toHaveBeenCalledWith(ORG_ID);
    for (const [systemPrompt] of aiService.generateText.mock.calls) {
      expect(systemPrompt).toContain('CURRENT BRAND VOICE');
      expect(systemPrompt).toContain('premium watch specialist');
    }
  });

  test('one of the three AI calls fails → no credit deducted (atomic)', async () => {
    aiService.generateText
      .mockResolvedValueOnce('short')
      .mockRejectedValueOnce(new Error('detailed boom'))
      .mockResolvedValueOnce('sales');
    await expect(svc.generateAssistTriple({ interactionId: 'int_42', user: makeUser() }))
      .rejects.toThrow('detailed boom');
    expect(aiCreditService.deductCredits).not.toHaveBeenCalled();
    expect(aiCreditService.rollbackCredits).not.toHaveBeenCalled();
  });

  test('uses the configured maxTokens/temperature for each variant', async () => {
    await svc.generateAssistTriple({ interactionId: 'int_42', user: makeUser() });
    const calls = aiService.generateText.mock.calls;
    const opts = calls.map((c) => c[2]);
    expect(opts).toEqual(expect.arrayContaining([
      { temperature: 0.6, maxTokens: 100 },
      { temperature: 0.7, maxTokens: 300 },
      { temperature: 0.75, maxTokens: 250 }
    ]));
  });
});

describe('regenerateAssistOne', () => {
  beforeEach(() => {
    Interaction.findById.mockResolvedValue(makeInteraction());
    aiService.generateText.mockResolvedValue('fresh take');
  });

  test('rejects unknown type with 400 INVALID_REPLY_TYPE', async () => {
    await expect(svc.regenerateAssistOne({
      interactionId: 'int_42', user: makeUser(), type: 'bogus'
    })).rejects.toMatchObject({ statusCode: 400, code: 'INVALID_REPLY_TYPE' });
    expect(aiService.generateText).not.toHaveBeenCalled();
  });

  test.each(['short', 'detailed', 'sales'])(
    'accepts %p type and uses regenerateTemperature',
    async (type) => {
      await svc.regenerateAssistOne({
        interactionId: 'int_42', user: makeUser(), type
      });
      const opts = aiService.generateText.mock.calls[0][2];
      expect(opts.temperature).toBe(svc.REPLY_TYPES[type].regenerateTemperature);
      expect(opts.maxTokens).toBe(svc.REPLY_TYPES[type].maxTokens);
    }
  );

  test('returns { type, content } shape', async () => {
    const out = await svc.regenerateAssistOne({
      interactionId: 'int_42', user: makeUser(), type: 'short'
    });
    expect(out.data).toEqual({ type: 'short', content: 'fresh take' });
    expect(aiCreditService.deductCredits).toHaveBeenCalledTimes(1);
  });
});

// ─── batch auto-reply ──────────────────────────────────────────────────────

describe('processAutoReplyBatch (mode=full)', () => {
  function makeOrg({ autoReplySettings: arsOverride = {}, ...rest } = {}) {
    return {
      autoReplySettings: {
        enabled: true,
        repliesCountToday: 0,
        maxRepliesPerDay: 100,
        lastReplyResetDate: new Date(),
        autoSend: false,
        requireApproval: false,
        ...arsOverride
      },
      save: jest.fn().mockResolvedValue(undefined),
      ...rest
    };
  }

  test('throws ORG_NOT_FOUND if Organization missing', async () => {
    Organization.findById.mockResolvedValue(null);
    await expect(svc.processAutoReplyBatch({ user: makeUser(), interactionIds: [] }))
      .rejects.toMatchObject({ statusCode: 404, code: 'ORG_NOT_FOUND' });
  });

  test('throws AUTO_REPLY_DISABLED when feature off', async () => {
    Organization.findById.mockResolvedValue(makeOrg({ autoReplySettings: { enabled: false } }));
    await expect(svc.processAutoReplyBatch({ user: makeUser(), interactionIds: [] }))
      .rejects.toMatchObject({ statusCode: 400, code: 'AUTO_REPLY_DISABLED' });
  });

  test('throws AUTO_REPLY_DAILY_LIMIT when at quota', async () => {
    Organization.findById.mockResolvedValue(makeOrg({
      autoReplySettings: { enabled: true, repliesCountToday: 100, maxRepliesPerDay: 100 }
    }));
    Interaction.find.mockReturnValueOnce(chainable([]));
    await expect(svc.processAutoReplyBatch({ user: makeUser(), interactionIds: [] }))
      .rejects.toMatchObject({ statusCode: 429, code: 'AUTO_REPLY_DAILY_LIMIT' });
  });

  test('per-item AI failure does NOT abort the batch', async () => {
    const org = makeOrg();
    Organization.findById.mockResolvedValue(org);
    const i1 = makeInteraction({ _id: 'i1', platformConnection: { status: 'connected' } });
    const i2 = makeInteraction({ _id: 'i2', platformConnection: { status: 'connected' } });
    Interaction.find.mockReturnValueOnce({
      populate: jest.fn().mockReturnThis(),
      limit: jest.fn().mockResolvedValue([i1, i2])
    });
    aiService.generateAutoReply
      .mockRejectedValueOnce(new Error('AI down'))
      .mockResolvedValueOnce({ eligible: true, response: { content: 'r2', confidence: 0.5 } });
    const out = await svc.processAutoReplyBatch({ user: makeUser(), interactionIds: [], mode: 'full' });
    expect(out.failed).toBe(1);
    expect(out.generated).toBe(1);
    expect(out.details).toHaveLength(2);
  });

  test('autoSend honored only when org allows it', async () => {
    const org = makeOrg({ autoReplySettings: { enabled: true, autoSend: true, requireApproval: false } });
    Organization.findById.mockResolvedValue(org);
    const i = makeInteraction({
      _id: 'i1',
      platform: 'youtube',
      platformConnection: { status: 'connected' },
      addReply: jest.fn().mockResolvedValue(undefined),
      save: jest.fn().mockResolvedValue(undefined)
    });
    Interaction.find.mockReturnValueOnce({
      populate: jest.fn().mockReturnThis(),
      limit: jest.fn().mockResolvedValue([i])
    });
    aiService.generateAutoReply.mockResolvedValueOnce({
      eligible: true, response: { content: 'ok', confidence: 0.7 }
    });
    youtubeService.replyToComment.mockResolvedValueOnce({ success: true, commentId: 'yt_c1' });
    const out = await svc.processAutoReplyBatch({ user: makeUser(), interactionIds: [], autoSend: true, mode: 'full' });
    expect(out.sent).toBe(1);
    expect(youtubeService.replyToComment).toHaveBeenCalled();
    expect(i.addReply).toHaveBeenCalled();
  });

  test('autoSend off → marks generated, does NOT send', async () => {
    const org = makeOrg({ autoReplySettings: { enabled: true, autoSend: false, requireApproval: true } });
    Organization.findById.mockResolvedValue(org);
    const i = makeInteraction({ _id: 'i1', platformConnection: { status: 'connected' } });
    Interaction.find.mockReturnValueOnce({
      populate: jest.fn().mockReturnThis(),
      limit: jest.fn().mockResolvedValue([i])
    });
    aiService.generateAutoReply.mockResolvedValueOnce({
      eligible: true, response: { content: 'ok', confidence: 0.7 }
    });
    const out = await svc.processAutoReplyBatch({ user: makeUser(), interactionIds: [], autoSend: true, mode: 'full' });
    expect(out.sent).toBe(0);
    expect(out.generated).toBe(1);
    expect(youtubeService.replyToComment).not.toHaveBeenCalled();
  });

  test('skips when autoReply.eligible === false', async () => {
    const org = makeOrg();
    Organization.findById.mockResolvedValue(org);
    const i = makeInteraction({ _id: 'i1' });
    Interaction.find.mockReturnValueOnce({
      populate: jest.fn().mockReturnThis(),
      limit: jest.fn().mockResolvedValue([i])
    });
    aiService.generateAutoReply.mockResolvedValueOnce({ eligible: false, reason: 'too short' });
    const out = await svc.processAutoReplyBatch({ user: makeUser(), interactionIds: [], mode: 'full' });
    expect(out.skipped).toBe(1);
    expect(out.details[0]).toMatchObject({ status: 'skipped', reason: 'too short' });
  });

  test('invalidates inbox cache after a non-test batch', async () => {
    Organization.findById.mockResolvedValue(makeOrg());
    Interaction.find.mockReturnValueOnce({
      populate: jest.fn().mockReturnThis(),
      limit: jest.fn().mockResolvedValue([])
    });
    await svc.processAutoReplyBatch({ user: makeUser(), interactionIds: [], mode: 'full' });
    expect(cacheService.invalidateInteractionCaches).toHaveBeenCalledWith(ORG_ID);
  });

  test('mode=test does NOT require feature flag and does NOT touch cache', async () => {
    Organization.findById.mockResolvedValue(makeOrg({ autoReplySettings: { enabled: false } }));
    Interaction.find.mockReturnValueOnce({
      populate: jest.fn().mockReturnThis(),
      limit: jest.fn().mockResolvedValue([])
    });
    const out = await svc.processAutoReplyBatch({ user: makeUser(), interactionIds: [], mode: 'test' });
    expect(out).toMatchObject({ found: 0, processed: 0, sent: 0, skipped: 0 });
    expect(cacheService.delPattern).not.toHaveBeenCalled();
  });
});
