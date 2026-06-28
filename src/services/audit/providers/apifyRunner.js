/**
 * Shared Apify actor runner for public audit providers.
 *
 * Actor IDs must use tilde notation in REST paths:
 *   apify~instagram-scraper  (NOT apify/instagram-scraper)
 *
 * @see https://docs.apify.com/api/v2/act-run-sync-get-dataset-items-post
 */

const axios = require('axios');
const logger = require('../../../config/logger');

const APIFY_BASE = 'https://api.apify.com/v2';

/** Convert "owner/name" or "owner~name" to Apify REST actorId. */
function normalizeActorId(actorId) {
  return String(actorId).trim().replace('/', '~');
}

/**
 * Run an Apify actor synchronously and return dataset items.
 *
 * @param {string} actorId  e.g. "apify~instagram-scraper"
 * @param {object} input    Actor input JSON
 * @param {number} [timeoutSecs=90]
 * @returns {Promise<object[]>}
 */
async function runApifyActor(actorId, input, timeoutSecs = 90) {
  const token = process.env.APIFY_TOKEN;
  if (!token) {
    throw new Error('APIFY_TOKEN not configured');
  }

  const id = normalizeActorId(actorId);
  const url = `${APIFY_BASE}/acts/${id}/run-sync-get-dataset-items`;

  try {
    const resp = await axios.post(url, input, {
      params: { token, timeout: timeoutSecs },
      timeout: (timeoutSecs + 15) * 1000,
      headers: { 'Content-Type': 'application/json' }
    });
    return Array.isArray(resp.data) ? resp.data : [];
  } catch (err) {
    const status = err.response?.status;
    const body = err.response?.data;
    logger.error('[apifyRunner] actor run failed', {
      actorId: id,
      status,
      error: err.message,
      apifyError: body?.error?.message || body?.message || body
    });
    throw err;
  }
}

module.exports = { runApifyActor, normalizeActorId };
