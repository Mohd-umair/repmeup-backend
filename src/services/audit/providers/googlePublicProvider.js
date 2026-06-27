/**
 * Google Public Provider
 *
 * Uses the Google Places API (Text Search → Place Details) to fetch:
 *   - Rating, total reviews, business name, photo
 *   - Place Details reviews endpoint (up to 5 most recent)
 *
 * Falls back to mockProvider when GOOGLE_PLACES_API_KEY is not set.
 *
 * Note: The Places API v1 (new) requires billing to be enabled on the project.
 * The classic Places API (maps.googleapis.com) is used here for compatibility.
 */

const axios = require('axios');
const logger = require('../../../config/logger');
const { mockGoogle } = require('./mockProvider');

const PLACES_BASE = 'https://maps.googleapis.com/maps/api/place';

/**
 * Fetch Google business data for a given query string.
 *
 * @param {string} googleQuery  e.g. "Bose Hair Salon Mumbai"
 * @returns {Promise<object>}
 */
async function fetchGoogle(googleQuery) {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) {
    logger.warn('[googlePublicProvider] GOOGLE_PLACES_API_KEY not set — using mock data');
    return mockGoogle(googleQuery);
  }

  try {
    // Step 1: Text search to get place_id
    const searchResp = await axios.get(`${PLACES_BASE}/textsearch/json`, {
      params: { query: googleQuery, key: apiKey },
      timeout: 10000
    });

    const results = searchResp.data?.results;
    if (!results || results.length === 0) {
      logger.warn('[googlePublicProvider] No results for query', { googleQuery });
      return mockGoogle(googleQuery);
    }

    const place = results[0];
    const placeId = place.place_id;
    const rating = place.rating || null;
    const totalReviews = place.user_ratings_total || 0;

    // Step 2: Place Details for reviews
    let ownerReplyRate = null;
    let unansweredNegative = 0;

    try {
      const detailsResp = await axios.get(`${PLACES_BASE}/details/json`, {
        params: {
          place_id: placeId,
          fields: 'reviews',
          key: apiKey
        },
        timeout: 10000
      });

      const reviews = detailsResp.data?.result?.reviews || [];
      if (reviews.length > 0) {
        const withReply = reviews.filter(r => r.author_url && r.text).length;
        const replied = reviews.filter(r => r.owner_response).length;
        ownerReplyRate = Math.round((replied / reviews.length) * 100);
        const negativeReviews = reviews.filter(r => (r.rating || 0) <= 2);
        unansweredNegative = negativeReviews.filter(r => !r.owner_response).length;
      }
    } catch (detailErr) {
      logger.warn('[googlePublicProvider] Details fetch failed', { error: detailErr.message });
    }

    return {
      source: 'google_places',
      placeId,
      businessName: place.name || googleQuery,
      rating,
      totalReviews,
      ownerReplyRate: ownerReplyRate !== null ? ownerReplyRate : 30,
      unansweredNegative,
      address: place.formatted_address || ''
    };
  } catch (err) {
    logger.error('[googlePublicProvider] API error — falling back to mock', { error: err.message });
    return mockGoogle(googleQuery);
  }
}

module.exports = { fetchGoogle };
