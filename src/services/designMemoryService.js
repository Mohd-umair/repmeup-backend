/**
 * Design Memory Service — Phase 3 of the Design Memory System
 *
 * Provides two capabilities:
 * 1. getTopStyleSpecs — returns the style specs of the top-performing published posts
 *    for an org, ranked by designScore (derived from platform engagement).
 *    Used to blend learned styles into future image generation prompts.
 *
 * 2. syncDesignScores — links PlatformPost engagement metrics (likeCount, shareCount)
 *    back to ScheduledPost.metadata.designScore so the ranking stays current.
 *    Called as a background task after platform data syncs.
 */

const ScheduledPost = require('../models/ScheduledPost');
const PlatformPost = require('../models/PlatformPost');
const logger = require('../config/logger');

const SCORE_WEIGHT_LIKE = 1;
const SCORE_WEIGHT_SHARE = 2;
const MIN_SCORE_THRESHOLD = 0;

/**
 * Retrieve the top N published posts for an org that have stored design DNA
 * and a positive designScore, ordered by score descending.
 *
 * @param {string|object} organizationId
 * @param {number} [limit=3]
 * @returns {Promise<Array<{ generationPrompt: string, layoutType: string, colors: string[], medium: string, style: string, designScore: number }>>}
 */
async function getTopStyleSpecs(organizationId, limit = 3) {
  if (!organizationId) return [];
  try {
    const posts = await ScheduledPost.find({
      organization: organizationId,
      status: 'published',
      'metadata.layoutType': { $exists: true, $ne: null },
      'metadata.designScore': { $gt: MIN_SCORE_THRESHOLD }
    })
      .sort({ 'metadata.designScore': -1 })
      .limit(limit)
      .select('metadata.generationPrompt metadata.layoutType metadata.colors metadata.medium metadata.style metadata.designScore')
      .lean();

    return posts.map(p => p.metadata || {});
  } catch (err) {
    logger.warn('designMemoryService.getTopStyleSpecs failed', { organizationId, err: err.message });
    return [];
  }
}

/**
 * Compute and persist designScore for all published posts of an org that have
 * a platformPostId but no designScore yet (or have a stale one).
 * Score = (likeCount × 1) + (shareCount × 2)
 *
 * @param {string|object} organizationId
 * @returns {Promise<{ updated: number }>}
 */
async function syncDesignScores(organizationId) {
  if (!organizationId) return { updated: 0 };
  let updated = 0;
  try {
    const posts = await ScheduledPost.find({
      organization: organizationId,
      status: 'published',
      platformPostId: { $exists: true, $ne: null },
      'metadata.layoutType': { $exists: true, $ne: null }
    })
      .select('_id platformPostId metadata.designScore')
      .lean();

    for (const post of posts) {
      try {
        const pp = await PlatformPost.findOne({ externalId: post.platformPostId })
          .select('likeCount shareCount')
          .lean();
        if (!pp) continue;

        const score = ((pp.likeCount || 0) * SCORE_WEIGHT_LIKE) + ((pp.shareCount || 0) * SCORE_WEIGHT_SHARE);

        // Only write if the score has changed
        if (post.metadata?.designScore !== score) {
          await ScheduledPost.updateOne(
            { _id: post._id },
            { $set: { 'metadata.designScore': score } }
          );
          updated++;
        }
      } catch (innerErr) {
        logger.warn('designMemoryService.syncDesignScores — single post sync failed', {
          postId: post._id, err: innerErr.message
        });
      }
    }

    if (updated > 0) {
      logger.info('designMemoryService.syncDesignScores completed', { organizationId, updated });
    }
    return { updated };
  } catch (err) {
    logger.warn('designMemoryService.syncDesignScores failed', { organizationId, err: err.message });
    return { updated: 0 };
  }
}

module.exports = { getTopStyleSpecs, syncDesignScores };
