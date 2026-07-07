'use strict';

const {
  classifyMessage,
  isInternalAiPayload,
  isPleasantriesMessage,
  detectBotConversationLoop,
} = require('../../../src/utils/messageIntentClassifier');

// ═══════════════════════════════════════════════════════════════════════════
// classifyMessage (existing behaviour, regression guard)
// ═══════════════════════════════════════════════════════════════════════════
describe('classifyMessage()', () => {
  it('classifies short "ok" as closing', () => {
    expect(classifyMessage('ok')).toBe('closing');
  });

  it('classifies "thank you" as closing', () => {
    expect(classifyMessage('thank you')).toBe('closing');
  });

  it('classifies greetings as small_talk', () => {
    expect(classifyMessage('hi there')).toBe('small_talk');
    expect(classifyMessage('hello')).toBe('small_talk');
  });

  it('classifies product questions as business', () => {
    expect(classifyMessage('How much does the red dress cost?')).toBe('business');
  });

  it('classifies gibberish as gibberish', () => {
    expect(classifyMessage('!@#$%^&*()')).toBe('gibberish');
  });

  it('classifies single-token keyboard-mash as gibberish', () => {
    expect(classifyMessage('hhggfgh')).toBe('gibberish');
    expect(classifyMessage('asdfgh')).toBe('gibberish');
    expect(classifyMessage('zxcvbnm')).toBe('gibberish');
    expect(classifyMessage('sdfsdf')).toBe('gibberish');
  });

  it('does NOT misclassify real single words / short replies as gibberish', () => {
    expect(classifyMessage('tshirt')).toBe('business');
    expect(classifyMessage('kurti')).toBe('business');
    expect(classifyMessage('available')).toBe('business');
    expect(classifyMessage('delivery')).toBe('business');
    // greeting/closing precedence still wins
    expect(classifyMessage('hello')).toBe('small_talk');
  });

  it('does NOT misclassify non-latin scripts (Hindi) as gibberish', () => {
    expect(classifyMessage('कितने का है')).toBe('business');
  });

  it('returns business for null/undefined input', () => {
    expect(classifyMessage(null)).toBe('business');
    expect(classifyMessage(undefined)).toBe('business');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// isInternalAiPayload — Bug 1 defense-in-depth guard
// ═══════════════════════════════════════════════════════════════════════════
describe('isInternalAiPayload()', () => {
  it('detects exact payload that was leaked to customers', () => {
    const leaked = JSON.stringify({
      resolvable: false,
      reason: 'Customer is repeatedly contacting the wrong business (Lulu Hypermarket UAE vs RepMeUp)',
      confidence: 0.94,
      messageType: 'business',
      noReply: false
    });
    expect(isInternalAiPayload(leaked)).toBe(true);
  });

  it('detects a resolvable:true payload', () => {
    const json = JSON.stringify({
      resolvable: true,
      confidence: 0.9,
      messageType: 'small_talk',
      reply: 'hello',
      noReply: false
    });
    expect(isInternalAiPayload(json)).toBe(true);
  });

  it('does NOT flag a normal customer reply', () => {
    expect(isInternalAiPayload('Thank you for your response!')).toBe(false);
    expect(isInternalAiPayload('Can I return this product?')).toBe(false);
    expect(isInternalAiPayload('')).toBe(false);
    expect(isInternalAiPayload(null)).toBe(false);
  });

  it('does NOT flag a JSON string without the internal key combination', () => {
    expect(isInternalAiPayload(JSON.stringify({ name: 'Alice', age: 30 }))).toBe(false);
    expect(isInternalAiPayload(JSON.stringify({ message: 'hello', status: 'ok' }))).toBe(false);
  });

  it('detects partially broken JSON that still has internal key signatures', () => {
    const broken = '{"resolvable":false,"messageType":"business","confidence":0.9 BROKEN}';
    expect(isInternalAiPayload(broken)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// isPleasantriesMessage — Bot loop detection
// ═══════════════════════════════════════════════════════════════════════════
describe('isPleasantriesMessage()', () => {
  const BOT_MESSAGES = [
    "Thank you so much! It's always a pleasure to connect. Wishing you a wonderful day ahead! We're always here if you need anything.",
    "That's so kind of you—thank you! It's always a pleasure connecting with you as well. Wishing you a fantastic day ahead, and we're here anytime you need us!",
    "That truly means a lot—thank you! It's always a pleasure connecting with you as well. Wishing you a fantastic day ahead, and we're here anytime you need us!",
    "Thank you so much! It's always a pleasure to connect. Wishing you an amazing day ahead too, and remember we're always here whenever you need us!",
    "That's so thoughtful—thank you! Always a pleasure connecting with you. Hope your day is just as fantastic, and we're here anytime you need us too!",
    "That's so kind of you—thank you! Always a pleasure connecting with you as well. Wishing you an amazing day ahead, and we're here anytime you need us!",
    "Thank you so much! It's always a pleasure to connect. Wishing you a fantastic day ahead too, and remember we're always here whenever you need us!",
  ];

  BOT_MESSAGES.forEach((msg, i) => {
    it(`detects bot message #${i + 1}`, () => {
      expect(isPleasantriesMessage(msg)).toBe(true);
    });
  });

  it('does NOT flag a real business question', () => {
    expect(isPleasantriesMessage('I want to order the blue shirt. Do you have size L?')).toBe(false);
    expect(isPleasantriesMessage('What is your return policy?')).toBe(false);
    expect(isPleasantriesMessage('hello')).toBe(false);
  });

  it('does NOT flag a short neutral thank you without pleasantries markers', () => {
    expect(isPleasantriesMessage('Thank you!')).toBe(false);
    expect(isPleasantriesMessage('Thanks for the help')).toBe(false);
  });

  it('handles null/empty gracefully', () => {
    expect(isPleasantriesMessage(null)).toBe(false);
    expect(isPleasantriesMessage('')).toBe(false);
    expect(isPleasantriesMessage(undefined)).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// detectBotConversationLoop
// ═══════════════════════════════════════════════════════════════════════════
describe('detectBotConversationLoop()', () => {
  const makeInteraction = (overrides = {}) => ({
    metadata: { incomingMessages: [] },
    replies: [],
    ...overrides
  });

  const botMsg = (text) => ({ text, mid: Math.random().toString() });
  const autoReply = (content) => ({ content, wasAutoGenerated: true });

  it('returns false for null/empty interaction', () => {
    expect(detectBotConversationLoop(null)).toBe(false);
    expect(detectBotConversationLoop(makeInteraction())).toBe(false);
  });

  it('detects loop when last 3 inbound messages are all pleasantries', () => {
    const pleasantry = "Thank you so much! It's always a pleasure to connect. Wishing you a wonderful day!";
    const interaction = makeInteraction({
      metadata: {
        incomingMessages: [
          botMsg('What is your price?'),   // early real message, not counted
          botMsg(pleasantry),
          botMsg(pleasantry),
          botMsg(pleasantry),
        ]
      }
    });
    expect(detectBotConversationLoop(interaction)).toBe(true);
  });

  it('detects ping-pong pattern (2 auto-reply pleasantries + pleasantry inbound)', () => {
    const pleasantry = "Thank you so much! It's always a pleasure to connect. Wishing you a wonderful day!";
    const interaction = makeInteraction({
      metadata: {
        incomingMessages: [
          botMsg('What is your price?'),
          botMsg(pleasantry),
        ]
      },
      replies: [
        autoReply(pleasantry),
        autoReply(pleasantry),
      ]
    });
    expect(detectBotConversationLoop(interaction)).toBe(true);
  });

  it('does NOT flag 2 auto replies when latest inbound is a real question', () => {
    const pleasantry = "Thank you so much! It's always a pleasure to connect. Wishing you a wonderful day!";
    const interaction = makeInteraction({
      metadata: {
        incomingMessages: [botMsg('Can I get a refund?')]
      },
      replies: [
        autoReply(pleasantry),
        autoReply(pleasantry),
      ]
    });
    expect(detectBotConversationLoop(interaction)).toBe(false);
  });

  it('does NOT flag a thread with only 1 auto-reply pleasantry', () => {
    const pleasantry = "Thank you so much! It's always a pleasure to connect. Wishing you a wonderful day!";
    const interaction = makeInteraction({
      metadata: { incomingMessages: [botMsg(pleasantry)] },
      replies: [autoReply(pleasantry)]
    });
    expect(detectBotConversationLoop(interaction)).toBe(false);
  });
});
