'use strict';

/**
 * flowExecutorService — control.jump cycle guard.
 *
 * Bug this protects against: a flow with `send -> jump -> (back to send)` could resend
 * the SAME message several times to a customer within one runEnrollment() pass (bounded
 * only by the generic maxSteps=25 cap, so it could fire ~12 times before that even kicks
 * in). The fix tracks nodes already executed in this pass and stops BEFORE re-executing
 * one, instead of relying solely on the step cap.
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

beforeEach(() => jest.clearAllMocks());

describe('flowExecutorService — cycle guard', () => {
  it('runs a send node exactly once even when a control.jump loops back to it', async () => {
    // Graph: trigger -> send -> jump -> (back to send)
    const flow = {
      _id: 'flow_1',
      nodes: [
        { id: 'trig', type: 'trigger.keyword', config: {} },
        { id: 'send', type: 'action.send_text', config: { text: 'Hi!' } },
        { id: 'jump', type: 'control.jump', config: { targetNodeId: 'send' } }
      ],
      edges: [
        { id: 'e1', source: 'trig', target: 'send' },
        { id: 'e2', source: 'send', target: 'jump' }
      ]
    };

    // The real send_text handler would call the WhatsApp API here — we only care that it's
    // invoked at most once per node id (that's the whole point of the guard).
    executeNodeHandler.mockImplementation(async ({ node }) => {
      if (node.type === 'action.send_text') return { status: 'active', nextNodeId: 'jump' };
      if (node.type === 'control.jump') return { status: 'active', nextNodeId: node.config.targetNodeId };
      return { status: 'completed', nextNodeId: null };
    });

    const enrollment = makeEnrollment('trig');
    const result = await flowExecutorService.runEnrollment({
      enrollment,
      flow,
      interaction: null,
      organizationId: 'org_1'
    });

    const sendCalls = executeNodeHandler.mock.calls.filter(([arg]) => arg.node.type === 'action.send_text');
    expect(sendCalls).toHaveLength(1); // <-- the actual regression this guard prevents

    expect(result.status).toBe('failed');
    expect(result.lastError).toMatch(/loop detected/i);
    expect(result.history.some((h) => h.event === 'loop_detected_stopped')).toBe(true);
  });

  it('does not false-positive on a normal linear flow with no repeated nodes', async () => {
    const flow = {
      _id: 'flow_2',
      nodes: [
        { id: 'trig', type: 'trigger.keyword', config: {} },
        { id: 'send1', type: 'action.send_text', config: {} },
        { id: 'send2', type: 'action.send_text', config: {} }
      ],
      edges: [
        { id: 'e1', source: 'trig', target: 'send1' },
        { id: 'e2', source: 'send1', target: 'send2' }
      ]
    };

    executeNodeHandler.mockImplementation(async ({ node }) => {
      if (node.id === 'send1') return { status: 'active', nextNodeId: 'send2' };
      return { status: 'completed', nextNodeId: null };
    });

    const enrollment = makeEnrollment('trig');
    const result = await flowExecutorService.runEnrollment({
      enrollment,
      flow,
      interaction: null,
      organizationId: 'org_1'
    });

    expect(result.status).toBe('completed');
    expect(executeNodeHandler).toHaveBeenCalledTimes(2); // send1 then send2, each once
  });

  it('allows a wait.user_reply node to legitimately be revisited across SEPARATE runEnrollment calls (resume path)', async () => {
    // First call: parks at the wait node (status -> 'waiting'), does NOT trip the guard.
    const flow = {
      _id: 'flow_3',
      nodes: [
        { id: 'trig', type: 'trigger.keyword', config: {} },
        { id: 'wait', type: 'wait.user_reply', config: { timeoutSec: 3600 } },
        { id: 'done', type: 'control.end', config: {} }
      ],
      edges: [
        { id: 'e1', source: 'trig', target: 'wait' },
        { id: 'e2', source: 'wait', target: 'done', label: 'reply' }
      ]
    };

    executeNodeHandler.mockImplementation(async ({ node }) => {
      if (node.type === 'wait.user_reply') return { status: 'waiting', delaySec: 3600 };
      return { status: 'completed', nextNodeId: null };
    });

    const enrollment = makeEnrollment('trig');
    const firstRun = await flowExecutorService.runEnrollment({ enrollment, flow, interaction: null, organizationId: 'org_1' });
    expect(firstRun.status).toBe('waiting');

    // Second call (a fresh call, as tickEnrollment/resumeOnReply would make it): resumes past
    // the SAME wait node id. This must NOT be treated as a loop — it's a brand-new pass with
    // its own fresh visited-node set.
    const resumedEnrollment = makeEnrollment('wait');
    const secondRun = await flowExecutorService.runEnrollment({
      enrollment: resumedEnrollment,
      flow,
      interaction: null,
      organizationId: 'org_1',
      resume: { reason: 'reply' }
    });

    expect(secondRun.status).toBe('completed');
    expect(secondRun.lastError).not.toMatch(/loop detected/i);
  });
});
