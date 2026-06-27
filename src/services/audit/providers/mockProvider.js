/**
 * Mock provider — returns realistic sample data when APIFY_TOKEN /
 * GOOGLE_PLACES_API_KEY are not set, or when NODE_ENV=development.
 * Used to unblock UI build and demo mode.
 */

function mockInstagram(igHandle) {
  const seed = igHandle ? igHandle.charCodeAt(0) : 65;
  const replyRate = 18 + (seed % 30);
  const posts = 28 + (seed % 20);
  const comments = 320 + (seed % 400);
  const replies = Math.round(comments * (replyRate / 100));
  const buyingIntent = 40 + (seed % 80);
  const unanswered = Math.round(buyingIntent * (1 - replyRate / 100));
  return {
    source: 'mock',
    followers: 4200 + (seed * 150),
    posts,
    comments,
    replies,
    replyRate,
    buyingIntentCount: buyingIntent,
    unansweredBuying: unanswered,
    postingGaps: seed % 3 === 0,
    avgEngagement: +(2.1 + (seed % 30) / 10).toFixed(1),
    recentPosts: []
  };
}

function mockFacebook(fbPageUrl) {
  return {
    source: 'mock',
    rating: +(3.8 + Math.random() * 0.8).toFixed(1),
    posts: 12,
    comments: 85,
    replies: 22,
    replyRate: 26
  };
}

function mockGoogle(googleQuery) {
  const seed = googleQuery ? googleQuery.charCodeAt(0) : 65;
  const totalReviews = 120 + (seed % 500);
  const ownerReplyRate = 28 + (seed % 40);
  const negativeCount = Math.round(totalReviews * 0.12);
  const unansweredNegative = Math.round(negativeCount * (1 - ownerReplyRate / 100));
  return {
    source: 'mock',
    rating: +(3.6 + (seed % 12) / 10).toFixed(1),
    totalReviews,
    ownerReplyRate,
    unansweredNegative
  };
}

module.exports = { mockInstagram, mockFacebook, mockGoogle };
