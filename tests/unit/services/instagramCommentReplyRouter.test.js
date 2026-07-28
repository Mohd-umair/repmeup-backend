'use strict';

/**
 * Unit tests for instagramCommentReplyRouter.js
 *
 * Covers:
 *  - isCommentOnProductLinkedPost: fast-path (cached metadata), live DB fallback,
 *    no-postId default, non-Instagram / non-comment guard, org opt-out flag.
 *  - resolveInstagramPrivateReplyPageId: instagram_login vs Facebook-Login paths,
 *    all fallback resolution fields, null connection guard.
 */

jest.mock('../../../src/models/Product', () => ({
  exists: jest.fn()
}));
jest.mock('../../../src/services/commentToDmProductHelpers', () => ({
  buildPostLinkedProductQuery: jest.fn((orgId, postId) => ({
    organization: orgId,
    isActive: true,
    $or: [{ instagramPostIds: postId }, { 'instagramPostLinks.postId': postId }]
  }))
}));
jest.mock('../../../src/config/logger', () => ({
  createChild: () => ({
    debug: jest.fn(),
    warn: jest.fn(),
    info: jest.fn(),
    error: jest.fn()
  })
}));

const {
  isCommentOnProductLinkedPost,
  resolveInstagramPrivateReplyPageId
} = require('../../../src/services/instagramCommentReplyRouter');
const Product = require('../../../src/models/Product');

const ORG_ID = 'org_abc123';

function makeInteraction(overrides = {}) {
  return {
    _id: 'int_001',
    platform: 'instagram',
    type: 'comment',
    organization: ORG_ID,
    metadata: {},
    ...overrides
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

// ─────────────────────────────────────────────────────────────────────────────
// isCommentOnProductLinkedPost
// ─────────────────────────────────────────────────────────────────────────────

describe('isCommentOnProductLinkedPost', () => {
  describe('org opt-out flag', () => {
    it('returns false immediately when forcePrivateReply is false', async () => {
      const interaction = makeInteraction({ metadata: { linkedProductCount: 5 } });
      const result = await isCommentOnProductLinkedPost(interaction, ORG_ID, { forcePrivateReply: false });
      expect(result).toBe(false);
      expect(Product.exists).not.toHaveBeenCalled();
    });
  });

  describe('guard clauses', () => {
    it('returns false for null interaction', async () => {
      expect(await isCommentOnProductLinkedPost(null, ORG_ID)).toBe(false);
    });

    it('returns false for non-Instagram platform', async () => {
      const interaction = makeInteraction({ platform: 'facebook', metadata: { linkedProductCount: 3 } });
      expect(await isCommentOnProductLinkedPost(interaction, ORG_ID)).toBe(false);
    });

    it('returns false for DM type interactions', async () => {
      const interaction = makeInteraction({ type: 'dm', metadata: { linkedProductCount: 3 } });
      expect(await isCommentOnProductLinkedPost(interaction, ORG_ID)).toBe(false);
    });
  });

  describe('fast path — cached metadata.linkedProductCount', () => {
    it('returns true when linkedProductCount > 0', async () => {
      const interaction = makeInteraction({ metadata: { linkedProductCount: 2 } });
      const result = await isCommentOnProductLinkedPost(interaction, ORG_ID);
      expect(result).toBe(true);
      expect(Product.exists).not.toHaveBeenCalled();
    });

    it('returns false when linkedProductCount === 0', async () => {
      const interaction = makeInteraction({ metadata: { linkedProductCount: 0 } });
      const result = await isCommentOnProductLinkedPost(interaction, ORG_ID);
      expect(result).toBe(false);
      expect(Product.exists).not.toHaveBeenCalled();
    });

    it('does NOT fall back to live DB when count is 0 (trusts the snapshot)', async () => {
      const interaction = makeInteraction({ metadata: { linkedProductCount: 0, postId: 'post_123' } });
      await isCommentOnProductLinkedPost(interaction, ORG_ID);
      expect(Product.exists).not.toHaveBeenCalled();
    });
  });

  describe('live DB fallback — metadata.linkedProductCount is absent', () => {
    it('returns true when Product.exists resolves with a truthy value', async () => {
      Product.exists.mockResolvedValue({ _id: 'prod_1' });
      const interaction = makeInteraction({ metadata: { postId: 'post_99' } });
      const result = await isCommentOnProductLinkedPost(interaction, ORG_ID);
      expect(result).toBe(true);
      expect(Product.exists).toHaveBeenCalledTimes(1);
    });

    it('returns false when Product.exists resolves with null (no linked products)', async () => {
      Product.exists.mockResolvedValue(null);
      const interaction = makeInteraction({ metadata: { postId: 'post_99' } });
      const result = await isCommentOnProductLinkedPost(interaction, ORG_ID);
      expect(result).toBe(false);
    });

    it('returns false when no postId is present (safe default)', async () => {
      const interaction = makeInteraction({ metadata: {} });
      const result = await isCommentOnProductLinkedPost(interaction, ORG_ID);
      expect(result).toBe(false);
      expect(Product.exists).not.toHaveBeenCalled();
    });

    it('returns false and does not throw when Product.exists rejects', async () => {
      Product.exists.mockRejectedValue(new Error('DB connection lost'));
      const interaction = makeInteraction({ metadata: { postId: 'post_err' } });
      await expect(isCommentOnProductLinkedPost(interaction, ORG_ID)).resolves.toBe(false);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// resolveInstagramPrivateReplyPageId
// ─────────────────────────────────────────────────────────────────────────────

describe('resolveInstagramPrivateReplyPageId', () => {
  it('returns null when connection is null', () => {
    expect(resolveInstagramPrivateReplyPageId(null, null)).toBeNull();
  });

  describe('instagram_login path', () => {
    it('prefers metadata.igLoginScopedId', () => {
      const conn = {
        metadata: { igLoginScopedId: 'scoped_123', connectionType: 'instagram_login' },
        platformUserId: 'user_456'
      };
      expect(resolveInstagramPrivateReplyPageId(conn, 'instagram_login')).toBe('scoped_123');
    });

    it('falls back to platformUserId when igLoginScopedId is absent', () => {
      const conn = { metadata: {}, platformUserId: 'user_456' };
      expect(resolveInstagramPrivateReplyPageId(conn, 'instagram_login')).toBe('user_456');
    });

    it('returns null when neither igLoginScopedId nor platformUserId are set', () => {
      const conn = { metadata: {} };
      expect(resolveInstagramPrivateReplyPageId(conn, 'instagram_login')).toBeNull();
    });
  });

  describe('Facebook-Login path (connType is null or other)', () => {
    it('prefers platformPageId', () => {
      const conn = {
        platformPageId: 'page_111',
        platformData: { pageId: 'page_222' },
        metadata: { facebookPageId: 'page_333' },
        platformUserId: 'user_444'
      };
      expect(resolveInstagramPrivateReplyPageId(conn, null)).toBe('page_111');
    });

    it('falls back to platformData.pageId when platformPageId is absent', () => {
      const conn = {
        platformData: { pageId: 'page_222' },
        metadata: { facebookPageId: 'page_333' },
        platformUserId: 'user_444'
      };
      expect(resolveInstagramPrivateReplyPageId(conn, null)).toBe('page_222');
    });

    it('falls back to metadata.facebookPageId', () => {
      const conn = {
        metadata: { facebookPageId: 'page_333' },
        platformUserId: 'user_444'
      };
      expect(resolveInstagramPrivateReplyPageId(conn, null)).toBe('page_333');
    });

    it('falls back to platformUserId as last resort', () => {
      const conn = { metadata: {}, platformUserId: 'user_444' };
      expect(resolveInstagramPrivateReplyPageId(conn, null)).toBe('user_444');
    });

    it('returns null when all fields are absent', () => {
      const conn = { metadata: {} };
      expect(resolveInstagramPrivateReplyPageId(conn, null)).toBeNull();
    });
  });
});
