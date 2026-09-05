'use strict';

const { extractStoryContext } = require('../../../src/services/webhook/instagramWebhookService');

describe('instagramWebhookService extractStoryContext', () => {
  it('detects story reply from reply_to.story.id', () => {
    const result = extractStoryContext({
      text: 'What is the price?',
      reply_to: {
        story: {
          id: '17912345678901234',
          url: 'https://cdn.example/story.jpg'
        }
      }
    });
    expect(result).toEqual({
      storyMediaId: '17912345678901234',
      triggerType: 'story_reply',
      replyText: 'What is the price?'
    });
  });

  it('detects story @mention from story_mention attachment', () => {
    const result = extractStoryContext({
      attachments: [{
        type: 'story_mention',
        payload: { story_media_id: '17999998887776666' }
      }]
    });
    expect(result).toEqual({
      storyMediaId: '17999998887776666',
      triggerType: 'story_mention',
      replyText: ''
    });
  });

  it('returns null context for regular DMs', () => {
    expect(extractStoryContext({ text: 'Hello' })).toEqual({
      storyMediaId: null,
      triggerType: null,
      replyText: 'Hello'
    });
    expect(extractStoryContext(null)).toEqual({
      storyMediaId: null,
      triggerType: null,
      replyText: ''
    });
  });

  it('prefers story reply over attachments', () => {
    const result = extractStoryContext({
      text: 'Hi',
      reply_to: { story: { id: '111' } },
      attachments: [{ type: 'story_mention', payload: { media_id: '222' } }]
    });
    expect(result.storyMediaId).toBe('111');
    expect(result.triggerType).toBe('story_reply');
  });
});
