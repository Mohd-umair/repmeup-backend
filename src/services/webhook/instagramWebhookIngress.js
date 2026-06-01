/**
 * Shared Instagram webhook ingress — connection lookup + inline processing on the API process.
 * Must run in server.js (not worker.js) so Socket.IO emitToOrg works for live inbox updates.
 */
const axios = require('axios');
const PlatformConnection = require('../../models/PlatformConnection');
const processWebhook = require('../../jobs/processWebhook');
const logger = require('../../config/logger');

function entryHasProcessableEvents(entry) {
  if (!entry) return false;
  const hasMessaging = entry.messaging?.length > 0;
  const hasStandby = entry.standby?.length > 0;
  const hasChanges = entry.changes?.length > 0;
  const hasCommentChange = hasChanges && entry.changes.some((c) => c.field === 'comments');
  const hasMentionChange = hasChanges && entry.changes.some((c) => c.field === 'mentions');
  return hasMessaging || hasStandby || hasCommentChange || hasMentionChange;
}

/**
 * Resolve the PlatformConnection for an Instagram webhook entry.id.
 * Supports Facebook Login (EAA page token) and Instagram Login (IGAA token).
 */
async function findInstagramConnection(instagramId) {
  const idVariants = [instagramId, String(instagramId)].filter((v) => v != null && v !== '');

  let connection = await PlatformConnection.findOne({
    platform: 'instagram',
    platformUserId: { $in: idVariants },
    isActive: true
  })
    .select('organization platformPageId platformData accessToken metadata')
    .lean();

  if (connection) return connection;

  return PlatformConnection.findOne({
    platform: 'instagram',
    isActive: true,
    $or: [
      { platformPageId: { $in: idVariants } },
      { 'platformData.businessAccountId': String(instagramId) },
      { 'platformData.pageId': { $in: idVariants } }
    ]
  })
    .select('organization platformPageId platformData accessToken metadata')
    .lean();
}

async function takeStandbyThreadControl(entry, connection) {
  const pageId = connection.platformPageId || connection.platformData?.pageId;
  const accessToken = connection.accessToken;
  if (!pageId || !accessToken) return;

  for (const event of entry.standby || []) {
    const senderId = event.sender?.id;
    if (!senderId) continue;
    try {
      await axios.post(`https://graph.facebook.com/v19.0/${pageId}/take_thread_control`, null, {
        params: { recipient_id: senderId, access_token: accessToken }
      });
      logger.info('[Instagram Webhook] Took thread control for standby sender', { senderId });
    } catch (ttcErr) {
      logger.warn('[Instagram Webhook] take_thread_control failed', {
        senderId,
        error: ttcErr.response?.data?.error?.message || ttcErr.message
      });
    }
  }
}

/**
 * Process an Instagram webhook payload (DMs, comments, mentions).
 * @param {object} payload - Meta webhook JSON body
 * @param {string} logPrefix - Log label for the calling endpoint
 */
async function ingestInstagramWebhook(payload, logPrefix = '[Instagram Webhook]') {
  const entry = payload?.entry?.[0];
  if (!entry) {
    logger.info(`${logPrefix} No entry in payload`);
    return null;
  }

  if (!entryHasProcessableEvents(entry)) {
    logger.debug(`${logPrefix} No processable messaging/changes in entry`, { entryId: entry.id });
    return null;
  }

  const instagramId = entry.id;
  const isMetaTestEvent = String(instagramId) === '0';
  const connection = await findInstagramConnection(instagramId);

  if (!connection) {
    const hasMentionChange = entry.changes?.some((c) => c.field === 'mentions');
    if (isMetaTestEvent && hasMentionChange) {
      logger.info(`${logPrefix} Meta test mention (entry.id=0) — callback URL is reachable`);
    } else {
      logger.info(`${logPrefix} No active Instagram connection for account ${instagramId}`);
    }
    return null;
  }

  const hasStandby = entry.standby?.length > 0;
  const hasMessaging = entry.messaging?.length > 0;
  const isIgLogin =
    typeof connection.accessToken === 'string' && connection.accessToken.startsWith('IGAA');

  if (hasStandby && !hasMessaging && !isIgLogin) {
    await takeStandbyThreadControl(entry, connection);
  }

  const organizationId = connection.organization.toString();
  const result = await processWebhook({
    data: { platform: 'instagram', payload, organizationId },
    id: `instagram-${Date.now()}`
  });

  if (result?.interactionId) {
    logger.info(`${logPrefix} Saved interaction`, { interactionId: String(result.interactionId) });
  }

  return result;
}

module.exports = {
  entryHasProcessableEvents,
  findInstagramConnection,
  ingestInstagramWebhook
};
