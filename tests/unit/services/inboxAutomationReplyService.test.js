'use strict';

jest.mock('../../../src/models/Interaction');
jest.mock('../../../src/services/cacheService', () => ({
  invalidateInteractionCaches: jest.fn().mockResolvedValue(undefined)
}));
jest.mock('../../../src/utils/socketEmitter', () => ({
  emitToOrg: jest.fn()
}));

const Interaction = require('../../../src/models/Interaction');
const cacheService = require('../../../src/services/cacheService');
const { emitToOrg } = require('../../../src/utils/socketEmitter');
const { recordAutomationReply } = require('../../../src/services/inbox/inboxAutomationReplyService');

describe('inboxAutomationReplyService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('skips when content and attachment are empty', async () => {
    const result = await recordAutomationReply({
      interactionId: 'int1',
      organizationId: 'org1',
      content: '   '
    });
    expect(result).toEqual({ recorded: false, reason: 'empty_content' });
    expect(Interaction.findOne).not.toHaveBeenCalled();
  });

  it('records reply via addReply and invalidates cache', async () => {
    const addReply = jest.fn().mockResolvedValue(undefined);
    const interaction = {
      _id: 'int1',
      replies: [],
      addReply,
      toObject: () => ({ _id: 'int1', replies: [{ content: 'Hello DM' }] })
    };
    Interaction.findOne.mockResolvedValue(interaction);

    const result = await recordAutomationReply({
      interactionId: 'int1',
      organizationId: 'org1',
      content: 'Hello DM',
      platformResponseId: 'mid.123',
      messageType: 'instagram_private_dm'
    });

    expect(result.recorded).toBe(true);
    expect(addReply).toHaveBeenCalledWith(
      'Hello DM',
      null,
      'mid.123',
      true,
      null,
      null,
      null,
      'instagram_private_dm'
    );
    expect(cacheService.invalidateInteractionCaches).toHaveBeenCalledWith('org1');
    expect(emitToOrg).toHaveBeenCalledWith('org1', 'interaction_updated', expect.any(Object));
  });

  it('de-dupes by platformResponseId', async () => {
    Interaction.findOne.mockResolvedValue({
      _id: 'int1',
      replies: [{ platformResponseId: 'mid.123' }],
      addReply: jest.fn()
    });

    const result = await recordAutomationReply({
      interactionId: 'int1',
      organizationId: 'org1',
      content: 'Duplicate',
      platformResponseId: 'mid.123'
    });

    expect(result).toEqual({ recorded: false, reason: 'duplicate' });
  });
});
