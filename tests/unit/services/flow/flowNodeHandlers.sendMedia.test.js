'use strict';

/**
 * flowNodeHandlers — action.send_media (photo/video/document/audio) send path.
 *
 * Bug this protects against: sending flow media via `sendMediaByUrl` (a bare `{ link }`
 * payload) makes Meta fetch the asset from our URL AFTER accepting the API call — that
 * fetch happens asynchronously and its duration is outside our control. A node sent right
 * after (e.g. an "Ask a question" interactive message) has no such fetch step and can be
 * delivered to the customer's phone first, even though our code sent the photo first and
 * awaited it. This is the documented root cause of "Send photo" flow nodes appearing to
 * arrive AFTER a later text/question node. The fix pre-uploads the media to get a Graph
 * media id and sends by id (fast, deterministic, same class of delivery as text/interactive
 * messages), falling back to the old link-based send only if the pre-upload itself fails.
 */

jest.mock('../../../../src/integrations/whatsapp/whatsappService', () => ({
  uploadMediaFromUrl: jest.fn(),
  sendMediaMessage: jest.fn(),
  sendMediaByUrl: jest.fn()
}));
jest.mock('../../../../src/services/flow/flowMessageService', () => ({
  resolveWhatsAppTarget: jest.fn()
}));
jest.mock('../../../../src/services/inbox/inboxAutomationReplyService', () => ({
  recordAutomationReply: jest.fn().mockResolvedValue({})
}));

const whatsappService = require('../../../../src/integrations/whatsapp/whatsappService');
const flowMessageService = require('../../../../src/services/flow/flowMessageService');
const { executeNodeHandler } = require('../../../../src/services/flow/flowNodeHandlers');

const CONN = { _id: 'conn_1' };

function baseCtx(overrides = {}) {
  return {
    node: {
      id: 'media1',
      type: 'action.send_media',
      config: { mediaType: 'image', mediaUrl: 'https://cdn.example.com/photo.jpg', caption: 'Here you go' }
    },
    enrollment: { variables: {} },
    interaction: { _id: 'itx_1' },
    organizationId: 'org_1',
    edges: [],
    ...overrides
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  flowMessageService.resolveWhatsAppTarget.mockResolvedValue({ conn: CONN, recipient: '15551234567' });
});

describe('flowNodeHandlers — action.send_media ordering fix', () => {
  it('pre-uploads the media and sends by id (happy path) instead of by link', async () => {
    whatsappService.uploadMediaFromUrl.mockResolvedValue('wamid_media_123');
    whatsappService.sendMediaMessage.mockResolvedValue({ success: true, messageId: 'wamid_1' });

    await executeNodeHandler(baseCtx());

    expect(whatsappService.uploadMediaFromUrl).toHaveBeenCalledWith(CONN, 'https://cdn.example.com/photo.jpg', 'image');
    expect(whatsappService.sendMediaMessage).toHaveBeenCalledWith(
      CONN, '15551234567', 'image', 'wamid_media_123', 'Here you go', ''
    );
    expect(whatsappService.sendMediaByUrl).not.toHaveBeenCalled();
  });

  it('falls back to the link-based send if pre-upload fails, so the photo still goes out', async () => {
    whatsappService.uploadMediaFromUrl.mockRejectedValue(new Error('upstream fetch timed out'));
    whatsappService.sendMediaByUrl.mockResolvedValue({ success: true, messageId: 'wamid_2' });

    await executeNodeHandler(baseCtx());

    expect(whatsappService.uploadMediaFromUrl).toHaveBeenCalled();
    expect(whatsappService.sendMediaByUrl).toHaveBeenCalledWith(
      CONN, '15551234567', 'image', 'https://cdn.example.com/photo.jpg', 'Here you go', ''
    );
    expect(whatsappService.sendMediaMessage).not.toHaveBeenCalled();
  });
});
