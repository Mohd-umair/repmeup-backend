'use strict';

jest.mock('../../../../src/models/Interaction');
jest.mock('../../../../src/models/SalesConversationState');
jest.mock('../../../../src/utils/chatRefHelper', () => ({
  generateChatRef: jest.fn().mockResolvedValue({ chatNumber: 101, chatRef: '#REP-101' })
}));

const Interaction = require('../../../../src/models/Interaction');
const SalesConversationState = require('../../../../src/models/SalesConversationState');
const linkSvc = require('../../../../src/services/inbox/commentDmThreadLinkService');

describe('commentDmThreadLinkService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('buildDmThreadPlatformId', () => {
    it('matches instagram webhook DM thread format', () => {
      expect(linkSvc.buildDmThreadPlatformId('178414000', '123456789')).toBe(
        'dm_178414000_123456789'
      );
    });
  });

  describe('resolveIgAccountId', () => {
    it('prefers platformUserId then metadata fallbacks', () => {
      expect(linkSvc.resolveIgAccountId({ platformUserId: 'a' })).toBe('a');
      expect(linkSvc.resolveIgAccountId({ metadata: { instagramAccountId: 'b' } })).toBe('b');
      expect(linkSvc.resolveIgAccountId(null)).toBeNull();
    });
  });

  describe('mergeIncomingMessagePages', () => {
    it('merges comment + DM messages, dedupes by mid, tags DM-origin rows', () => {
      const commentPage = {
        incomingMessages: [{ mid: 'm1', text: 'Nice post!', timestamp: 1000 }],
        totalMessages: 1,
        hasOlderMessages: false
      };
      const dmPage = {
        incomingMessages: [
          { mid: 'm1', text: 'duplicate', timestamp: 1000 },
          { mid: 'm2', text: 'details', timestamp: 2000 }
        ],
        totalMessages: 2,
        hasOlderMessages: true
      };

      const merged = linkSvc.mergeIncomingMessagePages(commentPage, dmPage);

      expect(merged.incomingMessages).toHaveLength(2);
      expect(merged.incomingMessages[0]).toMatchObject({ mid: 'm1', text: 'Nice post!' });
      expect(merged.incomingMessages[1]).toMatchObject({
        mid: 'm2',
        text: 'details',
        mergedFromDm: true
      });
      expect(merged.hasOlderMessages).toBe(true);
      expect(merged.totalMessages).toBe(3);
      expect(merged.returnedMessages).toBe(2);
    });

    it('sorts merged messages by timestamp ascending', () => {
      const merged = linkSvc.mergeIncomingMessagePages(
        { incomingMessages: [{ mid: 'b', timestamp: 2000 }], totalMessages: 1 },
        { incomingMessages: [{ mid: 'a', timestamp: 1000 }], totalMessages: 1 }
      );
      expect(merged.incomingMessages.map((m) => m.mid)).toEqual(['a', 'b']);
    });
  });

  describe('shadowDmExclusionCondition', () => {
    it('hides DM rows anchored to a comment CTD flow', () => {
      expect(linkSvc.shadowDmExclusionCondition()).toEqual({
        $or: [
          { type: { $ne: 'dm' } },
          { 'metadata.sourceCommentInteractionId': { $exists: false } },
          { 'metadata.sourceCommentInteractionId': null }
        ]
      });
    });
  });

  describe('ensureCommentDmLink', () => {
    const commentInteraction = {
      _id: 'comment_1',
      content: 'How much?',
      author: { username: 'jane', name: 'Jane' },
      platformCreatedAt: new Date('2026-01-01')
    };
    const platformConnection = {
      _id: 'conn_1',
      platformUserId: 'ig_acc_1'
    };

    it('returns null ids when required args missing', async () => {
      const result = await linkSvc.ensureCommentDmLink({});
      expect(result).toEqual({ dmInteractionId: null, dmPlatformId: null });
      expect(Interaction.findOne).not.toHaveBeenCalled();
    });

    it('upserts DM thread and links metadata on comment + DM', async () => {
      Interaction.findOne.mockReturnValue({
        select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(null) })
      });
      Interaction.findOneAndUpdate.mockResolvedValue({ _id: 'dm_1' });
      Interaction.updateOne.mockResolvedValue({ modifiedCount: 1 });

      const result = await linkSvc.ensureCommentDmLink({
        commentInteraction,
        organizationId: 'org_1',
        instagramUserId: 'user_99',
        platformConnection
      });

      expect(result).toEqual({
        dmInteractionId: 'dm_1',
        dmPlatformId: 'dm_ig_acc_1_user_99'
      });

      expect(Interaction.findOneAndUpdate).toHaveBeenCalledWith(
        { organization: 'org_1', platformId: 'dm_ig_acc_1_user_99' },
        expect.objectContaining({
          $set: expect.objectContaining({
            type: 'dm',
            'metadata.sourceCommentInteractionId': 'comment_1'
          })
        }),
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );

      expect(Interaction.updateOne).toHaveBeenCalledWith(
        { _id: 'comment_1', organization: 'org_1' },
        {
          $set: {
            'metadata.linkedDmInteractionId': 'dm_1',
            'metadata.linkedDmPlatformId': 'dm_ig_acc_1_user_99',
            'metadata.commentToDmActive': true
          }
        }
      );
    });

    it('updates SalesConversationState.dmInteractionId when postId provided', async () => {
      Interaction.findOne.mockReturnValue({
        select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue({ _id: 'existing_dm' }) })
      });
      Interaction.findOneAndUpdate.mockResolvedValue({ _id: 'dm_1' });
      Interaction.updateOne.mockResolvedValue({});
      SalesConversationState.updateMany.mockResolvedValue({ modifiedCount: 1 });

      await linkSvc.ensureCommentDmLink({
        commentInteraction,
        organizationId: 'org_1',
        instagramUserId: 'user_99',
        platformConnection,
        postId: 'post_42'
      });

      expect(SalesConversationState.updateMany).toHaveBeenCalledWith(
        {
          organization: 'org_1',
          instagramUserId: 'user_99',
          postId: 'post_42'
        },
        { $set: { dmInteractionId: 'dm_1' } }
      );
    });
  });
});
