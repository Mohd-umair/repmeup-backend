/**
 * Unit tests for Google Business Profile review helpers (My Business API v4).
 */
jest.mock('axios');
jest.mock('../../../src/models/Interaction', () => ({
  findOne: jest.fn(),
  find: jest.fn(() => ({ select: () => ({ lean: async () => [] }) })),
  bulkWrite: jest.fn()
}));
jest.mock('../../../src/utils/chatRefHelper', () => ({
  generateChatRef: jest.fn(async () => ({ chatNumber: 1, chatRef: 'CHT-1' }))
}));

const googleService = require('../../../src/integrations/google/googleService');

describe('googleService GBP review helpers', () => {
  test('mapStarRating maps Google enums to 1–5', () => {
    expect(googleService.mapStarRating('FIVE')).toBe(5);
    expect(googleService.mapStarRating('THREE')).toBe(3);
    expect(googleService.mapStarRating('ONE')).toBe(1);
    expect(googleService.mapStarRating(4)).toBe(4);
    expect(googleService.mapStarRating('STAR_RATING_UNSPECIFIED')).toBeNull();
  });

  test('_buildReviewsParent builds v4 accounts/.../locations/... path', () => {
    expect(googleService._buildReviewsParent('accounts/123', '456')).toBe(
      'accounts/123/locations/456'
    );
    expect(googleService._buildReviewsParent('123', 'locations/456')).toBe(
      'accounts/123/locations/456'
    );
    expect(
      googleService._buildReviewsParent('accounts/123/locations/999', 'locations/456/foo')
    ).toBe('accounts/123/locations/456');
  });

  test('buildLocationPlatformData stores short ids + location metadata', () => {
    const data = googleService.buildLocationPlatformData(
      { name: 'accounts/99', accountName: 'My Biz' },
      [
        { name: 'locations/111', title: 'Store A' },
        { name: 'accounts/99/locations/222', title: 'Store B' }
      ]
    );

    expect(data.accountId).toBe('accounts/99');
    expect(data.locationIds).toEqual(['111', '222']);
    expect(data.locations).toHaveLength(2);
    expect(data.locations[0].title).toBe('Store A');
  });
});
