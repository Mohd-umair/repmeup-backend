'use strict';

/**
 * Regression guard for the flow-vs-AI decision gate.
 *
 * This file (replyEngineService.js) was explicitly NOT modified by the duplicate-message
 * fix (see flowTriggerRouter/whatsappWebhookService/flowExecutorService changes) — these
 * tests exist to prove that guarantee stays true and `decide()` keeps behaving exactly as
 * before: AI fallback only fires in hybrid mode when no flow already handled the message.
 */

const { decide, getChannelMode } = require('../../../src/services/replyEngineService');

describe('replyEngineService.decide — AI fallback gating (no regression)', () => {
  it('hybrid mode: AI fallback runs when no flow handled the message', () => {
    const org = { automationModeByChannel: { whatsapp: 'hybrid' } };
    const result = decide({ organization: org, platform: 'whatsapp', flowHandled: false });
    expect(result).toEqual({ mode: 'hybrid', runFlows: true, runAiFallback: true });
  });

  it('hybrid mode: AI fallback is suppressed once a flow has taken ownership', () => {
    const org = { automationModeByChannel: { whatsapp: 'hybrid' } };
    const result = decide({ organization: org, platform: 'whatsapp', flowHandled: true });
    expect(result).toEqual({ mode: 'hybrid', runFlows: true, runAiFallback: false });
  });

  it('workflow_only mode: flows run, AI fallback never runs regardless of flowHandled', () => {
    const org = { automationModeByChannel: { whatsapp: 'workflow_only' } };
    expect(decide({ organization: org, platform: 'whatsapp', flowHandled: false }))
      .toEqual({ mode: 'workflow_only', runFlows: true, runAiFallback: false });
    expect(decide({ organization: org, platform: 'whatsapp', flowHandled: true }))
      .toEqual({ mode: 'workflow_only', runFlows: true, runAiFallback: false });
  });

  it('ai_only mode: flows never run, AI always replies', () => {
    const org = { automationModeByChannel: { whatsapp: 'ai_only' } };
    expect(decide({ organization: org, platform: 'whatsapp', flowHandled: false }))
      .toEqual({ mode: 'ai_only', runFlows: false, runAiFallback: true });
  });

  it('falls back to the deprecated org-wide automationFlowMode when no per-channel mode is set', () => {
    const org = { automationFlowMode: 'flows_only' };
    expect(getChannelMode(org, 'whatsapp')).toBe('workflow_only');
  });

  it('defaults to hybrid when organization is missing entirely', () => {
    expect(getChannelMode(null, 'whatsapp')).toBe('hybrid');
  });
});
