/**
 * Tests for knowledgeBaseSearchService — the 3-stage KB search cascade.
 *
 * Covers each branch of the fallback ladder:
 *   - empty query → top-priority fallback (fromFallback: true)
 *   - text search hits → returns matches (fromFallback: false)
 *   - text search throws → falls through to keyword
 *   - text search empty + keyword hits → returns keyword matches
 *   - text search empty + keyword empty → top-priority fallback
 *   - tokens < 2 chars filtered out (no keyword branch taken for "hi" alone)
 *   - outer try/catch returns { entries: [], fromFallback: false } on fatal errors
 */

// ── Chainable Mongoose mock, declared inline in the factory ────────────────
// jest.mock() is hoisted, so any state it references must be created inside
// the factory. We stash it on global so the test body can read it.

jest.mock('../../../../src/models/KnowledgeBase', () => {
  const state = { findCalls: [], nextResults: [] };
  globalThis.__kbMockState = state;
  return {
    find: (filter) => {
      state.findCalls.push(filter);
      const chain = {
        select: () => chain,
        sort: () => chain,
        limit: () => chain,
        then(resolve, reject) {
          const next = state.nextResults.shift();
          if (!next) return resolve([]);
          if (next.ok) return resolve(next.v);
          return reject(next.e);
        }
      };
      return chain;
    }
  };
});

// escapeRegex is a pure util — use the real one.

const { searchKnowledgeBase } = require('../../../../src/services/ai/knowledgeBaseSearchService');

const state = globalThis.__kbMockState;
const pushResult = (v) => state.nextResults.push({ ok: true, v });
const pushError = (e) => state.nextResults.push({ ok: false, e });
const findCalls = state.findCalls;

beforeEach(() => {
  state.findCalls.length = 0;
  state.nextResults.length = 0;
});

// ── empty / blank query ────────────────────────────────────────────────────
describe('empty query → top-priority fallback', () => {
  it.each([
    ['undefined', undefined],
    ['empty string', ''],
    ['whitespace only', '   '],
    ['null', null]
  ])('%s returns fromFallback:true with the top-priority entries', async (_, input) => {
    const fallback = [{ _id: 'a', title: 'Always show' }];
    pushResult(fallback);

    const result = await searchKnowledgeBase('org_1', input, 5);
    expect(result).toEqual({ entries: fallback, fromFallback: true });
    // Exactly one .find call (the fallback), with no $text clause
    expect(findCalls).toHaveLength(1);
    expect(findCalls[0]).not.toHaveProperty('$text');
    expect(findCalls[0]).toEqual(expect.objectContaining({
      organization: 'org_1',
      isActive: true,
      isTrainingData: { $ne: false }
    }));
  });
});

// ── stage 1: text search hit ───────────────────────────────────────────────
describe('text search hits', () => {
  it('returns text results and skips keyword + fallback stages', async () => {
    const hits = [{ _id: 'kb1', title: 'Pricing' }];
    pushResult(hits);

    const result = await searchKnowledgeBase('org_1', 'pricing', 5);

    expect(result).toEqual({ entries: hits, fromFallback: false });
    expect(findCalls).toHaveLength(1);
    expect(findCalls[0].$text).toEqual({ $search: 'pricing' });
  });
});

// ── stage 1 error → stage 2 keyword ────────────────────────────────────────
describe('text search throws (e.g. no text index) → falls through', () => {
  it('swallows the text error and runs the keyword branch', async () => {
    pushError(new Error('text index missing'));
    const keywordHits = [{ _id: 'kb2', title: 'Hours' }];
    pushResult(keywordHits);

    const result = await searchKnowledgeBase('org_1', 'opening hours', 5);

    expect(result).toEqual({ entries: keywordHits, fromFallback: false });
    expect(findCalls).toHaveLength(2);
    expect(findCalls[0].$text).toEqual({ $search: 'opening hours' });
    expect(findCalls[1].$or).toHaveLength(2);
  });
});

// ── stage 2: keyword branch ────────────────────────────────────────────────
describe('stage 2 keyword branch', () => {
  it('builds $or with keyword $in and regex title match from query tokens', async () => {
    pushResult([]); // text search empty
    const keywordHits = [{ _id: 'kb3', title: 'Shipping' }];
    pushResult(keywordHits);

    await searchKnowledgeBase('org_1', 'shipping rates', 5);

    const filter = findCalls[1];
    expect(filter.$or[0]).toEqual({ keywords: { $in: ['shipping', 'rates'] } });
    // regex string is OR of escaped tokens, case-insensitive
    expect(filter.$or[1].title.$regex).toBe('shipping|rates');
    expect(filter.$or[1].title.$options).toBe('i');
  });

  it('preserves non-Latin script tokens for keyword matching (e.g. Devanagari)', async () => {
    pushResult([]);
    const keywordHits = [{ _id: 'kb-hi', title: 'Company' }];
    pushResult(keywordHits);

    await searchKnowledgeBase('org_1', 'नमस्ते दुनिया', 5);

    const filter = findCalls[1];
    expect(filter.$or[0].keywords.$in).toEqual(['नमस्ते', 'दुनिया']);
    expect(filter.$or[1].title.$regex).toBe('नमस्ते|दुनिया');
  });

  it('strips non-word chars and filters tokens < 2 chars', async () => {
    pushResult([]); // text search empty
    pushResult([{ _id: 'kb' }]);

    await searchKnowledgeBase('org_1', 'a! shipping? $$$ ok', 5);

    const filter = findCalls[1];
    // 'a' dropped (len<2), '!' stripped, '$$$' stripped (len 0)
    expect(filter.$or[0]).toEqual({ keywords: { $in: ['shipping', 'ok'] } });
  });

  it('caps tokens at 12 to avoid gigantic $in clauses', async () => {
    pushResult([]);
    pushResult([{ _id: 'kb' }]);

    const q = Array.from({ length: 20 }, (_, i) => `word${i}`).join(' ');
    await searchKnowledgeBase('org_1', q, 5);

    expect(findCalls[1].$or[0].keywords.$in).toHaveLength(12);
  });

  it('when all tokens are < 2 chars, skips keyword stage and goes straight to fallback', async () => {
    pushResult([]); // text search empty
    const fallback = [{ _id: 'f1' }];
    pushResult(fallback); // fallback

    const result = await searchKnowledgeBase('org_1', 'a b c', 5);

    expect(result).toEqual({ entries: fallback, fromFallback: true });
    expect(findCalls).toHaveLength(2);
    // 2nd call is the fallback (no $text, no $or on keywords/title)
    expect(findCalls[1]).not.toHaveProperty('$or');
    expect(findCalls[1]).not.toHaveProperty('$text');
  });
});

// ── stage 3: top-priority fallback ─────────────────────────────────────────
describe('stage 3 top-priority fallback', () => {
  it('runs when both text and keyword stages return empty', async () => {
    pushResult([]); // text
    pushResult([]); // keyword
    const fallback = [{ _id: 'f1', title: 'Always' }];
    pushResult(fallback);

    const result = await searchKnowledgeBase('org_1', 'nothing matches', 5);

    expect(result).toEqual({ entries: fallback, fromFallback: true });
    expect(findCalls).toHaveLength(3);
  });
});

// ── outer try/catch ────────────────────────────────────────────────────────
describe('fatal errors', () => {
  it('returns { entries: [], fromFallback: false } if the top-priority fallback throws too', async () => {
    pushError(new Error('mongo dead'));

    const result = await searchKnowledgeBase('org_1', '', 5);
    expect(result).toEqual({ entries: [], fromFallback: false });
  });

  it('returns empty result when keyword branch throws after text stage is empty', async () => {
    pushResult([]); // text: empty
    pushError(new Error('keyword crashed'));

    const result = await searchKnowledgeBase('org_1', 'hello world', 5);
    expect(result).toEqual({ entries: [], fromFallback: false });
  });
});

// ── filter invariants ──────────────────────────────────────────────────────
describe('filter invariants', () => {
  it('always scopes queries to the caller organization + active + training-data', async () => {
    pushResult([{ _id: 'x' }]);
    await searchKnowledgeBase('org_42', 'hello', 5);

    expect(findCalls[0]).toEqual(expect.objectContaining({
      organization: 'org_42',
      isActive: true,
      isTrainingData: { $ne: false }
    }));
  });
});
