/**
 * Tests for the new orchestration primitives in postPublishService:
 *   - PostPublishError contract
 *   - resolvePlatformConnection (Facebook/YouTube/default paths)
 *   - resolveMediaForPost (all five media sources + validation)
 *   - publishExistingPost (state transitions + per-platform routing + usage)
 *   - incrementMediaLibraryUsage (best-effort, never throws)
 *
 * The low-level platform publishers (publishToInstagram/Facebook/LinkedIn)
 * and executePublishForScheduledPost are NOT covered here — they wrap external
 * integration SDKs and are better tested at integration boundary.
 */

jest.mock('../../../src/models/PlatformConnection', () => ({ findOne: jest.fn() }));
jest.mock('../../../src/models/Media', () => ({ find: jest.fn(), findOne: jest.fn(), findById: jest.fn() }));
jest.mock('../../../src/models/ScheduledPost', () => ({ findById: jest.fn() }));
jest.mock('../../../src/integrations/meta/instagramService', () => ({
  createPost: jest.fn(),
  createStory: jest.fn(),
  createReel: jest.fn(),
  createCarouselPost: jest.fn()
}));
jest.mock('../../../src/integrations/meta/facebookService', () => ({
  createPost: jest.fn(),
  createVideoPost: jest.fn(),
  createStory: jest.fn(),
  createReel: jest.fn()
}));
jest.mock('../../../src/integrations/linkedin/linkedinService', () => ({
  createPost: jest.fn()
}));

jest.mock('../../../src/services/storageService', () => ({
  isS3Configured: jest.fn(() => false),
  buildPostsKey: jest.fn((orgId, filename) => `posts/${orgId}/${filename}`),
  uploadBuffer: jest.fn(),
  resolvePublicUrl: jest.fn((fp) => `https://cdn.example/${require('path').basename(fp)}`)
}));

jest.mock('../../../src/config/platformMediaRequirements', () => ({
  validateMedia: jest.fn(() => ({ valid: true, errors: [], warnings: [] }))
}));

jest.mock('../../../src/config/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn()
}));

// complianceService hits BrandConfig (a real Mongoose model) — mock it so these
// unit tests never touch a DB connection. Default: no violation, so existing
// publish-path tests are unaffected; individual tests override as needed.
jest.mock('../../../src/services/complianceService', () => ({
  checkContent: jest.fn().mockResolvedValue({ riskScore: 0, complianceFlags: [], hardViolation: false })
}));

jest.mock('fs', () => {
  const actual = jest.requireActual('fs');
  return {
    ...actual,
    promises: {
      unlink: jest.fn().mockResolvedValue(undefined),
      readFile: jest.fn().mockResolvedValue(Buffer.from('file-bytes')),
      access: jest.fn().mockResolvedValue(undefined)
    }
  };
});

const PlatformConnection = require('../../../src/models/PlatformConnection');
const Media = require('../../../src/models/Media');
const storageService = require('../../../src/services/storageService');
const { validateMedia } = require('../../../src/config/platformMediaRequirements');
const instagramService = require('../../../src/integrations/meta/instagramService');
const facebookService = require('../../../src/integrations/meta/facebookService');
const linkedinService = require('../../../src/integrations/linkedin/linkedinService');
const complianceService = require('../../../src/services/complianceService');
const fs = require('fs').promises;

const svc = require('../../../src/services/postPublishService');
const {
  PostPublishError,
  resolvePlatformConnection,
  resolveMediaForPost,
  publishExistingPost,
  incrementMediaLibraryUsage
} = svc;

const orgId = 'org-1';

beforeEach(() => {
  PlatformConnection.findOne.mockReset();
  Media.find.mockReset();
  Media.findOne.mockReset();
  Media.findById.mockReset();

  storageService.isS3Configured.mockReset().mockReturnValue(false);
  storageService.buildPostsKey.mockClear();
  storageService.uploadBuffer.mockReset();
  storageService.resolvePublicUrl.mockClear();

  validateMedia.mockReset().mockReturnValue({ valid: true, errors: [], warnings: [] });

  fs.unlink.mockReset().mockResolvedValue(undefined);
  fs.readFile.mockReset().mockResolvedValue(Buffer.from('file-bytes'));
  fs.access.mockReset().mockResolvedValue(undefined);

  Object.values(instagramService).forEach((fn) => fn.mockReset?.());
  Object.values(facebookService).forEach((fn) => fn.mockReset?.());
  Object.values(linkedinService).forEach((fn) => fn.mockReset?.());

  complianceService.checkContent.mockReset()
    .mockResolvedValue({ riskScore: 0, complianceFlags: [], hardViolation: false });
});

// ────────────────────────────────────────────────────────────────────────────
describe('PostPublishError', () => {
  test('defaults: statusCode=500, code=null, extras=null', () => {
    const e = new PostPublishError('fail');
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe('PostPublishError');
    expect(e.statusCode).toBe(500);
    expect(e.code).toBe(null);
    expect(e.extras).toBe(null);
  });

  test('captures statusCode / code / extras', () => {
    const e = new PostPublishError('nope', {
      statusCode: 422, code: 'PLATFORM_UNSUPPORTED', extras: { platform: 'tiktok' }
    });
    expect(e.statusCode).toBe(422);
    expect(e.code).toBe('PLATFORM_UNSUPPORTED');
    expect(e.extras).toEqual({ platform: 'tiktok' });
  });
});

// ────────────────────────────────────────────────────────────────────────────
describe('resolvePlatformConnection', () => {
  test('YouTube rejects with 501 PLATFORM_NOT_IMPLEMENTED without hitting DB', async () => {
    await expect(resolvePlatformConnection(orgId, 'youtube'))
      .rejects.toMatchObject({ statusCode: 501, code: 'PLATFORM_NOT_IMPLEMENTED' });
    expect(PlatformConnection.findOne).not.toHaveBeenCalled();
  });

  test('Facebook query uses page-level filter (platformPageId + usesAccountSlot)', async () => {
    PlatformConnection.findOne.mockResolvedValueOnce({ _id: 'c1', platform: 'facebook' });
    const conn = await resolvePlatformConnection(orgId, 'Facebook');
    expect(PlatformConnection.findOne).toHaveBeenCalledWith(expect.objectContaining({
      platform: 'facebook',
      organization: orgId,
      isActive: true,
      platformPageId: { $exists: true, $ne: null },
      usesAccountSlot: true
    }));
    expect(conn._id).toBe('c1');
  });

  test('non-Facebook query omits the page filter', async () => {
    PlatformConnection.findOne.mockResolvedValueOnce({ _id: 'c2', platform: 'instagram' });
    await resolvePlatformConnection(orgId, 'instagram');
    const q = PlatformConnection.findOne.mock.calls[0][0];
    expect(q).not.toHaveProperty('platformPageId');
    expect(q).not.toHaveProperty('usesAccountSlot');
  });

  test('missing connection for Facebook → 404 with FB-specific message', async () => {
    PlatformConnection.findOne.mockResolvedValueOnce(null);
    await expect(resolvePlatformConnection(orgId, 'facebook'))
      .rejects.toMatchObject({
        statusCode: 404,
        code: 'PLATFORM_NOT_CONNECTED',
        message: expect.stringMatching(/Facebook page connection/i)
      });
  });

  test('missing connection for other platforms → 404 with generic message', async () => {
    PlatformConnection.findOne.mockResolvedValueOnce(null);
    await expect(resolvePlatformConnection(orgId, 'instagram'))
      .rejects.toMatchObject({
        statusCode: 404,
        code: 'PLATFORM_NOT_CONNECTED',
        message: expect.stringMatching(/No active instagram connection found/)
      });
  });
});

// ────────────────────────────────────────────────────────────────────────────
describe('resolveMediaForPost', () => {
  const fakeReq = (overrides = {}) => ({
    body: {},
    files: undefined,
    file: undefined,
    get: () => 'repmeup.in',
    protocol: 'https',
    ...overrides
  });

  describe('library carousel (mediaLibraryIds)', () => {
    test('returns carousel arrays and populates single-field backward-compat values', async () => {
      Media.find.mockResolvedValueOnce([
        { _id: 'm1', publicUrl: 'https://cdn.example/a.jpg', mediaType: 'image' },
        { _id: 'm2', publicUrl: 'https://cdn.example/b.mp4', mediaType: 'video' }
      ]);
      const req = fakeReq({ body: { mediaLibraryIds: ['m1', 'm2'] } });
      const out = await resolveMediaForPost(req, orgId, 'instagram', 'post');
      expect(out.mediaStoragePaths).toEqual(['https://cdn.example/a.jpg', 'https://cdn.example/b.mp4']);
      expect(out.mediaTypes).toEqual(['image', 'video']);
      expect(out.mediaStoragePath).toBe('https://cdn.example/a.jpg');
      expect(out.mediaType).toBe('image');
      expect(out.mediaLibraryIds).toEqual(['m1', 'm2']);
    });

    test('accepts mediaLibraryIds as JSON string (multer form-data quirk)', async () => {
      Media.find.mockResolvedValueOnce([{ _id: 'm1', publicUrl: 'u', mediaType: 'image' }]);
      const req = fakeReq({ body: { mediaLibraryIds: JSON.stringify(['m1']) } });
      await resolveMediaForPost(req, orgId, 'instagram', 'post');
      expect(Media.find).toHaveBeenCalledWith(expect.objectContaining({
        _id: { $in: ['m1'] }, organization: orgId
      }));
    });

    test('throws 404 MEDIA_NOT_FOUND when some IDs are missing from DB', async () => {
      Media.find.mockResolvedValueOnce([{ _id: 'm1', publicUrl: 'u', mediaType: 'image' }]);
      const req = fakeReq({ body: { mediaLibraryIds: ['m1', 'm2'] } });
      await expect(resolveMediaForPost(req, orgId, 'instagram', 'post'))
        .rejects.toMatchObject({ statusCode: 404, code: 'MEDIA_NOT_FOUND' });
    });

    test('falls back to storageService.resolvePublicUrl when publicUrl missing', async () => {
      Media.find.mockResolvedValueOnce([{ _id: 'm1', publicUrl: null, filePath: '/local/a.jpg', mediaType: 'image' }]);
      const req = fakeReq({ body: { mediaLibraryIds: ['m1'] } });
      const out = await resolveMediaForPost(req, orgId, 'instagram', 'post');
      expect(storageService.resolvePublicUrl).toHaveBeenCalled();
      expect(out.mediaStoragePath).toMatch(/^https:\/\/cdn\.example\/a\.jpg$/);
    });
  });

  describe('single library media (mediaLibraryId)', () => {
    test('returns the item with mediaLibraryId set', async () => {
      Media.findOne.mockResolvedValueOnce({
        _id: 'm1', publicUrl: 'https://cdn.example/x.png', mediaType: 'image', originalName: 'x.png'
      });
      const req = fakeReq({ body: { mediaLibraryId: 'm1' } });
      const out = await resolveMediaForPost(req, orgId, 'instagram', 'post');
      expect(out).toEqual({
        mediaStoragePath: 'https://cdn.example/x.png',
        mediaType: 'image',
        mediaLibraryId: 'm1'
      });
    });

    test('throws 404 MEDIA_NOT_FOUND when library item missing', async () => {
      Media.findOne.mockResolvedValueOnce(null);
      const req = fakeReq({ body: { mediaLibraryId: 'm-missing' } });
      await expect(resolveMediaForPost(req, orgId, 'instagram', 'post'))
        .rejects.toMatchObject({ statusCode: 404, code: 'MEDIA_NOT_FOUND' });
    });
  });

  describe('multer multi-file upload (req.files)', () => {
    const files = [
      { path: '/tmp/a.png', originalname: 'a.png', mimetype: 'image/png', size: 1024 },
      { path: '/tmp/b.mp4', originalname: 'b.mp4', mimetype: 'video/mp4', size: 4096 }
    ];

    test('keeps local paths when S3 is not configured', async () => {
      const req = fakeReq({ files });
      const out = await resolveMediaForPost(req, orgId, 'instagram', 'post');
      expect(out.mediaStoragePaths).toEqual(['/tmp/a.png', '/tmp/b.mp4']);
      expect(out.mediaTypes).toEqual(['image', 'video']);
      expect(fs.unlink).not.toHaveBeenCalled();
      expect(storageService.uploadBuffer).not.toHaveBeenCalled();
    });

    test('uploads to S3, deletes temp file, and uses CDN URL when S3 configured', async () => {
      storageService.isS3Configured.mockReturnValue(true);
      storageService.uploadBuffer
        .mockResolvedValueOnce({ publicUrl: 'https://s3/a.png', key: 'k1' })
        .mockResolvedValueOnce({ publicUrl: 'https://s3/b.mp4', key: 'k2' });
      const req = fakeReq({ files });
      const out = await resolveMediaForPost(req, orgId, 'instagram', 'post');
      expect(storageService.uploadBuffer).toHaveBeenCalledTimes(2);
      expect(out.mediaStoragePaths).toEqual(['https://s3/a.png', 'https://s3/b.mp4']);
      expect(fs.unlink).toHaveBeenCalledTimes(2);
    });

    test('validates every file up-front; deletes all on validation failure', async () => {
      validateMedia.mockImplementation((platform, type, size, ext, postType) =>
        ext === '.mp4'
          ? { valid: false, errors: ['too big'], warnings: [] }
          : { valid: true, errors: [], warnings: [] }
      );
      const req = fakeReq({ files });
      await expect(resolveMediaForPost(req, orgId, 'instagram', 'post'))
        .rejects.toMatchObject({ statusCode: 400, code: 'MEDIA_VALIDATION_FAILED' });
      expect(fs.unlink).toHaveBeenCalledTimes(2); // both temp files cleaned up
    });
  });

  describe('multer single-file upload (req.file)', () => {
    const file = { path: '/tmp/solo.png', originalname: 'solo.png', mimetype: 'image/png', size: 2048 };

    test('returns path when valid and S3 not configured', async () => {
      const req = fakeReq({ file });
      const out = await resolveMediaForPost(req, orgId, 'linkedin', 'post');
      expect(out).toEqual({ mediaStoragePath: '/tmp/solo.png', mediaType: 'image' });
    });

    test('uploads + deletes when S3 configured', async () => {
      storageService.isS3Configured.mockReturnValue(true);
      storageService.uploadBuffer.mockResolvedValueOnce({ publicUrl: 'https://s3/solo.png', key: 'k' });
      const req = fakeReq({ file });
      const out = await resolveMediaForPost(req, orgId, 'linkedin', 'post');
      expect(out.mediaStoragePath).toBe('https://s3/solo.png');
      expect(fs.unlink).toHaveBeenCalledWith('/tmp/solo.png');
    });

    test('invalid → deletes file and throws 400', async () => {
      validateMedia.mockReturnValueOnce({ valid: false, errors: ['bad'], warnings: [] });
      const req = fakeReq({ file });
      await expect(resolveMediaForPost(req, orgId, 'linkedin', 'post'))
        .rejects.toMatchObject({ statusCode: 400, code: 'MEDIA_VALIDATION_FAILED' });
      expect(fs.unlink).toHaveBeenCalledWith('/tmp/solo.png');
    });
  });

  describe('mediaUrl string body', () => {
    test('absolute HTTPS URL becomes mediaStoragePath (image)', async () => {
      const req = fakeReq({ body: { mediaUrl: 'https://cdn.example/a.jpg?x=1' } });
      const out = await resolveMediaForPost(req, orgId, 'instagram', 'post');
      expect(out).toEqual({
        mediaStoragePath: 'https://cdn.example/a.jpg',
        mediaType: 'image'
      });
    });

    test('absolute URL with .mp4 → type=video', async () => {
      const req = fakeReq({ body: { mediaUrl: 'https://cdn.example/reel.mp4' } });
      const out = await resolveMediaForPost(req, orgId, 'instagram', 'reel');
      expect(out.mediaType).toBe('video');
    });

    test('absolute URL containing /api/posts/media/ still takes the external-URL branch', async () => {
      // Priority: any http(s) URL hits the external-URL branch first, even if
      // it includes the /api/posts/media/ path. This matches the pre-refactor
      // controller behaviour.
      const req = fakeReq({
        body: { mediaUrl: 'https://repmeup.in/api/posts/media/ai-1-abc.png' }
      });
      const out = await resolveMediaForPost(req, orgId, 'instagram', 'post');
      expect(out.mediaType).toBe('image');
      expect(out.mediaStoragePath).toBe('https://repmeup.in/api/posts/media/ai-1-abc.png');
      expect(fs.access).not.toHaveBeenCalled();
    });

    test('relative /api/posts/media/ URL → on-disk resolution when file exists', async () => {
      const req = fakeReq({
        body: { mediaUrl: '/api/posts/media/ai-1-abc.png' }
      });
      const out = await resolveMediaForPost(req, orgId, 'instagram', 'post');
      expect(out.mediaType).toBe('image');
      expect(out.mediaStoragePath).toMatch(/uploads\/posts\/ai-1-abc\.png$/);
      expect(fs.access).toHaveBeenCalled();
    });

    test('relative /api/posts/media/ URL → returns empty descriptor when file missing', async () => {
      fs.access.mockRejectedValueOnce(new Error('ENOENT'));
      const req = fakeReq({
        body: { mediaUrl: '/api/posts/media/missing.png' }
      });
      const out = await resolveMediaForPost(req, orgId, 'instagram', 'post');
      expect(out).toEqual({});
    });
  });

  test('no media source → returns empty object', async () => {
    const req = fakeReq();
    const out = await resolveMediaForPost(req, orgId, 'twitter', 'post');
    expect(out).toEqual({});
  });
});

// ────────────────────────────────────────────────────────────────────────────
describe('resolveCarouselFromLibraryIds', () => {
  const { resolveCarouselFromLibraryIds } = svc;
  const fakeReq = () => ({ get: () => 'repmeup.in', protocol: 'https' });

  test('rejects any platform other than instagram', async () => {
    await expect(resolveCarouselFromLibraryIds(['m1', 'm2'], orgId, 'facebook', fakeReq()))
      .rejects.toMatchObject({ statusCode: 400, code: 'CAROUSEL_UNSUPPORTED_PLATFORM' });
    await expect(resolveCarouselFromLibraryIds(['m1', 'm2'], orgId, 'linkedin', fakeReq()))
      .rejects.toMatchObject({ statusCode: 400, code: 'CAROUSEL_UNSUPPORTED_PLATFORM' });
    expect(Media.find).not.toHaveBeenCalled();
  });

  test('is case-insensitive on platform ("Instagram" is accepted)', async () => {
    Media.find.mockResolvedValueOnce([
      { _id: 'm1', publicUrl: 'https://cdn.example/a.jpg', mediaType: 'image' },
      { _id: 'm2', publicUrl: 'https://cdn.example/b.jpg', mediaType: 'image' }
    ]);
    await expect(resolveCarouselFromLibraryIds(['m1', 'm2'], orgId, 'Instagram', fakeReq()))
      .resolves.toBeDefined();
  });

  test('rejects fewer than 2 images', async () => {
    await expect(resolveCarouselFromLibraryIds(['m1'], orgId, 'instagram', fakeReq()))
      .rejects.toMatchObject({ statusCode: 400, code: 'CAROUSEL_INVALID_COUNT' });
    expect(Media.find).not.toHaveBeenCalled();
  });

  test('rejects more than 10 images', async () => {
    const ids = Array.from({ length: 11 }, (_, i) => `m${i}`);
    await expect(resolveCarouselFromLibraryIds(ids, orgId, 'instagram', fakeReq()))
      .rejects.toMatchObject({ statusCode: 400, code: 'CAROUSEL_INVALID_COUNT' });
  });

  test('throws 404 MEDIA_NOT_FOUND when an id is missing or cross-org', async () => {
    Media.find.mockResolvedValueOnce([{ _id: 'm1', publicUrl: 'u', mediaType: 'image' }]);
    await expect(resolveCarouselFromLibraryIds(['m1', 'm2'], orgId, 'instagram', fakeReq()))
      .rejects.toMatchObject({ statusCode: 404, code: 'MEDIA_NOT_FOUND' });
  });

  test('rejects when any item is not an image (e.g. video)', async () => {
    Media.find.mockResolvedValueOnce([
      { _id: 'm1', publicUrl: 'https://cdn.example/a.jpg', mediaType: 'image' },
      { _id: 'm2', publicUrl: 'https://cdn.example/b.mp4', mediaType: 'video' }
    ]);
    await expect(resolveCarouselFromLibraryIds(['m1', 'm2'], orgId, 'instagram', fakeReq()))
      .rejects.toMatchObject({ statusCode: 400, code: 'CAROUSEL_INVALID_MEDIA_TYPE' });
  });

  test('scopes lookup to the caller organization', async () => {
    Media.find.mockResolvedValueOnce([
      { _id: 'm1', publicUrl: 'a', mediaType: 'image' },
      { _id: 'm2', publicUrl: 'b', mediaType: 'image' }
    ]);
    await resolveCarouselFromLibraryIds(['m1', 'm2'], orgId, 'instagram', fakeReq());
    expect(Media.find).toHaveBeenCalledWith({ _id: { $in: ['m1', 'm2'] }, organization: orgId });
  });

  test('preserves the caller-supplied order regardless of DB return order', async () => {
    // Media.find often returns docs in a different order than $in was given
    Media.find.mockResolvedValueOnce([
      { _id: 'm2', publicUrl: 'https://cdn.example/b.jpg', mediaType: 'image' },
      { _id: 'm1', publicUrl: 'https://cdn.example/a.jpg', mediaType: 'image' }
    ]);
    const out = await resolveCarouselFromLibraryIds(['m1', 'm2'], orgId, 'instagram', fakeReq());
    expect(out.mediaStoragePaths).toEqual(['https://cdn.example/a.jpg', 'https://cdn.example/b.jpg']);
    expect(out.mediaLibraryIds).toEqual(['m1', 'm2']);
    expect(out.mediaStoragePath).toBe('https://cdn.example/a.jpg');
  });

  test('accepts a JSON-encoded array string (form-data quirk)', async () => {
    Media.find.mockResolvedValueOnce([
      { _id: 'm1', publicUrl: 'a', mediaType: 'image' },
      { _id: 'm2', publicUrl: 'b', mediaType: 'image' }
    ]);
    const out = await resolveCarouselFromLibraryIds(JSON.stringify(['m1', 'm2']), orgId, 'instagram', fakeReq());
    expect(out.mediaLibraryIds).toEqual(['m1', 'm2']);
  });

  test('falls back to storageService.resolvePublicUrl when publicUrl missing', async () => {
    Media.find.mockResolvedValueOnce([
      { _id: 'm1', publicUrl: null, filePath: '/local/a.jpg', mediaType: 'image' },
      { _id: 'm2', publicUrl: 'https://cdn.example/b.jpg', mediaType: 'image' }
    ]);
    const out = await resolveCarouselFromLibraryIds(['m1', 'm2'], orgId, 'instagram', fakeReq());
    expect(storageService.resolvePublicUrl).toHaveBeenCalled();
    expect(out.mediaStoragePaths[0]).toMatch(/^https:\/\/cdn\.example\/a\.jpg$/);
  });
});

// ────────────────────────────────────────────────────────────────────────────
describe('publishExistingPost', () => {
  // Build a fake post that records state transitions via save()
  const makePost = (overrides = {}) => {
    const post = {
      _id: 'p1',
      platform: 'instagram',
      status: 'draft',
      content: 'hello',
      mediaStoragePath: 'https://cdn.example/x.png',
      mediaType: 'image',
      save: jest.fn().mockResolvedValue(true),
      ...overrides
    };
    return post;
  };

  const connection = { _id: 'c1', platform: 'instagram' };
  const req = { protocol: 'https', get: () => 'repmeup.in' };

  test('happy path: instagram — status goes draft → publishing → published, fields populated', async () => {
    instagramService.createPost.mockResolvedValue({
      postId: 'ig_123', postUrl: 'https://instagram.com/p/ig_123'
    });
    const post = makePost();
    const out = await publishExistingPost(post, connection, req);
    expect(instagramService.createPost).toHaveBeenCalled();
    expect(post.status).toBe('published');
    expect(post.platformPostId).toBe('ig_123');
    expect(post.platformPostUrl).toBe('https://instagram.com/p/ig_123');
    expect(post.publishedAt).toBeInstanceOf(Date);
    expect(post.error).toBeUndefined();
    expect(post.save).toHaveBeenCalledTimes(2); // 'publishing' then 'published'
    expect(out).toEqual({ post, platformPostUrl: 'https://instagram.com/p/ig_123' });
  });

  test('happy path: facebook + linkedin routes use correct integration SDK', async () => {
    // Facebook image post fetches bytes via axios (mediaStoragePath is https URL,
    // readImageBufferForPublish calls axios.get). To keep this test hermetic
    // we use a text-only post (no media) so facebookService.createPost is called
    // with just { message }.
    facebookService.createPost.mockResolvedValue({ postId: 'fb_1', postUrl: 'u_fb' });
    const fbPost = makePost({
      platform: 'facebook',
      mediaStoragePath: undefined,
      mediaType: undefined
    });
    await publishExistingPost(fbPost, connection, req);
    expect(facebookService.createPost).toHaveBeenCalled();
    expect(fbPost.status).toBe('published');
    expect(fbPost.platformPostId).toBe('fb_1');

    // LinkedIn text-only post (no media) — avoids the image-buffer fetch path.
    linkedinService.createPost.mockResolvedValue({ postId: 'li_1', postUrl: 'u_li' });
    const liPost = makePost({
      platform: 'LinkedIn',
      mediaStoragePath: undefined,
      mediaType: undefined
    });
    await publishExistingPost(liPost, connection, req);
    expect(linkedinService.createPost).toHaveBeenCalled();
    expect(liPost.status).toBe('published');
  });

  test('YouTube post → PostPublishError 501 PLATFORM_NOT_IMPLEMENTED + status=failed', async () => {
    const post = makePost({ platform: 'youtube' });
    await expect(publishExistingPost(post, connection, req))
      .rejects.toMatchObject({ statusCode: 501, code: 'PLATFORM_NOT_IMPLEMENTED' });
    expect(post.status).toBe('failed');
    expect(post.error).toMatch(/YouTube publishing is coming soon/);
  });

  test('unsupported platform → PostPublishError 422 PLATFORM_UNSUPPORTED + status=failed', async () => {
    const post = makePost({ platform: 'tiktok' });
    await expect(publishExistingPost(post, connection, req))
      .rejects.toMatchObject({ statusCode: 422, code: 'PLATFORM_UNSUPPORTED' });
    expect(post.status).toBe('failed');
  });

  test('platform error sets status=failed, preserves error.message, rethrows with platformError', async () => {
    instagramService.createPost.mockRejectedValue(
      Object.assign(new Error('rate limited'), { platformError: { code: 4, subcode: 1 } })
    );
    const post = makePost();
    await expect(publishExistingPost(post, connection, req))
      .rejects.toMatchObject({ message: 'rate limited', platformError: { code: 4, subcode: 1 } });
    expect(post.status).toBe('failed');
    expect(post.error).toBe('rate limited');
  });

  describe('compliance enforcement', () => {
    test('hard violation blocks publish with 422 COMPLIANCE_BLOCKED, never reaches the platform SDK', async () => {
      complianceService.checkContent.mockResolvedValueOnce({
        riskScore: 25,
        complianceFlags: ['Contains banned word: "guarantee"'],
        hardViolation: true
      });
      const post = makePost({ status: 'pending_approval' });
      await expect(publishExistingPost(post, connection, req))
        .rejects.toMatchObject({ statusCode: 422, code: 'COMPLIANCE_BLOCKED' });
      expect(instagramService.createPost).not.toHaveBeenCalled();
      // Status is untouched (never flipped to 'publishing'/'failed') — the
      // post stays exactly where a human left it (e.g. pending_approval) so
      // it isn't mistaken for a platform-side failure.
      expect(post.status).toBe('pending_approval');
      expect(post.riskScore).toBe(25);
      expect(post.complianceFlags).toEqual(['Contains banned word: "guarantee"']);
      expect(post.save).toHaveBeenCalled();
    });

    test('soft flags (no hard violation) do not block — publish proceeds and flags are persisted', async () => {
      complianceService.checkContent.mockResolvedValueOnce({
        riskScore: 15,
        complianceFlags: ['Legal disclaimer may be required'],
        hardViolation: false
      });
      instagramService.createPost.mockResolvedValue({ postId: 'ig_1', postUrl: 'u' });
      const post = makePost();
      await publishExistingPost(post, connection, req);
      expect(post.status).toBe('published');
      expect(post.riskScore).toBe(15);
      expect(post.complianceFlags).toEqual(['Legal disclaimer may be required']);
    });

    test('checkContent is called with the post organization and current content (not any pre-set field)', async () => {
      const post = makePost({ organization: 'org-xyz', content: 'fresh content', riskScore: 999, complianceFlags: ['stale'] });
      instagramService.createPost.mockResolvedValue({ postId: 'ig_1', postUrl: 'u' });
      await publishExistingPost(post, connection, req);
      expect(complianceService.checkContent).toHaveBeenCalledWith('org-xyz', 'fresh content');
    });
  });
});

// ────────────────────────────────────────────────────────────────────────────
describe('incrementMediaLibraryUsage', () => {
  test('increments usage on single library media (mediaLibraryId)', async () => {
    const media = { originalName: 'x.png', incrementUsage: jest.fn().mockResolvedValue(true) };
    Media.findById.mockResolvedValueOnce(media);
    await incrementMediaLibraryUsage({ mediaLibraryId: 'm1' });
    expect(media.incrementUsage).toHaveBeenCalled();
  });

  test('increments usage for every id in mediaLibraryIds', async () => {
    const m1 = { incrementUsage: jest.fn().mockResolvedValue(true) };
    const m2 = { incrementUsage: jest.fn().mockResolvedValue(true) };
    Media.findById
      .mockResolvedValueOnce(m1)
      .mockResolvedValueOnce(m2);
    await incrementMediaLibraryUsage({ mediaLibraryIds: ['a', 'b'] });
    expect(m1.incrementUsage).toHaveBeenCalled();
    expect(m2.incrementUsage).toHaveBeenCalled();
  });

  test('does nothing when post has no library references', async () => {
    await incrementMediaLibraryUsage({});
    expect(Media.findById).not.toHaveBeenCalled();
  });

  test('swallows errors (never throws) on single-media path', async () => {
    Media.findById.mockRejectedValueOnce(new Error('db down'));
    await expect(incrementMediaLibraryUsage({ mediaLibraryId: 'm1' })).resolves.toBeUndefined();
  });

  test('swallows errors (never throws) on carousel path', async () => {
    Media.findById.mockRejectedValueOnce(new Error('db down'));
    await expect(incrementMediaLibraryUsage({ mediaLibraryIds: ['a', 'b'] })).resolves.toBeUndefined();
  });

  test('missing media (findById → null) does not throw', async () => {
    Media.findById.mockResolvedValueOnce(null);
    await expect(incrementMediaLibraryUsage({ mediaLibraryId: 'm-missing' })).resolves.toBeUndefined();
  });
});
