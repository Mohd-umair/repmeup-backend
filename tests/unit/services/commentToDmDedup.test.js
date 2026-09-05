'use strict';

jest.mock('../../../src/models/ProductOrder', () => ({
  exists: jest.fn()
}));

jest.mock('../../../src/models/SalesConversationState', () => ({
  exists: jest.fn(),
  create: jest.fn()
}));

const ProductOrder = require('../../../src/models/ProductOrder');
const SalesConversationState = require('../../../src/models/SalesConversationState');
const { shouldSkipDedup, NON_DEDUP_ORDER_STATUSES } = require('../../../src/services/commentToDmService');

describe('commentToDmService dedup', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('NON_DEDUP_ORDER_STATUSES excludes picker_pending and cancelled', () => {
    expect(NON_DEDUP_ORDER_STATUSES).toEqual(['picker_pending', 'cancelled']);
  });

  it('shouldSkipDedup ignores picker_pending ProductOrders', async () => {
    ProductOrder.exists.mockResolvedValue(null);
    SalesConversationState.exists.mockResolvedValue(null);

    const skip = await shouldSkipDedup('org1', 'user1', 'post1');

    expect(skip).toBe(false);
    expect(ProductOrder.exists).toHaveBeenCalledWith({
      organization: 'org1',
      instagramUserId: 'user1',
      instagramPostId: 'post1',
      status: { $nin: NON_DEDUP_ORDER_STATUSES }
    });
  });

  it('shouldSkipDedup returns true when a non-pending ProductOrder exists', async () => {
    ProductOrder.exists.mockResolvedValue({ _id: 'order1' });

    const skip = await shouldSkipDedup('org1', 'user1', 'post1');

    expect(skip).toBe(true);
    expect(SalesConversationState.exists).not.toHaveBeenCalled();
  });

  it('shouldSkipDedup returns true when active sales state exists', async () => {
    ProductOrder.exists.mockResolvedValue(null);
    SalesConversationState.exists.mockResolvedValue({ _id: 'state1' });

    const skip = await shouldSkipDedup('org1', 'user1', 'post1');

    expect(skip).toBe(true);
  });
});
