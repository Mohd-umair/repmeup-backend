const {
  entryHasProcessableEvents,
  findInstagramConnection
} = require('../../../src/services/webhook/instagramWebhookIngress');
const PlatformConnection = require('../../../src/models/PlatformConnection');

jest.mock('../../../src/models/PlatformConnection');

describe('instagramWebhookIngress', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('entryHasProcessableEvents', () => {
    it('returns true for messaging events', () => {
      expect(entryHasProcessableEvents({ messaging: [{ sender: { id: '1' } }] })).toBe(true);
    });

    it('returns false for empty entry', () => {
      expect(entryHasProcessableEvents({})).toBe(false);
    });
  });

  describe('findInstagramConnection', () => {
    it('matches by platformUserId for Instagram Login (IGAA)', async () => {
      const conn = { platformUserId: '178414', accessToken: 'IGAAxxx' };
      PlatformConnection.findOne.mockReturnValueOnce({
        select: () => ({ lean: () => Promise.resolve(conn) })
      });

      const result = await findInstagramConnection('178414');
      expect(result).toBe(conn);
      expect(PlatformConnection.findOne).toHaveBeenCalledWith(
        expect.objectContaining({
          platform: 'instagram',
          platformUserId: { $in: ['178414', '178414'] },
          isActive: true
        })
      );
    });

    it('falls back to legacy page/business id lookup', async () => {
      PlatformConnection.findOne
        .mockReturnValueOnce({ select: () => ({ lean: () => Promise.resolve(null) }) })
        .mockReturnValueOnce({ select: () => ({ lean: () => Promise.resolve({ platformUserId: '99' }) }) });

      const result = await findInstagramConnection('99');
      expect(result).toEqual({ platformUserId: '99' });
      expect(PlatformConnection.findOne).toHaveBeenCalledTimes(2);
    });
  });
});
