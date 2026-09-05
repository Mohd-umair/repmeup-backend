/**
 * Tests for the new orchestration primitives in whatsappWebhookService:
 *   - processWhatsAppWebhook (top-level dispatcher)
 *   - processIncomingMessage (full per-message pipeline)
 *   - processStatusUpdate  (delivery status updates)
 *
 * upsertWhatsAppThread and handleWhatsAppMessage were already refactored
 * earlier; they're covered implicitly through processIncomingMessage here.
 */

// Build a fully chainable find-style mock that supports .select().lean()
// and .populate().
function chainable(finalValue) {
  const chain = {
    select: jest.fn(() => chain),
    lean: jest.fn(() => Promise.resolve(finalValue)),
    populate: jest.fn(() => chain),
    then: (resolve, reject) => Promise.resolve(finalValue).then(resolve, reject)
  };
  return chain;
}

jest.mock('../../../../src/models/Interaction', () => ({
  findOne: jest.fn(),
  findOneAndUpdate: jest.fn().mockResolvedValue(undefined),
  findByIdAndUpdate: jest.fn().mockResolvedValue(undefined),
  findById: jest.fn().mockResolvedValue(null),
  updateOne: jest.fn().mockResolvedValue({ modifiedCount: 1 }),
  find: jest.fn()
}));

jest.mock('../../../../src/models/PlatformConnection', () => ({
  findOne: jest.fn(),
  find: jest.fn(),
  findById: jest.fn()
}));

jest.mock('../../../../src/utils/chatRefHelper', () => ({
  generateChatRef: jest.fn().mockResolvedValue({ chatNumber: 1, chatRef: 'chat-1' })
}));

jest.mock('../../../../src/utils/socketEmitter', () => ({
  emitToOrg: jest.fn()
}));

jest.mock('../../../../src/config/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn()
}));

jest.mock('../../../../src/utils/correlationContext', () => ({
  buildCorrelationCtx: jest.fn(() => ({ _ts: Date.now() })),
  hashId: jest.fn((id) => String(id || 'unknown').slice(0, 12))
}));

// These are lazy-required INSIDE processIncomingMessage so they can be
// stubbed with jest.mock at module scope.
jest.mock('../../../../src/integrations/whatsapp/whatsappService', () => ({
  processWebhookMessage: jest.fn(),
  markAsRead: jest.fn()
}));

jest.mock('../../../../src/services/aiService', () => ({
  fallbackSentimentAnalysis: jest.fn(() => ({
    sentiment: 'neutral',
    sentimentScore: 0,
    sentimentConfidence: 0.6,
    sentimentReasoning: 'keyword'
  }))
}));

jest.mock('../../../../src/services/autoReplyScheduler', () => ({
  queueImmediateAutoReply: jest.fn().mockResolvedValue(true)
}));

jest.mock('../../../../src/config/queue', () => ({
  aiQueue: { add: jest.fn().mockResolvedValue({ id: 'job-1' }) }
}));

jest.mock('../../../../src/services/contactService', () => ({
  resolveContact: jest.fn().mockResolvedValue({ _id: 'contact-1' }),
  normalizeAuthorForPlatform: jest.fn((platform, author, rawData) => ({
    platform,
    platformUserId: author.platformId,
    phone: author.platformId,
    username: author.username,
    name: author.name,
    rawData
  }))
}));

jest.mock('../../../../src/services/campaignService', () => ({
  markRecipientReplied: jest.fn().mockResolvedValue(undefined),
  applyRecipientDeliveryStatus: jest.fn().mockResolvedValue(undefined)
}));

jest.mock('../../../../src/models/WhatsAppAiState', () => ({
  resetSession: jest.fn().mockResolvedValue(undefined),
  setPendingAction: jest.fn().mockResolvedValue({}),
  clearPendingAction: jest.fn().mockResolvedValue(undefined),
  findOne: jest.fn().mockResolvedValue(null),
  deleteOne: jest.fn().mockResolvedValue({ deletedCount: 1 }),
  findOneAndUpdate: jest.fn().mockResolvedValue({})
}));

const Interaction = require('../../../../src/models/Interaction');
const PlatformConnection = require('../../../../src/models/PlatformConnection');
const { emitToOrg } = require('../../../../src/utils/socketEmitter');
const whatsappService = require('../../../../src/integrations/whatsapp/whatsappService');
const aiService = require('../../../../src/services/aiService');
const autoReplyScheduler = require('../../../../src/services/autoReplyScheduler');
const { aiQueue } = require('../../../../src/config/queue');
const contactService = require('../../../../src/services/contactService');

const svc = require('../../../../src/services/webhook/whatsappWebhookService');

beforeEach(() => {
  Interaction.findOne.mockReset();
  Interaction.findOneAndUpdate.mockReset().mockResolvedValue(undefined);
  Interaction.updateOne.mockReset().mockResolvedValue({ modifiedCount: 1 });
  Interaction.findByIdAndUpdate.mockReset().mockResolvedValue(undefined);
  Interaction.findById.mockReset().mockResolvedValue(null);
  Interaction.find.mockReset();

  PlatformConnection.findOne.mockReset();
  PlatformConnection.find.mockReset().mockReturnValue(chainable([]));
  PlatformConnection.findById.mockReset().mockImplementation(() => chainable(null));

  emitToOrg.mockReset();
  whatsappService.processWebhookMessage.mockReset();
  whatsappService.markAsRead.mockReset().mockResolvedValue(undefined);
  aiService.fallbackSentimentAnalysis.mockClear();
  autoReplyScheduler.queueImmediateAutoReply.mockReset().mockResolvedValue(true);
  aiQueue.add.mockReset().mockResolvedValue({ id: 'job-1' });
  contactService.resolveContact.mockReset().mockResolvedValue({ _id: 'contact-1' });
  contactService.normalizeAuthorForPlatform.mockClear();
});

// ────────────────────────────────────────────────────────────────────────────
describe('processWhatsAppWebhook', () => {
  test('returns immediately when payload has no entries', async () => {
    await svc.processWhatsAppWebhook({ entry: [] });
    await svc.processWhatsAppWebhook({});
    expect(PlatformConnection.findOne).not.toHaveBeenCalled();
  });

  test('skips entries without changes and changes whose field !== "messages"', async () => {
    await svc.processWhatsAppWebhook({
      entry: [
        { changes: [] },
        { changes: [{ field: 'account_alerts', value: {} }] }
      ]
    });
    expect(PlatformConnection.findOne).not.toHaveBeenCalled();
  });

  test('message change without phone_number_id is skipped with a warning', async () => {
    await svc.processWhatsAppWebhook({
      entry: [{
        changes: [{
          field: 'messages',
          value: { messages: [{ id: 'wamid.x' }], metadata: {} }
        }]
      }]
    });
    expect(PlatformConnection.findOne).not.toHaveBeenCalled();
  });

  test('message change with unknown phone_number_id does NOT dispatch to processIncomingMessage', async () => {
    PlatformConnection.findOne.mockReturnValueOnce(chainable(null));
    const spy = jest.spyOn(svc, 'processIncomingMessage');

    await svc.processWhatsAppWebhook({
      entry: [{
        changes: [{
          field: 'messages',
          value: {
            messages: [{ id: 'wamid.x' }],
            metadata: { phone_number_id: '111' }
          }
        }]
      }]
    });

    expect(PlatformConnection.findOne).toHaveBeenCalledWith(
      expect.objectContaining({
        platform: 'whatsapp',
        isActive: true,
        $or: [
          { 'platformData.phoneNumberId': '111' },
          { platformUserId: '111' }
        ]
      })
    );
    expect(whatsappService.processWebhookMessage).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  test('message change with a known connection triggers the incoming-message pipeline', async () => {
    const connection = {
      _id: 'c1',
      organization: { _id: 'org-1', toString() { return 'org-1'; } },
      platformData: { phoneNumberId: '111', verifiedName: 'Biz' }
    };
    PlatformConnection.findOne.mockReturnValueOnce(chainable(connection));

    whatsappService.processWebhookMessage.mockResolvedValueOnce({
      success: true,
      skipped: false,
      messageData: {
        from: '919999999999',
        platformId: 'wamid.abc',
        content: 'Hello there',
        type: 'text',
        timestamp: new Date('2026-01-01T00:00:00Z'),
        contact: { name: 'Ravi', wa_id: '919999999999' }
      }
    });
    // prev-author lookup (1), upsert existence-check (2), post-upsert fetch (3)
    Interaction.findOne.mockReturnValueOnce(chainable(null));
    Interaction.findOne.mockReturnValueOnce(chainable(null));
    Interaction.findOne.mockResolvedValueOnce({
      _id: 'int-1',
      content: 'Hello there',
      toObject() { return { _id: 'int-1', content: 'Hello there' }; }
    });

    await svc.processWhatsAppWebhook({
      object: 'whatsapp_business_account',
      entry: [{
        changes: [{
          field: 'messages',
          value: {
            messages: [{ id: 'wamid.abc', from: '919999999999' }],
            metadata: { phone_number_id: '111' }
          }
        }]
      }]
    });

    // Upsert happened
    expect(Interaction.findOneAndUpdate).toHaveBeenCalled();
    // Sentiment set
    expect(aiService.fallbackSentimentAnalysis).toHaveBeenCalledWith('Hello there');
    // Mark as read
    expect(whatsappService.markAsRead).toHaveBeenCalledWith(connection, 'wamid.abc');
    // Socket emit
    expect(emitToOrg).toHaveBeenCalledWith('org-1', 'new_interaction', expect.any(Object));
    // AI queue + auto reply
    expect(aiQueue.add).toHaveBeenCalled();
    expect(autoReplyScheduler.queueImmediateAutoReply).toHaveBeenCalledWith('int-1', 'org-1', expect.objectContaining({ expectedLastMid: 'wamid.abc' }));
  });

  test('status-only change dispatches to processStatusUpdate', async () => {
    Interaction.findOne
      .mockReturnValueOnce(chainable({ replies: [{ platformResponseId: 'wamid.s', deliveryStatus: 'sent' }] }))
      .mockReturnValueOnce(chainable({ _id: 'int-s', organization: 'org-s' }));
    Interaction.findById.mockReturnValueOnce(chainable({ _id: 'int-s', organization: 'org-s', replies: [] }));

    await svc.processWhatsAppWebhook({
      entry: [{
        changes: [{
          field: 'messages',
          value: {
            statuses: [{ id: 'wamid.s', status: 'delivered', timestamp: '1700000000' }]
          }
        }]
      }]
    });

    expect(Interaction.updateOne).toHaveBeenCalledWith(
      { platform: 'whatsapp', 'replies.platformResponseId': 'wamid.s' },
      expect.objectContaining({
        $set: expect.objectContaining({ 'replies.$.deliveryStatus': 'delivered' })
      })
    );
  });

  test('sibling changes continue to process when one throws', async () => {
    // First change: message with unknown connection → swallowed and skipped.
    PlatformConnection.findOne.mockReturnValueOnce(chainable(null));
    Interaction.findOne
      .mockReturnValueOnce(chainable({ replies: [{ platformResponseId: 'wamid.s', deliveryStatus: 'delivered' }] }))
      .mockReturnValueOnce(chainable({ _id: 'int-s2', organization: 'org-s2' }));
    Interaction.findById.mockReturnValueOnce(chainable({ _id: 'int-s2', organization: 'org-s2', replies: [] }));

    await svc.processWhatsAppWebhook({
      entry: [{
        changes: [
          {
            field: 'messages',
            value: {
              messages: [{ id: 'wamid.x' }],
              metadata: { phone_number_id: 'unknown' }
            }
          },
          {
            field: 'messages',
            value: {
              statuses: [{ id: 'wamid.s', status: 'read', timestamp: '1700000000' }]
            }
          }
        ]
      }]
    });

    expect(Interaction.updateOne).toHaveBeenCalledWith(
      { platform: 'whatsapp', 'replies.platformResponseId': 'wamid.s' },
      expect.any(Object)
    );
  });
});

// ────────────────────────────────────────────────────────────────────────────
describe('processIncomingMessage — side-effect isolation', () => {
  const connection = {
    _id: 'c1',
    organization: { _id: 'org-1', toString() { return 'org-1'; } },
    platformData: { phoneNumberId: '111' }
  };
  const change = {
    field: 'messages',
    value: {
      messages: [{ id: 'wamid.abc' }],
      metadata: { phone_number_id: '111' }
    }
  };
  const payload = { entry: [{ changes: [change] }] };

  function primeSuccessPath() {
    whatsappService.processWebhookMessage.mockResolvedValueOnce({
      success: true,
      skipped: false,
      messageData: {
        from: '919999999999',
        platformId: 'wamid.abc',
        content: 'hello',
        type: 'text',
        timestamp: new Date('2026-01-01T00:00:00Z')
      }
    });
    // Call order in processIncomingMessage → upsertWhatsAppThread:
    //   1. findOne for prev-author lookup (chainable .select().lean())
    //   2. findOne for upsert existing-check (chainable .select().lean())
    //   3. findOne for post-upsert fetch (direct Promise)
    Interaction.findOne.mockReturnValueOnce(chainable(null)); // 1
    Interaction.findOne.mockReturnValueOnce(chainable(null)); // 2
    Interaction.findOne.mockResolvedValueOnce({                // 3
      _id: 'int-1',
      content: 'hello',
      toObject() { return { _id: 'int-1' }; }
    });
  }

  test('returns early when parser reports !success or skipped', async () => {
    whatsappService.processWebhookMessage.mockResolvedValueOnce({ success: false });
    await svc.processIncomingMessage(change, connection, payload);
    expect(Interaction.findOneAndUpdate).not.toHaveBeenCalled();

    whatsappService.processWebhookMessage.mockResolvedValueOnce({ success: true, skipped: true });
    await svc.processIncomingMessage(change, connection, payload);
    expect(Interaction.findOneAndUpdate).not.toHaveBeenCalled();
  });

  test('sentiment failure does not abort markAsRead / socket / queue steps', async () => {
    primeSuccessPath();
    aiService.fallbackSentimentAnalysis.mockImplementationOnce(() => { throw new Error('sent broken'); });

    await svc.processIncomingMessage(change, connection, payload);

    expect(whatsappService.markAsRead).toHaveBeenCalled();
    expect(emitToOrg).toHaveBeenCalled();
    expect(aiQueue.add).toHaveBeenCalled();
  });

  test('markAsRead failure does not abort socket / queue steps', async () => {
    primeSuccessPath();
    whatsappService.markAsRead.mockRejectedValueOnce(new Error('meta 429'));

    await svc.processIncomingMessage(change, connection, payload);

    expect(emitToOrg).toHaveBeenCalled();
    expect(aiQueue.add).toHaveBeenCalled();
  });

  test('socket emit failure does not abort queue step', async () => {
    primeSuccessPath();
    emitToOrg.mockImplementationOnce(() => { throw new Error('io down'); });

    await svc.processIncomingMessage(change, connection, payload);

    expect(aiQueue.add).toHaveBeenCalled();
  });

  test('aiQueue failure is swallowed; function still resolves', async () => {
    primeSuccessPath();
    aiQueue.add.mockRejectedValueOnce(new Error('redis dead'));

    await expect(svc.processIncomingMessage(change, connection, payload)).resolves.toBeUndefined();
  });

  test('creates/links Contact for inbound WhatsApp sender', async () => {
    primeSuccessPath();

    await svc.processIncomingMessage(change, connection, payload);

    expect(contactService.normalizeAuthorForPlatform).toHaveBeenCalledWith(
      'whatsapp',
      expect.objectContaining({ platformId: '919999999999' }),
      expect.any(Object)
    );
    expect(contactService.resolveContact).toHaveBeenCalledWith(
      expect.objectContaining({ platform: 'whatsapp', platformUserId: '919999999999' }),
      'org-1'
    );
    expect(Interaction.findByIdAndUpdate).toHaveBeenCalledWith('int-1', { contact: 'contact-1' });
  });

  test('mergedAuthor prefers new values, falls back to previously stored author', async () => {
    whatsappService.processWebhookMessage.mockResolvedValueOnce({
      success: true,
      skipped: false,
      messageData: {
        from: '919999999999',
        platformId: 'wamid.abc',
        content: 'hi',
        type: 'text',
        timestamp: new Date('2026-01-01T00:00:00Z'),
        contact: {} // no new name/wa_id
      }
    });
    // prev-author lookup (has stored author)
    Interaction.findOne.mockReturnValueOnce(chainable({
      author: { platformId: '919999999999', name: 'Previously Stored', username: 'oldun' }
    }));
    // upsert existence-check — return existing thread WITHOUT same lastMid so it proceeds
    Interaction.findOne.mockReturnValueOnce(chainable({
      _id: 'int-existing',
      metadata: { lastMid: 'wamid.other' },
      author: { name: 'Previously Stored' },
      chatRef: 'chat-1'
    }));
    Interaction.findOne.mockResolvedValueOnce({
      _id: 'int-1',
      content: 'hi',
      toObject() { return { _id: 'int-1' }; }
    });

    await svc.processIncomingMessage(change, connection, payload);

    const upsertArgs = Interaction.findOneAndUpdate.mock.calls[0][1];
    expect(upsertArgs.$set.author).toEqual({
      platformId: '919999999999',
      name: 'Previously Stored',
      username: 'oldun'
    });
  });

  test('media message populates metadata.mediaId / mediaType / hasMedia', async () => {
    whatsappService.processWebhookMessage.mockResolvedValueOnce({
      success: true,
      skipped: false,
      messageData: {
        from: '919999999999',
        platformId: 'wamid.img',
        content: '',
        type: 'image',
        mediaType: 'image',
        mediaId: 'media-123',
        timestamp: new Date('2026-01-01T00:00:00Z')
      }
    });
    Interaction.findOne.mockReturnValueOnce(chainable(null)); // prev author
    Interaction.findOne.mockReturnValueOnce(chainable(null)); // upsert check
    Interaction.findOne.mockResolvedValueOnce({
      _id: 'int-1', content: '', toObject() { return { _id: 'int-1' }; }
    });

    await svc.processIncomingMessage(change, connection, payload);

    const upsertArgs = Interaction.findOneAndUpdate.mock.calls[0][1];
    expect(upsertArgs.$set).toMatchObject({
      'metadata.mediaId': 'media-123',
      'metadata.mediaType': 'image',
      'metadata.hasMedia': true,
      contentType: 'image'
    });
  });

  test('duplicate mid (skipped=true from upsert) short-circuits before side effects', async () => {
    whatsappService.processWebhookMessage.mockResolvedValueOnce({
      success: true,
      skipped: false,
      messageData: {
        from: '919999999999',
        platformId: 'wamid.dup',
        content: 'hi',
        type: 'text',
        timestamp: new Date('2026-01-01T00:00:00Z')
      }
    });
    // prev-author lookup returns an existing doc with SAME lastMid → upsert skips
    Interaction.findOne.mockReturnValueOnce(chainable(null)); // author lookup
    // Now simulate upsert's internal duplicate-mid detection. This is now a single atomic
    // CAS (Interaction.updateOne({ _id, 'metadata.lastMid': { $ne: mid } }, ...)) instead of
    // a plain read-then-compare — modifiedCount: 0 means "lastMid already equals this mid",
    // i.e. a genuine webhook retry, so upsertWhatsAppThread must skip immediately.
    Interaction.findOne.mockReturnValueOnce(chainable({
      _id: 'int-existing', metadata: { lastMid: 'wamid.dup' }, author: {}, chatRef: 'chat-1'
    }));
    Interaction.updateOne.mockResolvedValueOnce({ modifiedCount: 0 });

    await svc.processIncomingMessage(change, connection, payload);

    // Only the CAS claim ran — no thread upsert, no push, no downstream side effects.
    expect(Interaction.updateOne).toHaveBeenCalledTimes(1);
    expect(Interaction.findOneAndUpdate).not.toHaveBeenCalled();
    expect(aiQueue.add).not.toHaveBeenCalled();
    expect(whatsappService.markAsRead).not.toHaveBeenCalled();
  });

  test('concurrent duplicate caught by the atomic $push guard (CAS passes, push modifiedCount:0) still short-circuits', async () => {
    // This covers the harder race: two near-simultaneous deliveries of the exact same mid
    // both pass the early CAS (e.g. thread didn't exist yet / lastMid was genuinely stale),
    // but only ONE of them can win the atomic $push (guarded by 'metadata.incomingMessages.mid':
    // { $ne: mid }). The loser must still be treated as skipped — it must NOT proceed to
    // flows/AI, or the customer gets a duplicate reply.
    whatsappService.processWebhookMessage.mockResolvedValueOnce({
      success: true,
      skipped: false,
      messageData: {
        from: '919999999999',
        platformId: 'wamid.race',
        content: 'hi',
        type: 'text',
        timestamp: new Date('2026-01-01T00:00:00Z')
      }
    });
    Interaction.findOne.mockReturnValueOnce(chainable(null)); // author lookup
    Interaction.findOne.mockReturnValueOnce(chainable({
      _id: 'int-existing', metadata: { lastMid: 'wamid.other' }, author: {}, chatRef: 'chat-1'
    }));
    // 1st updateOne call = the early CAS claim on lastMid — succeeds (this mid is genuinely new).
    Interaction.updateOne.mockResolvedValueOnce({ modifiedCount: 1 });
    // 2nd updateOne call = the atomic $push guard — the OTHER concurrent request already
    // pushed this exact mid first, so this one matches 0 documents.
    Interaction.updateOne.mockResolvedValueOnce({ modifiedCount: 0 });

    await svc.processIncomingMessage(change, connection, payload);

    expect(Interaction.updateOne).toHaveBeenCalledTimes(2);
    expect(aiQueue.add).not.toHaveBeenCalled();
    expect(whatsappService.markAsRead).not.toHaveBeenCalled();
  });
});

// ────────────────────────────────────────────────────────────────────────────
describe('processStatusUpdate', () => {
  test('no-op when status is missing id', async () => {
    await svc.processStatusUpdate({});
    await svc.processStatusUpdate({ status: 'delivered' });
    expect(Interaction.updateOne).not.toHaveBeenCalled();
  });

  test('updates replies deliveryStatus and converts timestamp to Date', async () => {
    Interaction.findOne
      .mockReturnValueOnce(chainable({ replies: [{ platformResponseId: 'wamid.abc', deliveryStatus: 'sent' }] }))
      .mockReturnValueOnce(chainable({ _id: 'int-1', organization: 'org-1' }));
    Interaction.findById.mockReturnValueOnce(chainable({ _id: 'int-1', organization: 'org-1', replies: [] }));

    await svc.processStatusUpdate({
      id: 'wamid.abc', status: 'delivered', timestamp: '1700000000'
    });

    const [filter, update] = Interaction.updateOne.mock.calls[0];
    expect(filter).toEqual({ platform: 'whatsapp', 'replies.platformResponseId': 'wamid.abc' });
    expect(update.$set['replies.$.deliveryStatus']).toBe('delivered');
    expect(update.$set['replies.$.deliveryStatusAt']).toBeInstanceOf(Date);
    expect(update.$set['replies.$.deliveryStatusAt'].getTime()).toBe(1700000000 * 1000);
    expect(emitToOrg).toHaveBeenCalledWith('org-1', 'interaction_updated', expect.any(Object));
  });

  test('does not downgrade deliveryStatus when webhook rank is lower', async () => {
    Interaction.findOne.mockReturnValueOnce(
      chainable({ replies: [{ platformResponseId: 'wamid.read', deliveryStatus: 'read' }] })
    );

    await svc.processStatusUpdate({
      id: 'wamid.read', status: 'delivered', timestamp: '1700000000'
    });

    expect(Interaction.updateOne).not.toHaveBeenCalled();
    expect(emitToOrg).not.toHaveBeenCalled();
  });

  test('failed status marks inbox reply as failed and emits interaction_updated', async () => {
    Interaction.findOne.mockReturnValueOnce(chainable({ _id: 'int-2', organization: 'org-2' }));
    Interaction.findById.mockReturnValueOnce(chainable({
      _id: 'int-2',
      organization: 'org-2',
      replies: [{ platformResponseId: 'wamid.fail', status: 'failed', deliveryStatus: 'failed' }]
    }));

    await svc.processStatusUpdate({
      id: 'wamid.fail', status: 'failed', timestamp: '1700000001'
    });

    expect(Interaction.updateOne).toHaveBeenCalledWith(
      { platform: 'whatsapp', 'replies.platformResponseId': 'wamid.fail' },
      {
        $set: {
          'replies.$.deliveryStatus': 'failed',
          'replies.$.deliveryStatusAt': expect.any(Date),
          'replies.$.status': 'failed'
        }
      }
    );
    expect(emitToOrg).toHaveBeenCalledWith('org-2', 'interaction_updated', expect.any(Object));
  });
});
