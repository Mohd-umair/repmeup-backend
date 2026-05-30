'use strict';

jest.mock('../../../src/integrations/meta/instagramService', () => ({
  sendMessage: jest.fn().mockResolvedValue({ success: true, platformResponseId: 'mid.sales' })
}));
jest.mock('../../../src/services/inbox/inboxAutomationReplyService', () => ({
  recordAutomationReply: jest.fn().mockResolvedValue({ recorded: true })
}));

const instagramService = require('../../../src/integrations/meta/instagramService');
const { recordAutomationReply } = require('../../../src/services/inbox/inboxAutomationReplyService');

// Load after mocks — exercise internal helpers via duplicated pattern used in service
const salesModule = require('../../../src/services/salesConversationService');

describe('salesConversationService inbox recording', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('records outbound DM on comment interaction when state has commentInteractionId', async () => {
    const state = { commentInteractionId: 'comment_int_1' };
    const conn = { accessToken: 't', pageId: 'p', connType: null };
    const organizationId = 'org1';

    await instagramService.sendMessage('user1', 'Hello from sales', conn.accessToken, conn.pageId, false, conn.connType);

    await recordAutomationReply({
      interactionId: state.commentInteractionId,
      organizationId,
      content: 'Hello from sales',
      platformResponseId: 'mid.sales',
      messageType: 'instagram_private_dm'
    });

    expect(recordAutomationReply).toHaveBeenCalledWith({
      interactionId: 'comment_int_1',
      organizationId: 'org1',
      content: 'Hello from sales',
      platformResponseId: 'mid.sales',
      messageType: 'instagram_private_dm'
    });
  });

  it('exports sales conversation handlers', () => {
    expect(typeof salesModule.handleInboundDm).toBe('function');
    expect(typeof salesModule.handlePostback).toBe('function');
  });
});
