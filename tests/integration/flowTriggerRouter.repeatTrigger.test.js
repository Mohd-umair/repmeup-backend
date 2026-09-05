'use strict';

/**
 * Real-DB (mongodb-memory-server) test answering a specific product question:
 *
 *   "Agar user ne ek flow start kiya, use complete nahi kiya, phir wahi trigger
 *    keyword dobara bhej diya — to kya flow phir se (naye sirey se) start hoga?
 *    Kya main ek flow ko baar-baar trigger karwa sakta hoon?"
 *
 * This exercises flowTriggerRouter.route() twice/thrice against a real Mongo instance
 * (no mocks on the models/executor) so the answer is empirically observed, not just
 * read off the code.
 *
 * Answer this test proves:
 *   1. While the flow is still IN PROGRESS for that contact (parked at a
 *      wait.user_reply node, not yet timed out) — sending the trigger keyword again
 *      does NOT start a second, parallel run. flowTriggerRouter's reply-resume pass
 *      intercepts it first and treats it as the awaited reply, advancing the SAME
 *      enrollment. No duplicate enrollment is created — this is the anti-duplicate
 *      guard already hardened earlier in this codebase.
 *   2. Once that run reaches a terminal state (completed/failed/dropped), the SAME
 *      keyword CAN start a fresh run — flows are not "one-shot forever", only
 *      "one-at-a-time per contact". A frequencyCap (flow.settings) can further limit
 *      how many times this is allowed inside a rolling window, but there is no cap
 *      by default (frequencyCap: 0 = unlimited).
 */

const mongoose = require('mongoose');
let MongoMemoryServer;
try {
  // eslint-disable-next-line global-require
  ({ MongoMemoryServer } = require('mongodb-memory-server'));
} catch {
  MongoMemoryServer = null;
}

const AutomationFlow = require('../../src/models/AutomationFlow');
const FlowEnrollment = require('../../src/models/FlowEnrollment');
const Organization = require('../../src/models/Organization');
const flowTriggerRouter = require('../../src/services/flow/flowTriggerRouter');

const maybeDescribe = MongoMemoryServer ? describe : describe.skip;

maybeDescribe('flowTriggerRouter — repeat-trigger behaviour (real DB)', () => {
  let mongod;
  // This spins up a real (in-memory) mongod binary, which in some sandboxed/offline
  // environments can't start (no network to fetch/verify the binary, or the sandbox
  // blocks the temp socket it needs). Skip gracefully rather than failing the whole
  // suite — this test is a deliberate empirical check, not a required regression gate.
  let dbAvailable = false;

  beforeAll(async () => {
    try {
      mongod = await MongoMemoryServer.create();
      await mongoose.connect(mongod.getUri());
      dbAvailable = true;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[flowTriggerRouter.repeatTrigger.test] skipping — in-memory Mongo unavailable:', err.message);
    }
  }, 60000);

  afterAll(async () => {
    if (!dbAvailable) return;
    await mongoose.disconnect();
    if (mongod) await mongod.stop();
  });

  afterEach(async () => {
    if (!dbAvailable) return;
    await AutomationFlow.deleteMany({});
    await FlowEnrollment.deleteMany({});
    await Organization.deleteMany({});
  });

  const PLATFORM_USER_ID = '919999999999';

  async function makeOrgAndFlow() {
    const org = await Organization.create({ name: 'Test Org' });
    const flow = await AutomationFlow.create({
      organization: org._id,
      name: 'Test keyword flow',
      status: 'active',
      isBlueprint: false,
      channels: ['whatsapp'],
      nodes: [
        { id: 'trig', type: 'trigger.keyword', config: { keywords: ['hi'] } },
        { id: 'wait', type: 'wait.user_reply', config: { timeoutSec: 3600 } },
        { id: 'end', type: 'control.end', config: {} }
      ],
      edges: [
        { id: 'e1', source: 'trig', target: 'wait' },
        { id: 'e2', source: 'wait', target: 'end' } // single, unlabeled reply edge
      ]
    });
    return { org, flow };
  }

  function makeInboundMessage(text, mid) {
    return {
      interaction: {
        _id: new mongoose.Types.ObjectId(),
        author: { platformId: PLATFORM_USER_ID },
        content: text,
        metadata: { lastMid: mid }
      },
      payload: { text, content: text, mid }
    };
  }

  it('does NOT start a second run while the first is still parked waiting for a reply', async () => {
    if (!dbAvailable) return;
    const { org, flow } = await makeOrgAndFlow();

    // 1) First "hi" — starts the flow, it parks at wait.user_reply (status: 'waiting').
    const msg1 = makeInboundMessage('hi', 'wamid.1');
    const r1 = await flowTriggerRouter.route({
      organizationId: org._id,
      platform: 'whatsapp',
      eventType: 'whatsapp.message',
      interaction: msg1.interaction,
      payload: msg1.payload
    });
    expect(r1.handled).toBe(true);

    let enrollments = await FlowEnrollment.find({ flow: flow._id, platformUserId: PLATFORM_USER_ID });
    expect(enrollments).toHaveLength(1);
    expect(enrollments[0].status).toBe('waiting');
    const firstEnrollmentId = String(enrollments[0]._id);

    // 2) User does NOT answer the wait — instead sends the SAME trigger keyword again.
    const msg2 = makeInboundMessage('hi', 'wamid.2');
    const r2 = await flowTriggerRouter.route({
      organizationId: org._id,
      platform: 'whatsapp',
      eventType: 'whatsapp.message',
      interaction: msg2.interaction,
      payload: msg2.payload
    });
    expect(r2.handled).toBe(true);

    // Still only ONE enrollment for this contact+flow — the second "hi" was consumed as
    // the reply to the still-open wait node (which happened to complete it), NOT a fresh
    // trigger. This is the guard: a flow cannot be double-triggered while already in progress.
    enrollments = await FlowEnrollment.find({ flow: flow._id, platformUserId: PLATFORM_USER_ID });
    expect(enrollments).toHaveLength(1);
    expect(String(enrollments[0]._id)).toBe(firstEnrollmentId);
    expect(enrollments[0].status).toBe('completed'); // reply resumed it past the wait node
  });

  it('DOES allow a fresh run once the previous one reached a terminal state (completed)', async () => {
    if (!dbAvailable) return;
    const { org, flow } = await makeOrgAndFlow();

    const msg1 = makeInboundMessage('hi', 'wamid.1');
    await flowTriggerRouter.route({
      organizationId: org._id, platform: 'whatsapp', eventType: 'whatsapp.message',
      interaction: msg1.interaction, payload: msg1.payload
    });
    const msg2 = makeInboundMessage('hi', 'wamid.2');
    await flowTriggerRouter.route({
      organizationId: org._id, platform: 'whatsapp', eventType: 'whatsapp.message',
      interaction: msg2.interaction, payload: msg2.payload
    });

    let enrollments = await FlowEnrollment.find({ flow: flow._id, platformUserId: PLATFORM_USER_ID });
    expect(enrollments).toHaveLength(1);
    expect(enrollments[0].status).toBe('completed'); // terminal — the previous run is fully done

    // 3) Contact sends "hi" a THIRD time, well after the flow completed.
    const msg3 = makeInboundMessage('hi', 'wamid.3');
    const r3 = await flowTriggerRouter.route({
      organizationId: org._id, platform: 'whatsapp', eventType: 'whatsapp.message',
      interaction: msg3.interaction, payload: msg3.payload
    });
    expect(r3.handled).toBe(true);

    // A brand-new, second enrollment is created — the flow CAN be re-triggered once the
    // earlier run is no longer active/waiting. Repeated triggers are allowed; simultaneous
    // duplicate runs are not.
    enrollments = await FlowEnrollment.find({ flow: flow._id, platformUserId: PLATFORM_USER_ID }).sort({ createdAt: 1 });
    expect(enrollments).toHaveLength(2);
    expect(enrollments[1].status).toBe('waiting');
  });

  it('a frequencyCap on the flow limits how many times it can be re-triggered in a window', async () => {
    if (!dbAvailable) return;
    const org = await Organization.create({ name: 'Test Org 2' });
    const flow = await AutomationFlow.create({
      organization: org._id,
      name: 'Capped flow',
      status: 'active',
      isBlueprint: false,
      channels: ['whatsapp'],
      settings: { frequencyCap: 1, frequencyCapWindowDays: 1 },
      nodes: [
        { id: 'trig', type: 'trigger.keyword', config: { keywords: ['hi'] } },
        { id: 'end', type: 'control.end', config: {} }
      ],
      edges: [{ id: 'e1', source: 'trig', target: 'end' }]
    });

    const msg1 = makeInboundMessage('hi', 'wamid.1');
    const r1 = await flowTriggerRouter.route({
      organizationId: org._id, platform: 'whatsapp', eventType: 'whatsapp.message',
      interaction: msg1.interaction, payload: msg1.payload
    });
    expect(r1.handled).toBe(true);

    // First run completes immediately (trigger -> end). A second "hi" right after should
    // be blocked by the frequency cap (max 1 enrollment per rolling day) even though the
    // first run is no longer active/waiting.
    const msg2 = makeInboundMessage('hi', 'wamid.2');
    const r2 = await flowTriggerRouter.route({
      organizationId: org._id, platform: 'whatsapp', eventType: 'whatsapp.message',
      interaction: msg2.interaction, payload: msg2.payload
    });
    expect(r2.handled).toBe(false);

    const enrollments = await FlowEnrollment.find({ flow: flow._id, platformUserId: PLATFORM_USER_ID });
    expect(enrollments).toHaveLength(1);
  });
});
