'use strict';

/**
 * flowExecutorService — wait.user_reply branch resolution.
 *
 * Bug this protects against: the Flow Builder's edge-label inspector offers
 * ['yes', 'no', 'reply', 'no_reply'] as quick-pick chips for a `wait.user_reply`
 * node's outgoing edges (see edgeBranchPresets in flow-builder.component.ts) — a very
 * natural way for an author to build a Yes/No question. But the resume logic only ever
 * looked at WHY the enrollment resumed (an actual reply vs a timeout), never at WHAT the
 * contact said. Since "yes" also doubles as the generic "a-reply-arrived" branch label,
 * EVERY reply — including an explicit "No" typed by the customer, or a "No" button tap —
 * was silently routed down the "yes" edge. Only a real timeout ever reached the "no" edge.
 * This is a generic, template-agnostic bug: any new flow built with a Yes/No question
 * wired directly off a wait.user_reply node hits it.
 */

jest.mock('../../../../src/services/flow/flowNodeHandlers', () => ({
  executeNodeHandler: jest.fn()
}));

const { executeNodeHandler } = require('../../../../src/services/flow/flowNodeHandlers');
const flowExecutorService = require('../../../../src/services/flow/flowExecutorService');

function makeEnrollment(currentNodeId) {
  return {
    _id: 'enr_1',
    organization: 'org_1',
    currentNodeId,
    status: 'active',
    history: [],
    variables: {},
    nextRunAt: null,
    lastError: ''
  };
}

// Wait node with two content-labelled branches, exactly as the UI's "yes"/"no" chips build it.
const flow = {
  _id: 'flow_1',
  nodes: [
    { id: 'wait', type: 'wait.user_reply', config: { timeoutSec: 3600 } },
    { id: 'yesNode', type: 'action.send_text', config: { text: 'Great, shipping now!' } },
    { id: 'noNode', type: 'action.send_text', config: { text: 'No worries, let us know if you change your mind.' } }
  ],
  edges: [
    { id: 'e_yes', source: 'wait', target: 'yesNode', label: 'yes' },
    { id: 'e_no', source: 'wait', target: 'noNode', label: 'no' }
  ]
};

beforeEach(() => {
  jest.clearAllMocks();
  executeNodeHandler.mockImplementation(async () => ({ status: 'completed', nextNodeId: null }));
});

describe('flowExecutorService — wait.user_reply branch resolution by reply content', () => {
  it('routes an explicit "No" reply down the "no"-labelled edge, not the "yes" edge', async () => {
    const enrollment = makeEnrollment('wait');
    const result = await flowExecutorService.runEnrollment({
      enrollment,
      flow,
      interaction: { content: 'No' },
      organizationId: 'org_1',
      resume: { reason: 'reply' }
    });

    expect(result.currentNodeId).toBe('');
    expect(result.status).toBe('completed');
    // The regression: this used to always be the "yes" node regardless of what was typed.
    expect(executeNodeHandler).toHaveBeenCalledTimes(1);
    expect(executeNodeHandler.mock.calls[0][0].node.id).toBe('noNode');
  });

  it('routes an explicit "Yes" reply down the "yes"-labelled edge', async () => {
    const enrollment = makeEnrollment('wait');
    const result = await flowExecutorService.runEnrollment({
      enrollment,
      flow,
      interaction: { content: 'Yes' },
      organizationId: 'org_1',
      resume: { reason: 'reply' }
    });

    expect(result.status).toBe('completed');
    expect(executeNodeHandler.mock.calls[0][0].node.id).toBe('yesNode');
  });

  it('matches a button-tap title that is not an exact label (e.g. "Yes, ship here")', async () => {
    const enrollment = makeEnrollment('wait');
    await flowExecutorService.runEnrollment({
      enrollment,
      flow,
      interaction: { content: 'Yes, ship here' },
      organizationId: 'org_1',
      resume: { reason: 'reply' }
    });

    expect(executeNodeHandler.mock.calls[0][0].node.id).toBe('yesNode');
  });

  it('falls back to the generic "yes"/reply edge for an ambiguous reply that matches neither label', async () => {
    const enrollment = makeEnrollment('wait');
    await flowExecutorService.runEnrollment({
      enrollment,
      flow,
      interaction: { content: 'can you call me instead?' },
      organizationId: 'org_1',
      resume: { reason: 'reply' }
    });

    expect(executeNodeHandler.mock.calls[0][0].node.id).toBe('yesNode');
  });

  it('still uses the structural "no_reply"/timeout edge on an actual timeout, ignoring content matching', async () => {
    const timeoutFlow = {
      _id: 'flow_2',
      nodes: [
        { id: 'wait', type: 'wait.user_reply', config: { timeoutSec: 5 } },
        { id: 'replyNode', type: 'action.send_text', config: {} },
        { id: 'timeoutNode', type: 'action.send_text', config: {} }
      ],
      edges: [
        { id: 'e1', source: 'wait', target: 'replyNode', label: 'reply' },
        { id: 'e2', source: 'wait', target: 'timeoutNode', label: 'no_reply' }
      ]
    };
    const enrollment = makeEnrollment('wait');
    await flowExecutorService.runEnrollment({
      enrollment,
      flow: timeoutFlow,
      // Timeout resume passes the ORIGINAL trigger interaction, not a new reply —
      // its content must never influence the timeout branch choice.
      interaction: { content: 'yes' },
      organizationId: 'org_1',
      resume: { reason: 'timeout' }
    });

    expect(executeNodeHandler.mock.calls[0][0].node.id).toBe('timeoutNode');
  });

  it('still resumes the plain structural reply/no_reply scaffold correctly (no regression)', async () => {
    const scaffoldFlow = {
      _id: 'flow_3',
      nodes: [
        { id: 'wait', type: 'wait.user_reply', config: { timeoutSec: 3600 } },
        { id: 'replyNode', type: 'action.send_text', config: {} },
        { id: 'timeoutNode', type: 'action.send_text', config: {} }
      ],
      edges: [
        { id: 'e1', source: 'wait', target: 'replyNode', label: 'reply' },
        { id: 'e2', source: 'wait', target: 'timeoutNode', label: 'no_reply' }
      ]
    };
    const enrollment = makeEnrollment('wait');
    await flowExecutorService.runEnrollment({
      enrollment,
      flow: scaffoldFlow,
      interaction: { content: 'sounds good' },
      organizationId: 'org_1',
      resume: { reason: 'reply' }
    });

    expect(executeNodeHandler.mock.calls[0][0].node.id).toBe('replyNode');
  });
});
