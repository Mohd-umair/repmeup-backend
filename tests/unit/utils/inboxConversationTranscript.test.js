'use strict';

const {
  buildRecentConversationTranscript,
  DEFAULT_MAX_MESSAGES
} = require('../../../src/utils/inboxConversationTranscript');

describe('buildRecentConversationTranscript', () => {
  it('returns empty string when no incomingMessages and no replies', () => {
    expect(buildRecentConversationTranscript({ content: 'hi' })).toBe('');
  });

  it('merges customer + business by timestamp and keeps last 5 lines', () => {
    // Use epoch ms >= 1e12 so normalizeMsgTimestamp does not scale (must match reply sentAt ms)
    const t0 = 1_700_000_000_000;
    const interaction = {
      content: 'latest',
      metadata: {
        incomingMessages: [
          { text: 'a', timestamp: t0 + 1000 },
          { text: 'c', timestamp: t0 + 3000 },
          { text: 'e', timestamp: t0 + 5000 },
          { text: 'g', timestamp: t0 + 7000 },
          { text: 'i', timestamp: t0 + 9000 },
          { text: 'k', timestamp: t0 + 11000 }
        ]
      },
      replies: [
        { content: 'b', sentAt: new Date(t0 + 2000) },
        { content: 'd', sentAt: new Date(t0 + 4000) },
        { content: 'f', sentAt: new Date(t0 + 6000) }
      ]
    };

    const t = buildRecentConversationTranscript(interaction, { maxMessages: DEFAULT_MAX_MESSAGES });
    const lines = t.split('\n');
    expect(lines).toHaveLength(5);
    expect(lines[0]).toBe('Customer: e');
    expect(lines[1]).toBe('Business: f');
    expect(lines[2]).toBe('Customer: g');
    expect(lines[4]).toBe('Customer: k');
  });

  it('uses attachment placeholders when text is empty', () => {
    const interaction = {
      metadata: {
        incomingMessages: [{ attachmentType: 'audio', timestamp: 1_700_000_000_000 }]
      },
      replies: []
    };
    expect(buildRecentConversationTranscript(interaction)).toBe('Customer: [Voice note]');
  });

  it('skips deleted replies', () => {
    const t0 = 1_700_000_000_000;
    const interaction = {
      metadata: { incomingMessages: [{ text: 'hi', timestamp: t0 + 1 }] },
      replies: [{ content: 'gone', status: 'deleted', sentAt: new Date(t0 + 2) }]
    };
    expect(buildRecentConversationTranscript(interaction)).toBe('Customer: hi');
  });

  it('replaces latest customer placeholder with interaction.content (voice / [audio])', () => {
    const t0 = 1_700_000_000_000;
    const interaction = {
      content: 'Please tell me your company hours.',
      metadata: {
        incomingMessages: [
          { text: 'Hello', timestamp: t0 + 1000 },
          { text: '[audio]', timestamp: t0 + 2000, attachmentType: 'audio' }
        ]
      },
      replies: []
    };
    const t = buildRecentConversationTranscript(interaction, { maxMessages: 5 });
    expect(t).toContain('Customer: Please tell me your company hours.');
    expect(t).not.toMatch(/\[audio\]/);
  });

  it('replaces [Voice note] row with transcribed interaction.content', () => {
    const interaction = {
      content: 'Actual transcript from Whisper.',
      metadata: {
        incomingMessages: [{ attachmentType: 'audio', timestamp: 1_700_000_000_000 }]
      },
      replies: []
    };
    expect(buildRecentConversationTranscript(interaction)).toBe('Customer: Actual transcript from Whisper.');
  });

  it('does not replace when latest customer line is real text', () => {
    const t0 = 1_700_000_000_000;
    const interaction = {
      content: 'Thanks!',
      metadata: {
        incomingMessages: [
          { text: 'Any update?', timestamp: t0 + 1000 },
          { text: 'Thanks!', timestamp: t0 + 2000 }
        ]
      },
      replies: []
    };
    expect(buildRecentConversationTranscript(interaction)).toBe('Customer: Any update?\nCustomer: Thanks!');
  });
});
