'use strict';

/**
 * flowKeywordOverlapService — design-time multi-flow keyword-conflict guard.
 *
 * Covers:
 *   - keywordListsOverlap(): the pure substring-match rule, mirrored from
 *     flowTriggerRouter.matchesTrigger() so design-time warnings never disagree with
 *     runtime behavior.
 *   - resolveOverlapForPublish(): the decision used by POST /:id/publish —
 *       * blocks when there's a conflict and it hasn't been acknowledged
 *       * allows + records the acknowledgement when acknowledgeOverlap: true
 *       * allows silently on a repeat publish with the same already-acknowledged keywords
 *       * clears a stale acknowledgement once the conflict is gone
 */

const AutomationFlow = require('../../../../src/models/AutomationFlow');
const {
  keywordListsOverlap,
  resolveOverlapForPublish
} = require('../../../../src/services/flow/flowKeywordOverlapService');

const ORG_ID = '507f1f77bcf86cd799439011';

function makeFlow(overrides = {}) {
  return {
    _id: '507f1f77bcf86cd799439099',
    name: 'My Flow',
    channels: ['whatsapp'],
    nodes: [{ id: 'n1', type: 'trigger.keyword', config: { keywords: ['product', 'price'] } }],
    acknowledgedOverlap: { flag: false, keywords: [], conflictingFlowIds: [], at: null },
    ...overrides
  };
}

afterEach(() => jest.restoreAllMocks());

describe('keywordListsOverlap (pure)', () => {
  it('matches identical keywords', () => {
    expect(keywordListsOverlap(['product'], ['product'])).toBe(true);
  });

  it('matches substrings either direction (mirrors runtime text.includes(keyword))', () => {
    expect(keywordListsOverlap(['detail'], ['details'])).toBe(true);
    expect(keywordListsOverlap(['detailed-info'], ['detail'])).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(keywordListsOverlap(['Want'], ['want'])).toBe(true);
  });

  it('returns false for genuinely unrelated keywords', () => {
    expect(keywordListsOverlap(['refund'], ['book'])).toBe(false);
  });

  it('treats an empty keyword list as matching everything (same as matchesTrigger at runtime)', () => {
    expect(keywordListsOverlap([], ['anything'])).toBe(true);
    expect(keywordListsOverlap(['anything'], [])).toBe(true);
  });
});

describe('resolveOverlapForPublish', () => {
  it('allows publish with no blocking when there is no keyword trigger on the flow', async () => {
    const flow = makeFlow({ nodes: [{ id: 'n1', type: 'action.send_text', config: {} }] });
    const result = await resolveOverlapForPublish(flow, ORG_ID, false);
    expect(result.blocked).toBe(false);
  });

  it('blocks publish when another active flow has an overlapping keyword and it is not acknowledged', async () => {
    jest.spyOn(AutomationFlow, 'find').mockReturnValue({
      select: () => ({
        lean: async () => [
          { _id: 'other_flow_1', name: 'Other Active Flow', nodes: [{ id: 'x', type: 'trigger.keyword', config: { keywords: ['product'] } }] }
        ]
      })
    });

    const flow = makeFlow();
    const result = await resolveOverlapForPublish(flow, ORG_ID, /* acknowledgeOverlap */ false);

    expect(result.blocked).toBe(true);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0].flowName).toBe('Other Active Flow');
  });

  it('allows publish and records the acknowledgement when acknowledgeOverlap: true', async () => {
    jest.spyOn(AutomationFlow, 'find').mockReturnValue({
      select: () => ({
        lean: async () => [
          { _id: 'other_flow_1', name: 'Other Active Flow', nodes: [{ id: 'x', type: 'trigger.keyword', config: { keywords: ['product'] } }] }
        ]
      })
    });

    const flow = makeFlow();
    const result = await resolveOverlapForPublish(flow, ORG_ID, /* acknowledgeOverlap */ true);

    expect(result.blocked).toBe(false);
    expect(result.acknowledgedOverlapUpdate).toMatchObject({
      flag: true,
      conflictingFlowIds: ['other_flow_1']
    });
    expect(result.acknowledgedOverlapUpdate.keywords.sort()).toEqual(['price', 'product']);
  });

  it('allows silently (without requiring acknowledgeOverlap again) once already acknowledged for the same keywords', async () => {
    jest.spyOn(AutomationFlow, 'find').mockReturnValue({
      select: () => ({
        lean: async () => [
          { _id: 'other_flow_1', name: 'Other Active Flow', nodes: [{ id: 'x', type: 'trigger.keyword', config: { keywords: ['product'] } }] }
        ]
      })
    });

    const flow = makeFlow({
      acknowledgedOverlap: { flag: true, keywords: ['price', 'product'], conflictingFlowIds: ['other_flow_1'], at: new Date() }
    });
    const result = await resolveOverlapForPublish(flow, ORG_ID, /* acknowledgeOverlap */ false);

    expect(result.blocked).toBe(false);
  });

  it('resets a stale acknowledgement once the conflict is gone (no other flow overlaps anymore)', async () => {
    jest.spyOn(AutomationFlow, 'find').mockReturnValue({
      select: () => ({ lean: async () => [] }) // no other active flows at all now
    });

    const flow = makeFlow({
      acknowledgedOverlap: { flag: true, keywords: ['price', 'product'], conflictingFlowIds: ['old_flow'], at: new Date() }
    });
    const result = await resolveOverlapForPublish(flow, ORG_ID, false);

    expect(result.blocked).toBe(false);
    expect(result.acknowledgedOverlapUpdate).toEqual({ flag: false, keywords: [], conflictingFlowIds: [], at: null });
  });

  it('re-blocks if the keywords changed since the last acknowledgement (stale ack must not silently cover a NEW conflict)', async () => {
    jest.spyOn(AutomationFlow, 'find').mockReturnValue({
      select: () => ({
        lean: async () => [
          { _id: 'other_flow_2', name: 'Yet Another Flow', nodes: [{ id: 'x', type: 'trigger.keyword', config: { keywords: ['price'] } }] }
        ]
      })
    });

    // Previously acknowledged a conflict for ["book","appointment"], but the flow's keywords
    // have since changed to ["price","product"] (which conflicts with a DIFFERENT flow).
    const flow = makeFlow({
      acknowledgedOverlap: { flag: true, keywords: ['appointment', 'book'], conflictingFlowIds: ['some_old_flow'], at: new Date() }
    });
    const result = await resolveOverlapForPublish(flow, ORG_ID, false);

    expect(result.blocked).toBe(true);
    expect(result.conflicts[0].flowName).toBe('Yet Another Flow');
  });
});
