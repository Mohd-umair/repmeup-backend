'use strict';

jest.mock('../../../src/models/Organization');
jest.mock('../../../src/models/SalesConversationState');
jest.mock('../../../src/models/ProductOrder');
jest.mock('../../../src/models/Product');
jest.mock('../../../src/models/PlatformConnection');
jest.mock('../../../src/integrations/meta/instagramService', () => ({
  sendMessage: jest.fn().mockResolvedValue({ success: true }),
  sendGenericTemplateMessage: jest.fn().mockResolvedValue({ success: true })
}));
jest.mock('../../../src/services/commentToDmService', () => ({
  completeProductSelection: jest.fn().mockResolvedValue({ ok: true })
}));

const SalesConversationState = require('../../../src/models/SalesConversationState');
const commentToDmService = require('../../../src/services/commentToDmService');
const {
  parsePickPayload,
  handleProductPickPostback
} = require('../../../src/services/salesConversationService');

describe('salesConversationService product picker', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('parsePickPayload', () => {
    it('parses valid PICK payload', () => {
      expect(parsePickPayload('PICK:507f1f77bcf86cd799439011:tok_abc')).toEqual({
        productId: '507f1f77bcf86cd799439011',
        selectionToken: 'tok_abc'
      });
    });

    it('returns null for invalid payloads', () => {
      expect(parsePickPayload('SALES:details:tok')).toBeNull();
      expect(parsePickPayload('PICK:onlyone')).toBeNull();
    });
  });

  describe('handleProductPickPostback', () => {
    it('calls completeProductSelection when state exists', async () => {
      SalesConversationState.findOne.mockReturnValue({
        lean: jest.fn().mockResolvedValue({
          postId: 'post123',
          selectionToken: 'tok_abc'
        })
      });

      await handleProductPickPostback({
        instagramUserId: 'user1',
        organizationId: 'org1',
        payload: 'PICK:prod1:tok_abc',
        platformConnectionId: 'conn1'
      });

      expect(commentToDmService.completeProductSelection).toHaveBeenCalledWith({
        organizationId: 'org1',
        instagramUserId: 'user1',
        postId: 'post123',
        productId: 'prod1',
        selectionToken: 'tok_abc',
        platformConnectionId: 'conn1'
      });
    });
  });
});
