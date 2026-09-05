'use strict';
/**
 * Tests for session-boundary filtering added to buildRecentConversationTranscript.
 *
 * The key regression scenario: a customer who sent "hello" 9 days after a previous
 * session must NOT receive context from the stale session (e.g. address requests).
 */

const { buildRecentConversationTranscript } = require('../../../src/utils/inboxConversationTranscript');

// Helper: build a Date that is `daysAgo` days before now
function daysAgo(d) {
  return new Date(Date.now() - d * 24 * 60 * 60 * 1000);
}

describe('buildRecentConversationTranscript — session filtering', () => {
  const staleOrder = 'Please share your delivery address to complete your order.';
  const freshHello = 'hello';
  const freshReply = 'Hi! How can we help you today?';

  const interaction = {
    content: freshHello,
    metadata: {
      incomingMessages: [
        // 9-day-old message from previous session
        { mid: 'm1', text: 'I want to buy the kurta', timestamp: daysAgo(9) },
        // Business reply 9 days ago (address request in old session)
        // (replies[] handles business messages)
        // Today's new message
        { mid: 'm2', text: freshHello, timestamp: new Date() }
      ]
    },
    replies: [
      // Old business reply from 9 days ago
      {
        content: staleOrder,
        sentAt: daysAgo(9),
        status: 'sent'
      },
      // Fresh business reply from today (if any)
      {
        content: freshReply,
        sentAt: new Date(),
        status: 'sent'
      }
    ]
  };

  it('without sessionStartedAt — includes stale messages (current behavior, regression check)', () => {
    const transcript = buildRecentConversationTranscript(interaction);
    // All messages included when no session boundary is set
    expect(transcript).toContain('kurta');
    expect(transcript).toContain(staleOrder);
  });

  it('with sessionStartedAt = 1 minute ago — excludes stale messages from 9 days ago', () => {
    const sessionStartedAt = new Date(Date.now() - 60 * 1000); // 1 min ago
    const transcript = buildRecentConversationTranscript(interaction, { sessionStartedAt });
    // Stale content should be excluded
    expect(transcript).not.toContain('kurta');
    expect(transcript).not.toContain(staleOrder);
    // Fresh content (within session) should be included
    expect(transcript).toContain(freshHello);
    expect(transcript).toContain(freshReply);
  });

  it('with sessionStartedAt = 10 days ago — includes all messages (entire history is within session)', () => {
    const sessionStartedAt = daysAgo(10);
    const transcript = buildRecentConversationTranscript(interaction, { sessionStartedAt });
    expect(transcript).toContain('kurta');
    expect(transcript).toContain(staleOrder);
  });

  it('returns empty string when session boundary excludes all messages', () => {
    const futureSession = new Date(Date.now() + 60 * 60 * 1000); // 1 hour in the future
    const transcript = buildRecentConversationTranscript(interaction, { sessionStartedAt: futureSession });
    expect(transcript).toBe('');
  });

  it('handles missing timestamps — messages without timestamps are not filtered out', () => {
    const noTimestampInteraction = {
      content: 'hello',
      metadata: {
        incomingMessages: [
          { mid: 'x', text: 'What is the price?' } // no timestamp
        ]
      },
      replies: []
    };
    const transcript = buildRecentConversationTranscript(noTimestampInteraction, {
      sessionStartedAt: new Date() // session started now
    });
    // Messages without timestamps should not be filtered out
    expect(transcript).toContain('What is the price?');
  });
});
