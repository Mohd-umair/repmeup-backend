/**
 * Tests for brandContextService.resolveProductShootReferences — the
 * role-aware reference resolver used by the Content Studio "Product Shoot"
 * flow (see plan "Separate product identity from visual style").
 *
 * Isolated from brandContextService.test.js because that file's
 * BrandReferenceImage mock chain is shaped for the pre-existing
 * getReferenceOnlyContext tests (find().sort().limit().lean(), no
 * .findOne()/.select()) — duplicating a second, differently-shaped mock in
 * the same file risks breaking those 29 tests.
 */

jest.mock('../../../../src/models/BrandReferenceImage', () => ({
  findOne: jest.fn(),
  find: jest.fn()
}));

jest.mock('../../../../src/models/GenerationInputImage', () => ({
  findOne: jest.fn()
}));

const BrandReferenceImage = require('../../../../src/models/BrandReferenceImage');
const GenerationInputImage = require('../../../../src/models/GenerationInputImage');
const { resolveProductShootReferences } = require('../../../../src/services/ai/brandContextService');

const orgId = 'org_1';
const userId = 'user_1';

function leanReturn(value) {
  return { lean: async () => value };
}

beforeEach(() => {
  BrandReferenceImage.findOne.mockReset();
  BrandReferenceImage.find.mockReset();
  GenerationInputImage.findOne.mockReset();
});

describe('resolveProductShootReferences', () => {
  test('returns nulls/empty when nothing requested', async () => {
    const out = await resolveProductShootReferences(orgId, userId, {});
    expect(out).toEqual({ productImageUrl: null, styleImageUrls: [] });
    expect(BrandReferenceImage.findOne).not.toHaveBeenCalled();
    expect(GenerationInputImage.findOne).not.toHaveBeenCalled();
  });

  test('rejects when both productReferenceImageId and inputImageId are given', async () => {
    await expect(resolveProductShootReferences(orgId, userId, {
      productReferenceImageId: 'ref1', inputImageId: 'up1'
    })).rejects.toMatchObject({ code: 'REFERENCE_NOT_FOUND' });
  });

  test('resolves productReferenceImageId scoped to the organization', async () => {
    BrandReferenceImage.findOne.mockReturnValue(leanReturn({ _id: 'ref1', imageUrl: 'https://cdn/ref1.png' }));
    const out = await resolveProductShootReferences(orgId, userId, { productReferenceImageId: 'ref1' });
    expect(BrandReferenceImage.findOne).toHaveBeenCalledWith({ _id: 'ref1', organization: orgId });
    expect(out.productImageUrl).toBe('https://cdn/ref1.png');
  });

  test('throws REFERENCE_NOT_FOUND when productReferenceImageId does not belong to the org', async () => {
    BrandReferenceImage.findOne.mockReturnValue(leanReturn(null));
    await expect(resolveProductShootReferences(orgId, userId, { productReferenceImageId: 'other-org-ref' }))
      .rejects.toMatchObject({ code: 'REFERENCE_NOT_FOUND' });
  });

  test('resolves inputImageId scoped to organization AND uploading user', async () => {
    GenerationInputImage.findOne.mockReturnValue(leanReturn({
      _id: 'up1', imageUrl: 'https://cdn/up1.png', expiresAt: new Date(Date.now() + 60000)
    }));
    const out = await resolveProductShootReferences(orgId, userId, { inputImageId: 'up1' });
    expect(GenerationInputImage.findOne).toHaveBeenCalledWith({ _id: 'up1', organization: orgId, user: userId });
    expect(out.productImageUrl).toBe('https://cdn/up1.png');
  });

  test('throws REFERENCE_NOT_FOUND for an inputImageId belonging to another user/org', async () => {
    GenerationInputImage.findOne.mockReturnValue(leanReturn(null));
    await expect(resolveProductShootReferences(orgId, userId, { inputImageId: 'not-mine' }))
      .rejects.toMatchObject({ code: 'REFERENCE_NOT_FOUND' });
  });

  test('throws REFERENCE_NOT_FOUND for an expired ephemeral upload', async () => {
    GenerationInputImage.findOne.mockReturnValue(leanReturn({
      _id: 'up1', imageUrl: 'https://cdn/up1.png', expiresAt: new Date(Date.now() - 60000)
    }));
    await expect(resolveProductShootReferences(orgId, userId, { inputImageId: 'up1' }))
      .rejects.toMatchObject({ code: 'REFERENCE_NOT_FOUND' });
  });

  test('resolves up to 3 style reference ids, preserving caller-specified order', async () => {
    BrandReferenceImage.find.mockReturnValue({
      select: () => leanReturn([
        { _id: 's2', imageUrl: 'https://cdn/s2.png' },
        { _id: 's1', imageUrl: 'https://cdn/s1.png' }
      ])
    });
    const out = await resolveProductShootReferences(orgId, userId, { styleReferenceImageIds: ['s1', 's2'] });
    expect(BrandReferenceImage.find).toHaveBeenCalledWith({ _id: { $in: ['s1', 's2'] }, organization: orgId });
    expect(out.styleImageUrls).toEqual(['https://cdn/s1.png', 'https://cdn/s2.png']); // order = caller's, not Mongo's
  });

  test('caps style reference ids at 3 even if more are supplied', async () => {
    BrandReferenceImage.find.mockReturnValue({
      select: () => leanReturn([
        { _id: 's1', imageUrl: 'https://cdn/s1.png' },
        { _id: 's2', imageUrl: 'https://cdn/s2.png' },
        { _id: 's3', imageUrl: 'https://cdn/s3.png' }
      ])
    });
    await resolveProductShootReferences(orgId, userId, { styleReferenceImageIds: ['s1', 's2', 's3', 's4'] });
    expect(BrandReferenceImage.find).toHaveBeenCalledWith({ _id: { $in: ['s1', 's2', 's3'] }, organization: orgId });
  });

  test('throws REFERENCE_NOT_FOUND when one style id does not belong to the org', async () => {
    BrandReferenceImage.find.mockReturnValue({
      select: () => leanReturn([{ _id: 's1', imageUrl: 'https://cdn/s1.png' }]) // 's2' missing
    });
    await expect(resolveProductShootReferences(orgId, userId, { styleReferenceImageIds: ['s1', 's2'] }))
      .rejects.toMatchObject({ code: 'REFERENCE_NOT_FOUND' });
  });

  test('resolves product + styles together', async () => {
    BrandReferenceImage.findOne.mockReturnValue(leanReturn({ _id: 'ref1', imageUrl: 'https://cdn/ref1.png' }));
    BrandReferenceImage.find.mockReturnValue({
      select: () => leanReturn([{ _id: 's1', imageUrl: 'https://cdn/s1.png' }])
    });
    const out = await resolveProductShootReferences(orgId, userId, {
      productReferenceImageId: 'ref1', styleReferenceImageIds: ['s1']
    });
    expect(out).toEqual({ productImageUrl: 'https://cdn/ref1.png', styleImageUrls: ['https://cdn/s1.png'] });
  });
});
