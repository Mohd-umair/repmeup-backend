/**
 * Tests for processContentStudioInputCleanup — purges expired Content
 * Studio ephemeral uploads AND their storage objects (S3/local), since
 * Mongo's TTL index only ever removes the document, never the file.
 */

jest.mock('../../../src/config/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn()
}));

jest.mock('../../../src/models/GenerationInputImage', () => ({
  find: jest.fn(),
  deleteOne: jest.fn()
}));

jest.mock('../../../src/services/storageService', () => ({
  deleteObjectByKey: jest.fn().mockResolvedValue(undefined)
}));

jest.mock('fs', () => ({
  ...jest.requireActual('fs'),
  promises: { unlink: jest.fn().mockResolvedValue(undefined) }
}));

const GenerationInputImage = require('../../../src/models/GenerationInputImage');
const storageService = require('../../../src/services/storageService');
const fs = require('fs');
const processContentStudioInputCleanup = require('../../../src/jobs/processContentStudioInputCleanup');

function findChain(results) {
  // results: array of batches; each call to find() returns the next batch
  let call = 0;
  return jest.fn(() => ({
    select: () => ({
      limit: () => ({
        lean: async () => results[Math.min(call++, results.length - 1)]
      })
    })
  }));
}

beforeEach(() => {
  GenerationInputImage.find.mockReset();
  GenerationInputImage.deleteOne.mockReset().mockResolvedValue({});
  storageService.deleteObjectByKey.mockReset().mockResolvedValue(undefined);
  fs.promises.unlink.mockReset().mockResolvedValue(undefined);
});

describe('processContentStudioInputCleanup', () => {
  test('no expired records → no-op, returns zero counts', async () => {
    GenerationInputImage.find.mockImplementation(findChain([[]]));
    const result = await processContentStudioInputCleanup();
    expect(result).toEqual({ purged: 0, failed: 0 });
    expect(storageService.deleteObjectByKey).not.toHaveBeenCalled();
  });

  test('deletes the S3 object then the DB record for an s3-backed upload', async () => {
    GenerationInputImage.find.mockImplementation(findChain([
      [{ _id: 'a', s3Key: 'content-studio/inputs/org1/x.jpg', storageType: 's3', imageUrl: 'https://cdn/x.jpg' }],
      []
    ]));
    const result = await processContentStudioInputCleanup();
    expect(storageService.deleteObjectByKey).toHaveBeenCalledWith('content-studio/inputs/org1/x.jpg');
    expect(GenerationInputImage.deleteOne).toHaveBeenCalledWith({ _id: 'a' });
    expect(result.purged).toBe(1);
  });

  test('deletes the local file then the DB record for a local-backed upload', async () => {
    GenerationInputImage.find.mockImplementation(findChain([
      [{ _id: 'b', s3Key: null, storageType: 'local', imageUrl: 'http://x/uploads/content-studio-inputs/y.jpg' }],
      []
    ]));
    const result = await processContentStudioInputCleanup();
    expect(fs.promises.unlink).toHaveBeenCalled();
    expect(GenerationInputImage.deleteOne).toHaveBeenCalledWith({ _id: 'b' });
    expect(result.purged).toBe(1);
  });

  test('a storage-delete failure on one record does not stop the sweep, and is retried next run (doc not deleted)', async () => {
    storageService.deleteObjectByKey.mockRejectedValueOnce(new Error('s3 down'));
    GenerationInputImage.find.mockImplementation(findChain([
      [
        { _id: 'fail1', s3Key: 'k1', storageType: 's3', imageUrl: 'https://cdn/1.jpg' },
        { _id: 'ok1', s3Key: 'k2', storageType: 's3', imageUrl: 'https://cdn/2.jpg' }
      ],
      []
    ]));
    const result = await processContentStudioInputCleanup();
    expect(result).toEqual({ purged: 1, failed: 1 });
    // the failed one's document must NOT be deleted, so it is retried on the next sweep
    expect(GenerationInputImage.deleteOne).toHaveBeenCalledTimes(1);
    expect(GenerationInputImage.deleteOne).toHaveBeenCalledWith({ _id: 'ok1' });
  });

  test('paginates in batches of 100 until an under-sized batch is returned', async () => {
    const fullBatch = Array.from({ length: 100 }, (_, i) => ({ _id: `x${i}`, s3Key: `k${i}`, storageType: 's3', imageUrl: 'u' }));
    const partialBatch = [{ _id: 'last', s3Key: 'kl', storageType: 's3', imageUrl: 'u' }];
    GenerationInputImage.find.mockImplementation(findChain([fullBatch, partialBatch, []]));
    const result = await processContentStudioInputCleanup();
    expect(result.purged).toBe(101);
    expect(GenerationInputImage.find).toHaveBeenCalledTimes(2);
  });

  test('only queries records with a non-null expiresAt in the past (promoted uploads are excluded)', async () => {
    GenerationInputImage.find.mockImplementation(findChain([[]]));
    await processContentStudioInputCleanup();
    const queryArg = GenerationInputImage.find.mock.calls[0][0];
    expect(queryArg.expiresAt.$ne).toBeNull();
    expect(queryArg.expiresAt.$lte).toBeInstanceOf(Date);
  });
});
