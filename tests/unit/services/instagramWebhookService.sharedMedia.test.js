'use strict';

const {
  buildInstagramDmAttachmentFields,
  buildInstagramDmPlaceholderText
} = require('../../../src/services/webhook/instagramWebhookService');

describe('instagramWebhookService shared IG media in DM', () => {
  it('extracts ig_reel media id from reel payload fields', () => {
    const fields = buildInstagramDmAttachmentFields({
      attachments: [{
        type: 'ig_reel',
        payload: {
          reel_video_id: '18123456789012345',
          title: 'Check this reel'
        }
      }]
    });
    expect(fields.attachmentType).toBe('ig_reel');
    expect(fields.igPostMediaId).toBe('18123456789012345');
    expect(fields.shareTitle).toBe('Check this reel');
  });

  it('labels reel placeholder before generic post fallback', () => {
    expect(buildInstagramDmPlaceholderText('ig_reel', '18123456789012345'))
      .toBe('[Shared Instagram reel]');
  });

  it('uses share title when present on reel attachment', () => {
    const fields = buildInstagramDmAttachmentFields({
      attachments: [{
        type: 'reel',
        payload: { reel_media_id: '999', title: 'Summer drop' }
      }]
    });
    expect(fields.attachmentType).toBe('ig_reel');
    expect(fields.shareTitle).toBe('Summer drop');
  });
});
