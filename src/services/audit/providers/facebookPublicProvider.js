/**
 * Facebook Public Provider
 *
 * Fetches public Facebook page data via Apify's facebook-pages-scraper actor.
 * Falls back to mockProvider when APIFY_TOKEN is not set.
 *
 * We audit ONLY public pages (rating, recommendation score, comment reply rate).
 */

const axios = require('axios');
const logger = require('../../../config/logger');
const { mockFacebook } = require('./mockProvider');

const APIFY_BASE = 'https://api.apify.com/v2';

async function runApifyActor(actorId, input, timeoutSecs = 60) {
  const token = process.env.APIFY_TOKEN;
  const resp = await axios.post(
    `${APIFY_BASE}/acts/${actorId}/run-sync-get-dataset-items`,
    input,
    {
      params: { token, timeout: timeoutSecs },
      timeout: (timeoutSecs + 10) * 1000,
      headers: { 'Content-Type': 'application/json' }
    }
  );
  return Array.isArray(resp.data) ? resp.data : [];
}

/**
 * Fetch public Facebook page data.
 *
 * @param {string} fbPageUrl  e.g. "https://www.facebook.com/ZaraOfficial" or "ZaraOfficial"
 * @returns {Promise<object>}
 */
async function fetchFacebook(fbPageUrl) {
  if (!process.env.APIFY_TOKEN) {
    logger.warn('[facebookPublicProvider] APIFY_TOKEN not set — using mock data');
    return mockFacebook(fbPageUrl);
  }

  const url = fbPageUrl.startsWith('http')
    ? fbPageUrl
    : `https://www.facebook.com/${fbPageUrl}`;

  try {
    const items = await runApifyActor('apify/facebook-pages-scraper', {
      startUrls: [{ url }],
      maxPosts: 10,
      maxPostComments: 20,
      maxReviews: 0,
      proxy: { useApifyProxy: true }
    }, 90);

    if (!items || items.length === 0) {
      logger.warn('[facebookPublicProvider] No data returned', { fbPageUrl });
      return mockFacebook(fbPageUrl);
    }

    const page = items[0];
    const rating = page.pageRating || page.rating || null;
    const posts = page.posts || [];
    const totalPosts = posts.length;

    let totalComments = 0;
    let ownerReplies = 0;
    const pageName = page.title || '';

    for (const post of posts) {
      const comments = post.comments || [];
      for (const comment of comments) {
        if (!comment.isPageAdmin) {
          totalComments++;
          // Check if page admin replied in thread
          const adminReplied = (comment.replies || []).some(r => r.isPageAdmin);
          if (adminReplied) ownerReplies++;
        }
      }
    }

    const commentReplyRate = totalComments > 0
      ? Math.round((ownerReplies / totalComments) * 100)
      : 0;

    return {
      source: 'apify_facebook',
      pageName,
      rating,
      posts: totalPosts,
      comments: totalComments,
      replies: ownerReplies,
      replyRate: commentReplyRate
    };
  } catch (err) {
    logger.error('[facebookPublicProvider] Apify error — falling back to mock', {
      fbPageUrl,
      error: err.message
    });
    return mockFacebook(fbPageUrl);
  }
}

module.exports = { fetchFacebook };
