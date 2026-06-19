'use strict';

const {
  isFirstContactMessage,
  qualifiesTrigger
} = require('../../../../src/services/flow/flowTriggerRouter');

describe('flowTriggerRouter first_message / new_lead', () => {
  const orgId = '507f1f77bcf86cd799439011';
  const interactionId = '507f1f77bcf86cd799439012';

  it('treats the first inbound message on a thread as first contact', async () => {
    const interaction = {
      _id: interactionId,
      author: { platformId: '919876543210' },
      metadata: { incomingMessages: [{ mid: 'wamid.1', text: 'hello' }] }
    };
    await expect(isFirstContactMessage({
      organizationId: orgId,
      platform: 'whatsapp',
      interaction
    })).resolves.toBe(true);
  });

  it('blocks first_message when the thread already has prior inbound messages', async () => {
    const interaction = {
      _id: interactionId,
      author: { platformId: '919876543210' },
      metadata: {
        incomingMessages: [
          { mid: 'wamid.1', text: 'hello' },
          { mid: 'wamid.2', text: 'again' }
        ]
      }
    };
    await expect(isFirstContactMessage({
      organizationId: orgId,
      platform: 'whatsapp',
      interaction
    })).resolves.toBe(false);
  });

  it('denies when platformUserId is missing', async () => {
    await expect(isFirstContactMessage({
      organizationId: orgId,
      platform: 'whatsapp',
      interaction: { metadata: { incomingMessages: [{ mid: '1' }] } }
    })).resolves.toBe(false);
  });

  it('qualifiesTrigger delegates first_message to isFirstContactMessage', async () => {
    const node = { type: 'trigger.first_message', config: {} };
    const interaction = {
      author: { platformId: '919876543210' },
      metadata: { incomingMessages: [{ mid: '1' }, { mid: '2' }] }
    };
    await expect(qualifiesTrigger(node, {
      organizationId: orgId,
      platform: 'whatsapp',
      interaction
    })).resolves.toBe(false);
  });

  it('passes through non first_message triggers', async () => {
    const node = { type: 'trigger.keyword', config: { keywords: ['hi'] } };
    await expect(qualifiesTrigger(node, {
      organizationId: orgId,
      platform: 'whatsapp',
      interaction: {}
    })).resolves.toBe(true);
  });
});
