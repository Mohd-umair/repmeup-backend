/**
 * Tests for contentStudioInputController — the Content Studio "Product
 * Shoot" ephemeral upload endpoints (upload/get/list/remove/promote).
 *
 * Mocking:
 *   - sharp: decode/re-encode pipeline (also validates + strips metadata).
 *   - GenerationInputImage / BrandReferenceImage / BrandConfig models.
 *   - storageService, fs (local-disk fallback path), logger.
 *   - utils/idempotency.runIdempotent: pass-through (its own guarantees are
 *     covered by idempotency.test.js) so these tests focus on controller logic.
 *   - brandReferenceImageController: exposes MAX_IMAGES_PER_ORG /
 *     CATEGORY_OPTIONS / analyzeImageAsync, reused by promote().
 */

jest.mock('sharp', () => jest.fn());

jest.mock('../../../src/config/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn()
}));

jest.mock('../../../src/models/GenerationInputImage', () => ({
  countDocuments: jest.fn(),
  create: jest.fn(),
  findOne: jest.fn(),
  find: jest.fn(),
  findOneAndDelete: jest.fn()
}));

jest.mock('../../../src/models/BrandReferenceImage', () => ({
  countDocuments: jest.fn(),
  create: jest.fn()
}));

jest.mock('../../../src/models/BrandConfig', () => ({
  updateOne: jest.fn(() => ({ catch: () => {} }))
}));

jest.mock('../../../src/services/storageService', () => ({
  isS3Configured: jest.fn(() => false),
  uploadBuffer: jest.fn(),
  buildContentStudioInputKey: jest.fn((org, name) => `content-studio/inputs/${org}/${name}`),
  deleteObjectByKey: jest.fn(() => ({ catch: () => {} }))
}));

jest.mock('../../../src/utils/idempotency', () => ({
  runIdempotent: jest.fn((org, scope, key, fn) => fn())
}));

jest.mock('../../../src/controllers/brandReferenceImageController', () => ({
  MAX_IMAGES_PER_ORG: 20,
  CATEGORY_OPTIONS: ['general', 'product', 'lifestyle', 'event', 'typography', 'layout'],
  analyzeImageAsync: jest.fn(() => Promise.resolve())
}));

jest.mock('fs', () => ({
  existsSync: jest.fn(() => true),
  mkdirSync: jest.fn(),
  writeFileSync: jest.fn(),
  unlinkSync: jest.fn()
}));

const sharp = require('sharp');
const GenerationInputImage = require('../../../src/models/GenerationInputImage');
const BrandReferenceImage = require('../../../src/models/BrandReferenceImage');
const BrandConfig = require('../../../src/models/BrandConfig');
const storageService = require('../../../src/services/storageService');
const refImageController = require('../../../src/controllers/brandReferenceImageController');
const controller = require('../../../src/controllers/contentStudioInputController');

function makePipeline({ metadata = { width: 800, height: 600 }, buffer = Buffer.from('clean-image') } = {}) {
  const pipeline = {
    rotate: () => pipeline,
    metadata: async () => metadata,
    png: () => ({ toBuffer: async () => buffer }),
    jpeg: () => ({ toBuffer: async () => buffer }),
    webp: () => ({ toBuffer: async () => buffer })
  };
  return pipeline;
}

function mockRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };
}

const orgId = 'org1';
const userId = 'user1';

beforeEach(() => {
  sharp.mockReset().mockImplementation(() => makePipeline());
  GenerationInputImage.countDocuments.mockReset().mockResolvedValue(0);
  GenerationInputImage.create.mockReset();
  GenerationInputImage.findOne.mockReset();
  GenerationInputImage.find.mockReset();
  GenerationInputImage.findOneAndDelete.mockReset();
  BrandReferenceImage.countDocuments.mockReset().mockResolvedValue(0);
  BrandReferenceImage.create.mockReset();
  BrandConfig.updateOne.mockReset().mockReturnValue({ catch: () => {} });
  storageService.isS3Configured.mockReset().mockReturnValue(false);
  storageService.uploadBuffer.mockReset();
  storageService.deleteObjectByKey.mockReset().mockReturnValue({ catch: () => {} });
  refImageController.analyzeImageAsync.mockReset().mockResolvedValue();
});

describe('upload', () => {
  function baseReq(overrides = {}) {
    return {
      user: { _id: userId, organization: orgId },
      file: { buffer: Buffer.from('img'), mimetype: 'image/jpeg', size: 1024, originalname: 'shoe.jpg' },
      body: {},
      get: () => null,
      ...overrides
    };
  }

  test('400 when no file is provided', async () => {
    const res = mockRes();
    await controller.upload(baseReq({ file: undefined }), res);
    expect(res.statusCode).toBe(400);
    expect(res.body.success).toBe(false);
  });

  test('503 PRODUCT_SHOOT_UNAVAILABLE when the emergency kill switch is on', async () => {
    process.env.PRODUCT_SHOOT_KILL_SWITCH = 'true';
    try {
      const res = mockRes();
      await controller.upload(baseReq(), res);
      expect(res.statusCode).toBe(503);
      expect(res.body).toEqual(expect.objectContaining({ success: false, code: 'PRODUCT_SHOOT_UNAVAILABLE' }));
      expect(GenerationInputImage.create).not.toHaveBeenCalled();
    } finally {
      delete process.env.PRODUCT_SHOOT_KILL_SWITCH;
    }
  });

  test('400 for a disallowed mime type', async () => {
    const res = mockRes();
    await controller.upload(baseReq({ file: { buffer: Buffer.from('x'), mimetype: 'image/gif', size: 100 } }), res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/JPEG, PNG, and WebP/);
  });

  test('400 when file exceeds the size limit', async () => {
    const res = mockRes();
    await controller.upload(baseReq({ file: { buffer: Buffer.from('x'), mimetype: 'image/jpeg', size: 11 * 1024 * 1024 } }), res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/10MB/);
  });

  test('400 when the org/user has reached the active-upload limit', async () => {
    GenerationInputImage.countDocuments.mockResolvedValue(30);
    const res = mockRes();
    await controller.upload(baseReq(), res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/limit of 30/);
  });

  test('400 when sharp cannot decode the file (corrupt/fake image)', async () => {
    sharp.mockImplementation(() => { throw new Error('unsupported image format'); });
    const res = mockRes();
    await controller.upload(baseReq(), res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/valid image/);
    expect(GenerationInputImage.create).not.toHaveBeenCalled();
  });

  test('persists to local disk when S3 is not configured and returns id/imageUrl/expiresAt', async () => {
    GenerationInputImage.create.mockResolvedValue({
      _id: 'gen1', imageUrl: 'http://localhost:5000/uploads/content-studio-inputs/x.jpg',
      width: 800, height: 600, expiresAt: new Date(Date.now() + 1000)
    });
    const res = mockRes();
    await controller.upload(baseReq(), res);

    expect(storageService.uploadBuffer).not.toHaveBeenCalled();
    expect(GenerationInputImage.create).toHaveBeenCalledWith(expect.objectContaining({
      organization: orgId, user: userId, purpose: 'product_shoot', storageType: 'local', status: 'ready'
    }));
    expect(res.statusCode).toBe(201);
    expect(res.body).toEqual({
      success: true,
      data: { id: 'gen1', imageUrl: expect.stringContaining('uploads/content-studio-inputs'), width: 800, height: 600, expiresAt: expect.any(Date) }
    });
  });

  test('persists to S3 when configured', async () => {
    storageService.isS3Configured.mockReturnValue(true);
    storageService.uploadBuffer.mockResolvedValue({ publicUrl: 'https://cdn.example/content-studio/inputs/org1/x.jpg' });
    GenerationInputImage.create.mockResolvedValue({
      _id: 'gen2', imageUrl: 'https://cdn.example/content-studio/inputs/org1/x.jpg',
      width: 800, height: 600, expiresAt: new Date()
    });
    const res = mockRes();
    await controller.upload(baseReq(), res);

    expect(storageService.uploadBuffer).toHaveBeenCalled();
    expect(GenerationInputImage.create).toHaveBeenCalledWith(expect.objectContaining({ storageType: 's3' }));
    expect(res.statusCode).toBe(201);
  });

  test('sets a ~48h expiresAt on the created record', async () => {
    let created;
    GenerationInputImage.create.mockImplementation(async (doc) => { created = doc; return { _id: 'g', ...doc }; });
    const res = mockRes();
    const before = Date.now();
    await controller.upload(baseReq(), res);
    const deltaMs = created.expiresAt.getTime() - before;
    expect(deltaMs).toBeGreaterThan(47 * 60 * 60 * 1000);
    expect(deltaMs).toBeLessThan(49 * 60 * 60 * 1000);
  });
});

describe('get', () => {
  test('404 when not found', async () => {
    GenerationInputImage.findOne.mockReturnValue({ lean: async () => null });
    const res = mockRes();
    await controller.get({ user: { organization: orgId }, params: { id: 'x' } }, res);
    expect(res.statusCode).toBe(404);
  });

  test('200 with the record scoped to the org', async () => {
    GenerationInputImage.findOne.mockReturnValue({ lean: async () => ({ _id: 'x', imageUrl: 'u' }) });
    const res = mockRes();
    await controller.get({ user: { organization: orgId }, params: { id: 'x' } }, res);
    expect(GenerationInputImage.findOne).toHaveBeenCalledWith({ _id: 'x', organization: orgId });
    expect(res.body).toEqual({ success: true, data: { _id: 'x', imageUrl: 'u' } });
  });
});

describe('remove', () => {
  test('404 when not found, already expired, or already promoted', async () => {
    GenerationInputImage.findOneAndDelete.mockResolvedValue(null);
    const res = mockRes();
    await controller.remove({ user: { _id: userId, organization: orgId }, params: { id: 'x' } }, res);
    expect(res.statusCode).toBe(404);
  });

  test('deletes the S3 object when s3Key is set', async () => {
    GenerationInputImage.findOneAndDelete.mockResolvedValue({ s3Key: 'content-studio/inputs/org1/x.jpg', storageType: 's3', imageUrl: 'https://cdn/x.jpg' });
    const res = mockRes();
    await controller.remove({ user: { _id: userId, organization: orgId }, params: { id: 'x' } }, res);
    expect(storageService.deleteObjectByKey).toHaveBeenCalledWith('content-studio/inputs/org1/x.jpg');
    expect(res.body).toEqual({ success: true, message: 'Deleted' });
  });

  test('only deletes records the requesting user owns and has not promoted (scoping is enforced in the query)', async () => {
    GenerationInputImage.findOneAndDelete.mockResolvedValue({ storageType: 'local', imageUrl: 'http://x/y.jpg' });
    const res = mockRes();
    await controller.remove({ user: { _id: userId, organization: orgId }, params: { id: 'x' } }, res);
    expect(GenerationInputImage.findOneAndDelete).toHaveBeenCalledWith({
      _id: 'x', organization: orgId, user: userId, promotedReferenceImage: null
    });
  });
});

describe('promote', () => {
  function baseDoc(overrides = {}) {
    return {
      _id: 'gen1', imageUrl: 'https://cdn/gen1.jpg', s3Key: null, promotedReferenceImage: null,
      save: jest.fn().mockResolvedValue(undefined),
      ...overrides
    };
  }

  test('404 when the upload does not exist / is not owned by the org', async () => {
    GenerationInputImage.findOne.mockResolvedValue(null);
    const res = mockRes();
    await controller.promote({ user: { _id: userId, organization: orgId }, params: { id: 'x' }, body: {} }, res);
    expect(res.statusCode).toBe(404);
  });

  test('400 when the upload was already promoted', async () => {
    GenerationInputImage.findOne.mockResolvedValue(baseDoc({ promotedReferenceImage: 'already-there' }));
    const res = mockRes();
    await controller.promote({ user: { _id: userId, organization: orgId }, params: { id: 'x' }, body: {} }, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/already been saved/);
  });

  test('400 when Brand Hub is already at MAX_IMAGES_PER_ORG', async () => {
    GenerationInputImage.findOne.mockResolvedValue(baseDoc());
    BrandReferenceImage.countDocuments.mockResolvedValue(20);
    const res = mockRes();
    await controller.promote({ user: { _id: userId, organization: orgId }, params: { id: 'x' }, body: {} }, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/maximum of 20/);
    expect(BrandReferenceImage.create).not.toHaveBeenCalled();
  });

  test('creates a BrandReferenceImage reusing the same storage object, defaults category to "product"', async () => {
    const doc = baseDoc();
    GenerationInputImage.findOne.mockResolvedValue(doc);
    BrandReferenceImage.create.mockResolvedValue({ _id: 'ref1', imageUrl: doc.imageUrl });
    const res = mockRes();
    await controller.promote({ user: { _id: userId, organization: orgId }, params: { id: 'x' }, body: {} }, res);

    expect(BrandReferenceImage.create).toHaveBeenCalledWith(expect.objectContaining({
      organization: orgId, imageUrl: doc.imageUrl, s3Key: doc.s3Key, category: 'product', sortOrder: 0
    }));
    expect(doc.promotedReferenceImage).toBe('ref1');
    expect(doc.promotedAt).toBeInstanceOf(Date);
    expect(doc.expiresAt).toBeNull(); // stops the cleanup job from ever deleting this now-shared object
    expect(doc.save).toHaveBeenCalled();
    expect(refImageController.analyzeImageAsync).toHaveBeenCalledWith('ref1', doc.imageUrl);
    expect(BrandConfig.updateOne).toHaveBeenCalledWith({ organization: orgId }, { $unset: { styleCache: 1 } });
    expect(res.statusCode).toBe(201);
  });

  test('rejects an invalid category, falling back to "product"', async () => {
    GenerationInputImage.findOne.mockResolvedValue(baseDoc());
    BrandReferenceImage.create.mockResolvedValue({ _id: 'ref1', imageUrl: 'x' });
    const res = mockRes();
    await controller.promote({
      user: { _id: userId, organization: orgId }, params: { id: 'x' }, body: { category: 'not-a-real-category' }
    }, res);
    expect(BrandReferenceImage.create).toHaveBeenCalledWith(expect.objectContaining({ category: 'product' }));
  });
});
