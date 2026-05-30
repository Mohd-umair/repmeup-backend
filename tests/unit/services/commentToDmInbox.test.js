'use strict';

jest.mock('../../../src/integrations/meta/instagramService', () => ({
  sendPrivateReplyGenericTemplate: jest.fn(),
  sendPrivateReply: jest.fn(),
  sendGenericTemplateMessage: jest.fn(),
  sendMessage: jest.fn()
}));
jest.mock('../../../src/services/inbox/inboxAutomationReplyService', () => ({
  recordAutomationReply: jest.fn().mockResolvedValue({ recorded: true })
}));

const instagramService = require('../../../src/integrations/meta/instagramService');
const { recordAutomationReply } = require('../../../src/services/inbox/inboxAutomationReplyService');
const { sendProductCtaDm } = require('../../../src/services/commentToDmService');

describe('sendProductCtaDm inbox recording integration', () => {
  const baseArgs = {
    recipientMode: 'comment',
    commentId: 'comment_1',
    instagramUserId: 'user_1',
    commenterUsername: 'jane',
    product: { _id: 'prod1', name: 'Dress', paymentUrl: 'https://pay.example/o' },
    sfSettings: {
      ctaButtons: [{ label: 'Details', type: 'postback', payload: 'details' }]
    },
    orderToken: 'tok_abc',
    accessToken: 'token',
    pageId: 'page_1',
    connType: 'instagram_login'
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns inbox metadata when generic template send succeeds', async () => {
    instagramService.sendPrivateReplyGenericTemplate.mockResolvedValue({
      success: true,
      platformResponseId: 'mid.template'
    });

    const result = await sendProductCtaDm(baseArgs);

    expect(result.success).toBe(true);
    expect(result.platformResponseId).toBe('mid.template');
    expect(result.inboxContent).toContain('Dress');
    expect(result.messageType).toBe('instagram_generic_template');
  });
});

describe('commentToDm persistAutomationReply (via sendSingleProductFlow caller)', () => {
  it('recordAutomationReply is available for callers after send', async () => {
    instagramService.sendPrivateReplyGenericTemplate.mockResolvedValue({
      success: true,
      platformResponseId: 'mid.1'
    });

    await sendProductCtaDm({
      recipientMode: 'comment',
      commentId: 'c1',
      instagramUserId: 'u1',
      product: {
        _id: 'p1',
        name: 'Hat',
        paymentUrl: 'https://pay.example/h',
        dmConfig: { ctaButtons: [{ label: 'Buy', type: 'postback', payload: 'payment' }] }
      },
      sfSettings: {},
      orderToken: 'tok',
      accessToken: 't',
      pageId: 'pg',
      connType: null
    });

    expect(recordAutomationReply).not.toHaveBeenCalled();
  });
});
