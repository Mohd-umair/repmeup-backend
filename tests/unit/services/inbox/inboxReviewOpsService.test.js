'use strict';

const reviewOps = require('../../../../src/services/inbox/inboxReviewOpsService');

const ORG = 'org_test_1';

describe('inboxReviewOpsService — pure helpers', () => {
  describe('buildReviewFilter', () => {
    test('inbound reviews only', () => {
      expect(reviewOps.buildReviewFilter(ORG, {})).toEqual({
        organization: ORG,
        type: 'review'
      });
    });

    test('awaiting_reply tab excludes replied', () => {
      const filter = reviewOps.buildReviewFilter(ORG, { tab: 'awaiting_reply' });
      expect(filter.status).toEqual({ $ne: 'replied' });
      expect(filter['metadata.reviewReplyPublished']).toEqual({ $ne: true });
    });

    test('platform filter', () => {
      expect(reviewOps.buildReviewFilter(ORG, { platform: 'google' }).platform).toBe('google');
    });
  });

  describe('replyStatusFor', () => {
    test('published when metadata flag set', () => {
      const result = reviewOps.replyStatusFor({ metadata: { reviewReplyPublished: true } });
      expect(result.status).toBe('published');
      expect(result.label).toBe('PUBLISHED');
    });

    test('awaiting when AI draft exists', () => {
      const result = reviewOps.replyStatusFor({ aiSuggestion: { content: 'Thank you!' } });
      expect(result.status).toBe('awaiting');
      expect(result.label).toBe('AWAITING APPROVAL');
    });

    test('none when no reply', () => {
      const result = reviewOps.replyStatusFor({});
      expect(result.status).toBe('none');
    });
  });

  describe('mapReviewRow', () => {
    test('maps review row with rating and request sent label', () => {
      const row = reviewOps.mapReviewRow(
        {
          _id: { toString: () => 'rev1' },
          platform: 'google',
          content: 'Great service, highly recommend!',
          author: { name: 'Alice' },
          metadata: { reviewDisplayRef: 'REV-0088', starRating: 'FIVE' },
          platformCreatedAt: new Date('2026-05-19T12:00:00Z')
        },
        { sentAt: new Date('2026-05-18T08:00:00Z'), channel: 'whatsapp' }
      );

      expect(row.displayRef).toBe('REV-0088');
      expect(row.rating).toBe(5);
      expect(row.platformLabel).toBe('Google');
      expect(row.requestSentLabel).toBe('Yes · WhatsApp');
      expect(row.collectionStatus).toBe('collected');
      expect(row.replyStatus).toBe('none');
      expect(row.chatDeepLink).toBe('/app/inbox?selected=rev1');
    });

    test('reply eligibility: published status when reply exists', () => {
      const row = reviewOps.mapReviewRow(
        {
          _id: { toString: () => 'rev2' },
          platform: 'google',
          content: 'OK',
          author: {},
          metadata: { reviewReplyPublished: true },
          platformCreatedAt: new Date()
        },
        null
      );
      expect(row.replyStatus).toBe('published');
    });
  });
});
