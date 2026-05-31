'use strict';

jest.mock('../../../../src/models/PlatformConnection', () => ({
  find: jest.fn()
}));

const PlatformConnection = require('../../../../src/models/PlatformConnection');
const {
  INBOX_ACTIVE_CONNECTION_STATUSES,
  fetchInboxActiveConnections
} = require('../../../../src/services/inbox/inboxConnectionScope');

describe('inboxConnectionScope', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('INBOX_ACTIVE_CONNECTION_STATUSES includes available (webhook/sync parity)', () => {
    expect(INBOX_ACTIVE_CONNECTION_STATUSES).toEqual(
      expect.arrayContaining(['connected', 'available'])
    );
  });

  test('fetchInboxActiveConnections queries isActive connections with inbox statuses', async () => {
    const lean = jest.fn().mockResolvedValue([{ _id: 'c1', platform: 'instagram' }]);
    const select = jest.fn().mockReturnValue({ lean });
    PlatformConnection.find.mockReturnValue({ select });

    const orgId = 'org123';
    const rows = await fetchInboxActiveConnections(orgId);

    expect(PlatformConnection.find).toHaveBeenCalledWith({
      organization: orgId,
      isActive: true,
      status: { $in: INBOX_ACTIVE_CONNECTION_STATUSES }
    });
    expect(rows).toHaveLength(1);
  });
});
