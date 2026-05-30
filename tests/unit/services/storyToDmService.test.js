'use strict';

jest.mock('../../../src/models/Organization');
jest.mock('../../../src/models/Product');
jest.mock('../../../src/models/ProductOrder');
jest.mock('../../../src/models/SalesConversationState');
jest.mock('../../../src/models/StoryEngagementLog');
jest.mock('../../../src/models/PlatformConnection');
jest.mock('../../../src/integrations/meta/instagramService', () => ({
  sendMessage: jest.fn().mockResolvedValue({ success: true, platformResponseId: 'mid.msg' }),
  sendGenericTemplateMessage: jest.fn().mockResolvedValue({ success: true, platformResponseId: 'mid.tpl' })
}));
jest.mock('../../../src/services/commentToDmService', () => ({
  sendProductCtaDm: jest.fn().mockResolvedValue({
    success: true,
    platformResponseId: 'mid.cta',
    inboxContent: 'Red Dress',
    messageType: 'instagram_generic_template'
  }),
  createPickerPendingOrders: jest.fn().mockResolvedValue({}),
  cancelSiblingPickerPendingOrders: jest.fn().mockResolvedValue(undefined)
}));
jest.mock('../../../src/services/inbox/inboxAutomationReplyService', () => ({
  recordAutomationReply: jest.fn().mockResolvedValue({ recorded: true })
}));

const Organization = require('../../../src/models/Organization');
const Product = require('../../../src/models/Product');
const ProductOrder = require('../../../src/models/ProductOrder');
const SalesConversationState = require('../../../src/models/SalesConversationState');
const StoryEngagementLog = require('../../../src/models/StoryEngagementLog');
const PlatformConnection = require('../../../src/models/PlatformConnection');
const instagramService = require('../../../src/integrations/meta/instagramService');
const { sendProductCtaDm } = require('../../../src/services/commentToDmService');
const { recordAutomationReply } = require('../../../src/services/inbox/inboxAutomationReplyService');
const { processStoryEngagement } = require('../../../src/services/storyToDmService');

const orgId = '507f1f77bcf86cd799439011';
const productId = '607f1f77bcf86cd799439022';
const storyMediaId = '17912345678901234';
const userId = '1788000111222333';

function baseInteraction(overrides = {}) {
  return {
    _id: 'int1',
    platform: 'instagram',
    type: 'dm',
    author: { platformId: userId, username: 'buyer1' },
    content: 'price?',
    metadata: {
      isStoryEngagement: true,
      storyMediaId,
      storyTriggerType: 'story_reply',
      storyReplyText: 'price?'
    },
    ...overrides
  };
}

function mockOrg(overrides = {}) {
  const doc = {
    storyToDmSettings: {
      enabled: true,
      triggerOnReply: true,
      triggerOnMention: true,
      triggerKeywords: [],
      deduplicateDms: true,
      maxDmsPerDay: 200,
      dmsSentToday: 0,
      dmsSentResetDate: new Date(),
      welcomeTitle: '',
      welcomeSubtitle: ''
    },
    salesFlowSettings: { enabled: true },
    save: jest.fn().mockResolvedValue(true),
    ...overrides
  };
  Organization.findById.mockImplementation(() => ({
    select: jest.fn().mockReturnValue({
      lean: jest.fn().mockResolvedValue({
        storyToDmSettings: doc.storyToDmSettings,
        salesFlowSettings: doc.salesFlowSettings
      })
    })
  }));
  Organization.findById.mockImplementationOnce(() => ({
    select: jest.fn().mockResolvedValue(doc)
  }));
  return doc;
}

describe('storyToDmService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    StoryEngagementLog.exists.mockResolvedValue(null);
    StoryEngagementLog.create.mockResolvedValue({});
    ProductOrder.exists.mockResolvedValue(null);
    SalesConversationState.exists.mockResolvedValue(null);
    SalesConversationState.findOneAndUpdate.mockResolvedValue({});
    ProductOrder.create.mockResolvedValue({ _id: 'order1' });
    PlatformConnection.findOne.mockReturnValue({
      sort: jest.fn().mockReturnValue({
        select: jest.fn().mockReturnValue({
          lean: jest.fn().mockResolvedValue({
            accessToken: 'token',
            platformUserId: 'igbiz',
            metadata: { connectionType: 'instagram_login' }
          })
        })
      })
    });
  });

  it('skips when automation disabled', async () => {
    Organization.findById.mockReturnValue({
      select: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue({ storyToDmSettings: { enabled: false } })
      })
    });
    const result = await processStoryEngagement(baseInteraction(), orgId);
    expect(result).toEqual({ sent: false, reason: 'disabled' });
  });

  it('skips story reply when keyword filter does not match', async () => {
    Organization.findById.mockReturnValue({
      select: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue({
          storyToDmSettings: {
            enabled: true,
            triggerOnReply: true,
            triggerKeywords: ['buy']
          }
        })
      })
    });
    const result = await processStoryEngagement(
      baseInteraction({ metadata: { ...baseInteraction().metadata, storyReplyText: 'hello' } }),
      orgId
    );
    expect(result).toEqual({ sent: false, reason: 'no_keyword' });
  });

  it('sends single-product CTA on story reply', async () => {
    const orgDoc = mockOrg();
    Organization.findById.mockReset();
    Organization.findById
      .mockReturnValueOnce({
        select: jest.fn().mockReturnValue({
          lean: jest.fn().mockResolvedValue({
            storyToDmSettings: orgDoc.storyToDmSettings,
            salesFlowSettings: orgDoc.salesFlowSettings
          })
        })
      })
      .mockReturnValueOnce({
        select: jest.fn().mockResolvedValue(orgDoc)
      });

    Product.find.mockReturnValue({
      lean: jest.fn().mockResolvedValue([{
        _id: productId,
        name: 'Red Dress',
        price: 99,
        currency: 'AED',
        dmConfig: {}
      }])
    });

    const result = await processStoryEngagement(baseInteraction(), orgId);

    expect(result).toEqual({ sent: true });
    expect(sendProductCtaDm).toHaveBeenCalledWith(
      expect.objectContaining({
        recipientMode: 'user',
        instagramUserId: userId
      })
    );
    expect(recordAutomationReply).toHaveBeenCalledWith(
      expect.objectContaining({
        interactionId: 'int1',
        organizationId: orgId,
        content: 'Red Dress'
      })
    );
    expect(ProductOrder.create).toHaveBeenCalled();
    expect(orgDoc.save).toHaveBeenCalled();
  });

  it('sends product picker when multiple products linked', async () => {
    const orgDoc = mockOrg();
    Organization.findById.mockReset();
    Organization.findById
      .mockReturnValueOnce({
        select: jest.fn().mockReturnValue({
          lean: jest.fn().mockResolvedValue({
            storyToDmSettings: orgDoc.storyToDmSettings,
            salesFlowSettings: orgDoc.salesFlowSettings
          })
        })
      })
      .mockReturnValueOnce({
        select: jest.fn().mockResolvedValue(orgDoc)
      });

    Product.find.mockReturnValue({
      lean: jest.fn().mockResolvedValue([
        { _id: 'p1', name: 'Item A', price: 10, currency: 'AED', dmConfig: {} },
        { _id: 'p2', name: 'Item B', price: 20, currency: 'AED', dmConfig: {} }
      ])
    });

    const result = await processStoryEngagement(baseInteraction(), orgId);

    expect(result).toEqual({ sent: true });
    expect(instagramService.sendGenericTemplateMessage).toHaveBeenCalled();
    expect(recordAutomationReply).toHaveBeenCalled();
    expect(SalesConversationState.findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ postId: storyMediaId }),
      expect.objectContaining({ $set: expect.objectContaining({ stage: 'awaiting_product_selection' }) }),
      expect.any(Object)
    );
  });

  it('allows story mention without keyword match', async () => {
    const orgDoc = mockOrg();
    Organization.findById.mockReset();
    Organization.findById
      .mockReturnValueOnce({
        select: jest.fn().mockReturnValue({
          lean: jest.fn().mockResolvedValue({
            storyToDmSettings: {
              ...orgDoc.storyToDmSettings,
              triggerKeywords: ['buy']
            },
            salesFlowSettings: orgDoc.salesFlowSettings
          })
        })
      })
      .mockReturnValueOnce({
        select: jest.fn().mockResolvedValue(orgDoc)
      });

    Product.find.mockReturnValue({
      lean: jest.fn().mockResolvedValue([{
        _id: productId,
        name: 'Mention Product',
        price: 50,
        currency: 'AED',
        dmConfig: {}
      }])
    });

    const interaction = baseInteraction({
      metadata: {
        isStoryEngagement: true,
        storyMediaId,
        storyTriggerType: 'story_mention',
        storyReplyText: ''
      }
    });

    const result = await processStoryEngagement(interaction, orgId);
    expect(result).toEqual({ sent: true });
  });

  it('deduplicates via StoryEngagementLog', async () => {
    Organization.findById.mockReturnValue({
      select: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue({
          storyToDmSettings: {
            enabled: true,
            triggerOnReply: true,
            triggerKeywords: [],
            deduplicateDms: true
          }
        })
      })
    });
    StoryEngagementLog.exists.mockResolvedValue({ _id: 'log1' });

    const result = await processStoryEngagement(baseInteraction(), orgId);
    expect(result).toEqual({ sent: false, reason: 'dedup' });
  });
});
