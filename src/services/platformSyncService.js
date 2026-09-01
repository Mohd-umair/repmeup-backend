/**
 * Platform Sync Service
 *
 * Owns all orchestration logic for manually syncing a connected platform:
 *   - Routing to the correct integration service (instagram, facebook, etc.)
 *   - Post-sync sentiment (skipped for sync backfill — same window as paid AI)
 *   - AI queue + heuristic bucket for backfill; auto-reply only for live synced traffic
 *   - Inbox cache invalidation
 *
 * The controller only does: find connection → call this service → return JSON.
 * Business logic lives here, HTTP concerns stay in the controller.
 */

const googleService = require('../integrations/google/googleService');
const youtubeService = require('../integrations/google/youtubeService');
const instagramService = require('../integrations/meta/instagramService');
const facebookService = require('../integrations/meta/facebookService');
const linkedinService = require('../integrations/linkedin/linkedinService');
const whatsappService = require('../integrations/whatsapp/whatsappService');
const Interaction = require('../models/Interaction');
const IntentBucket = require('../models/IntentBucket');
const { aiQueue } = require('../config/queue');
const autoReplyScheduler = require('./autoReplyScheduler');
const aiService = require('./aiService');
const cacheService = require('./cacheService');
const logger = require('../config/logger');
const {
  shouldSkipAiProcessingForSyncedInteraction,
  shouldApplyHeuristicIntentBucket
} = require('../utils/syncInteractionBackfillGuard');

/**
 * Sync a platform connection and return a result summary.
 *
 * @param {object} connection    - Mongoose document (PlatformConnection)
 * @param {string} organizationId
 * @returns {Promise<{
 *   count: number,
 *   autoReplyQueued: number,
 *   sentimentAnalyzed: number,
 *   aiSkippedBackfill: number,
 *   linkedInSyncHint?: string,
 *   error?: string          // present when the platform returns a non-fatal error message
 * }>}
 * @throws When an unrecoverable error occurs (caller should surface as 500)
 */
async function syncPlatform(connection, organizationId) {
  let result = { count: 0, interactions: [] };

  // ── Platform-specific fetch ───────────────────────────────────────────────

  switch (connection.platform) {
    case 'youtube':
      await youtubeService.ensureValidToken(connection);
      result = await youtubeService.fetchAllChannelComments(connection);
      logger.debug('[platformSyncService] YouTube sync result', { count: result.count });
      break;

    case 'google':
      await googleService.ensureValidToken(connection);
      result = await googleService.fetchAllReviews(connection);
      if (!result.success && result.error) {
        // Non-fatal: surface the platform error message to the caller
        return { count: result.count || 0, autoReplyQueued: 0, sentimentAnalyzed: 0, aiSkippedBackfill: 0, error: result.error };
      }
      break;

    case 'instagram': {
      const syncComments = connection.settings?.syncComments !== false;
      const syncDMs = connection.settings?.syncDMs !== false;
      if (!syncComments && !syncDMs) {
        return { count: 0, autoReplyQueued: 0, sentimentAnalyzed: 0, aiSkippedBackfill: 0, error: 'Both comments and DMs sync are disabled for this connection' };
      }
      if (syncComments && syncDMs) {
        result = await instagramService.fetchAllInteractions(connection);
      } else if (syncComments) {
        result = await instagramService.fetchComments(connection);
      } else {
        result = await instagramService.fetchMessages(connection);
      }
      break;
    }

    case 'facebook':
      if (!connection.platformPageId) {
        logger.warn('[platformSyncService] Facebook connection has no Page ID — skipping sync');
        result = { count: 0, interactions: [] };
      } else {
        result = await facebookService.fetchAllInteractions(connection);
      }
      break;

    case 'linkedin':
      result = await linkedinService.fetchAllInteractions(connection);
      break;

    case 'shopify': {
      // Shopify sync = full backfill of products, customers, and orders.
      // This is data-store sync (not inbox interactions), so we return count=0
      // for the interaction counter but trigger the actual sync in the background.
      const shopifySyncService = require('./shopifySyncService');
      shopifySyncService.runFullSync(connection).catch(err => {
        logger.error('[platformSyncService] Shopify background sync error', { error: err.message });
      });
      return { count: 0, autoReplyQueued: 0, sentimentAnalyzed: 0, aiSkippedBackfill: 0 };
    }

    case 'whatsapp': {
      // WhatsApp Cloud API has no "fetch history" endpoint.
      // Refresh the connection health/quality info instead.
      try {
        const verifyResult = await whatsappService.verifyConnection(connection);
        if (verifyResult.success) {
          connection.platformData = {
            ...connection.platformData,
            qualityRating: verifyResult.qualityRating,
            codeVerificationStatus: verifyResult.codeVerificationStatus
          };
          connection.lastSyncAt = new Date();
          await connection.save();
        }
        await whatsappService.applyProfilePictureToConnection(connection).catch(() => {});
      } catch (err) {
        logger.warn('[platformSyncService] WhatsApp health check failed (non-fatal)', { error: err.message });
      }
      return { count: 0, autoReplyQueued: 0, sentimentAnalyzed: 0, aiSkippedBackfill: 0 };
    }

    default:
      return { count: 0, autoReplyQueued: 0, sentimentAnalyzed: 0, aiSkippedBackfill: 0, error: 'Platform sync not implemented' };
  }

  // ── Post-sync processing ──────────────────────────────────────────────────

  let autoReplyQueued = 0;
  let sentimentAnalyzed = 0;
  let aiSkippedBackfill = 0;

  if (result.count > 0 && result.interactions?.length > 0) {
    const platformIds = result.interactions.map(i => i.platformId);

    // Only process unread interactions that have not been replied to
    const newInteractions = await Interaction.find({
      platformId: { $in: platformIds },
      organization: organizationId,
      status: 'unread',
      $or: [{ replies: { $size: 0 } }, { replies: { $exists: false } }]
    });

    const activeBuckets =
      newInteractions.length > 0
        ? await IntentBucket.find({ organization: organizationId, isActive: true })
            .sort({ order: 1 })
            .lean()
        : [];

    // Sentiment analysis — skip for sync backfill (same window as paid AI / auto-reply)
    for (const interaction of newInteractions) {
      const skipBackfill = shouldSkipAiProcessingForSyncedInteraction(interaction, connection);
      if (!interaction.sentiment && interaction.content && !skipBackfill) {
        try {
          const sentimentResult = aiService.fallbackSentimentAnalysis(interaction.content);
          await Interaction.updateOne(
            { _id: interaction._id },
            {
              $set: {
                sentiment: sentimentResult.sentiment,
                sentimentScore: sentimentResult.sentimentScore,
                sentimentConfidence: sentimentResult.sentimentConfidence
              }
            }
          );
          sentimentAnalyzed++;
        } catch (sentimentError) {
          logger.warn('[platformSyncService] Sentiment analysis failed', {
            interactionId: interaction._id,
            error: sentimentError.message
          });
        }
      }
    }

    // AI + auto-reply queue — skip historical / old synced backlog; heuristic bucket only (no credits)
    for (const interaction of newInteractions) {
      try {
        if (interaction.replies?.length > 0) continue;

        const skipBackfill = shouldSkipAiProcessingForSyncedInteraction(interaction, connection);

        if (skipBackfill) {
          aiSkippedBackfill++;
          if (shouldApplyHeuristicIntentBucket(interaction)) {
            const bucketRes = aiService.resolveIntentBucketWithoutAi(
              interaction.content == null ? '' : String(interaction.content),
              activeBuckets
            );
            if (bucketRes.bucketId) {
              await Interaction.updateOne(
                { _id: interaction._id },
                { $set: { intentBucket: bucketRes.bucketId, bucketAssignedBy: bucketRes.method } }
              );
            }
          }
        } else {
          await aiQueue.add(
            { interactionId: interaction._id },
            { attempts: 3, backoff: 2000, jobId: `ai-${interaction._id}` }
          );
        }

        if (skipBackfill) {
          logger.debug('[platformSyncService] Skipping paid AI & auto-reply for sync backfill', {
            interactionId: interaction._id,
            msgDate: interaction.platformCreatedAt || interaction.createdAt,
            connectedAt: connection.connectedAt,
            createdAt: connection.createdAt
          });
          continue;
        }

        const queued = await autoReplyScheduler.queueImmediateAutoReply(
          interaction._id.toString(),
          organizationId
        );
        if (queued) autoReplyQueued++;
      } catch (queueError) {
        logger.error('[platformSyncService] Error queueing interaction', {
          interactionId: interaction._id,
          error: queueError.message
        });
      }
    }

    // Invalidate inbox list cache so frontend sees new data without a page refresh
    await cacheService.invalidateInteractionCaches(organizationId).catch(() => {});
  }

  logger.info('[platformSyncService] Sync complete', {
    platform: connection.platform,
    count: result.count,
    sentimentAnalyzed,
    autoReplyQueued,
    aiSkippedBackfill
  });

  return {
    count: result.count,
    autoReplyQueued,
    sentimentAnalyzed,
    aiSkippedBackfill,
    linkedInSyncHint: result.linkedInSyncHint
  };
}

module.exports = { syncPlatform };
