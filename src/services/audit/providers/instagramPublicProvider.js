/**
 * Instagram Public Provider
 *
 * Fetches public Instagram profile data via Apify's instagram-scraper actor.
 * Falls back to mockProvider when APIFY_TOKEN is not set.
 *
 * We audit ONLY public-facing pages. Comments are analysed for buying-intent
 * keywords to power the Revenue Leak module.
 *
 * Buying-intent keywords (English + Hindi transliterations):
 *   price, rate, cost, how much, kitna, price?, dm, link, available,
 *   stock, order, buy, purchase, delivery, cod, book, contact
 */

const logger = require('../../../config/logger');
const { mockInstagram } = require('./mockProvider');
const { runApifyActor } = require('./apifyRunner');

const BUYING_INTENT_PATTERNS = [
  /price|rate|cost|how much|kitna|kitni/i,
  /dm\s*me|direct\s*mess|link\s*in\s*bio|link please/i,
  /available|in stock|stock\s*hai|milega/i,
  /order|buy|purchase|book/i,
  /delivery|shipping|courier|cod/i,
  /contact|whatsapp|number|call/i,
  /discount|offer|deal/i
];

function hasBuyingIntent(text) {
  if (!text) return false;
  return BUYING_INTENT_PATTERNS.some(re => re.test(text));
}

/**
 * Fetch public Instagram profile + comment data for a given handle.
 *
 * @param {string} igHandle  e.g. "zara" (without @)
 * @returns {Promise<object>}
 */
async function fetchInstagram(igHandle) {
  if (!process.env.APIFY_TOKEN) {
    logger.warn('[instagramPublicProvider] APIFY_TOKEN not set — using mock data');
    return mockInstagram(igHandle);
  }

  const handle = igHandle.replace(/^@/, '').trim();

  try {
    // Apify instagram-scraper actor: apify/instagram-scraper
    const items = await runApifyActor('apify~instagram-scraper', {
      directUrls: [`https://www.instagram.com/${handle}/`],
      resultsType: 'posts',
      resultsLimit: 20,
      addParentData: false
    }, 90);

    if (!items || items.length === 0) {
      logger.warn('[instagramPublicProvider] No posts returned', { handle });
      return mockInstagram(igHandle);
    }

    const profileItem = items[0];
    const followers = profileItem.followersCount || 0;
    const posts = items.length;

    let totalComments = 0;
    let totalReplies = 0;
    let buyingIntentCount = 0;
    let unansweredBuying = 0;

    // Analyse comments across all posts
    for (const post of items) {
      const comments = post.latestComments || [];
      totalComments += post.commentsCount || comments.length;
      for (const comment of comments) {
        const isOwner = comment.ownerUsername === handle;
        if (!isOwner && comment.text) {
          if (hasBuyingIntent(comment.text)) {
            buyingIntentCount++;
            // Check if owner replied to this comment
            const ownerReplied = (comment.replies || []).some(
              r => r.ownerUsername === handle
            );
            if (!ownerReplied) unansweredBuying++;
          }
          // Count replies from the owner
          const ownerRepliesInThread = (comment.replies || []).filter(
            r => r.ownerUsername === handle
          ).length;
          totalReplies += ownerRepliesInThread;
        }
      }
    }

    const replyRate = totalComments > 0
      ? Math.min(100, Math.round((totalReplies / totalComments) * 100))
      : 0;

    // Detect posting gaps (≥7 days between consecutive posts in last 30 days)
    const timestamps = items
      .map(p => p.timestamp ? new Date(p.timestamp).getTime() : null)
      .filter(Boolean)
      .sort((a, b) => b - a);
    let postingGaps = false;
    const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const recentTs = timestamps.filter(t => t >= thirtyDaysAgo);
    for (let i = 0; i < recentTs.length - 1; i++) {
      if (recentTs[i] - recentTs[i + 1] > 7 * 24 * 60 * 60 * 1000) {
        postingGaps = true;
        break;
      }
    }

    // Average engagement rate (likes + comments / followers)
    const avgEngagement = followers > 0
      ? +(items.reduce((sum, p) => sum + (p.likesCount || 0) + (p.commentsCount || 0), 0)
        / items.length / followers * 100).toFixed(2)
      : 0;

    return {
      source: 'apify_instagram',
      followers,
      posts,
      comments: totalComments,
      replies: totalReplies,
      replyRate,
      buyingIntentCount,
      unansweredBuying,
      postingGaps,
      avgEngagement
    };
  } catch (err) {
    logger.error('[instagramPublicProvider] Apify error — falling back to mock', {
      handle,
      error: err.message
    });
    return mockInstagram(igHandle);
  }
}

module.exports = { fetchInstagram, hasBuyingIntent };
