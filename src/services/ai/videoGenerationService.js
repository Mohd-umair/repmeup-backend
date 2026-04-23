/**
 * Video Generation Service (OpenAI Sora)
 *
 * Three-step flow against /v1/videos:
 *   1) POST  /v1/videos                → submit job, returns { id }
 *   2) GET   /v1/videos/{id}           → poll until status is "completed" or "failed"
 *   3) GET   /v1/videos/{id}/content   → download the MP4 bytes
 *
 * Notes:
 *   - Sora accepts a fixed set of seconds values (4 | 8 | 12) — we snap to nearest.
 *   - Sora accepts a fixed set of sizes (720x1280 portrait, 1280x720 landscape) — we map from aspect.
 *   - Total wall-clock for a generation can exceed 60s; we cap at OPENAI_VIDEO_TIMEOUT_MS
 *     (default 5 min, max 10 min).
 *   - Returns the MP4 Buffer on success, null on timeout / download failure.
 *     Throws when the OpenAI submit call rejects or the Sora job ends in 'failed' state.
 */

const axios = require('axios');
const logger = require('../../config/logger');
const openaiClient = require('./openaiClient');

const VIDEO_API_BASE = 'https://api.openai.com/v1/videos';
const POLL_INTERVAL_MS = 5000;
const SUBMIT_TIMEOUT_MS = 30000;
const POLL_TIMEOUT_MS = 15000;
const DOWNLOAD_TIMEOUT_MS = 120000;
const MIN_OVERALL_TIMEOUT_MS = 60000;
const MAX_OVERALL_TIMEOUT_MS = 600000;
const DEFAULT_OVERALL_TIMEOUT_MS = 300000;

const SIZE_BY_ASPECT = Object.freeze({ '16:9': '1280x720', '9:16': '720x1280' });
const VALID_SECONDS = [4, 8, 12];

/** Snap requested duration (seconds) to the nearest Sora-allowed value. */
function snapSeconds(duration) {
  return VALID_SECONDS.reduce((prev, cur) =>
    Math.abs(cur - duration) < Math.abs(prev - duration) ? cur : prev
  );
}

/**
 * Generate a short video via OpenAI Sora.
 *
 * @param {string} prompt
 * @param {object} [options]
 * @param {number} [options.duration=4]    - Clip length in seconds (snapped to 4 | 8 | 12)
 * @param {string} [options.aspect='9:16'] - '16:9' | '9:16'
 * @returns {Promise<Buffer|null>}         - MP4 Buffer, or null on timeout/download failure
 */
async function generateVideo(prompt, { duration = 4, aspect = '9:16' } = {}) {
  if (!openaiClient.hasApiKey()) {
    logger.warn('[Video] OPENAI_API_KEY not set — video generation skipped.');
    return null;
  }

  const model = process.env.OPENAI_VIDEO_MODEL || 'sora-2';
  const overallTimeoutMs = Math.min(
    Math.max(parseInt(process.env.OPENAI_VIDEO_TIMEOUT_MS, 10) || DEFAULT_OVERALL_TIMEOUT_MS, MIN_OVERALL_TIMEOUT_MS),
    MAX_OVERALL_TIMEOUT_MS
  );

  const size = SIZE_BY_ASPECT[aspect] || SIZE_BY_ASPECT['9:16'];
  const seconds = String(snapSeconds(duration));

  const videoPrompt = typeof prompt === 'string' && prompt.length > 0
    ? prompt.substring(0, 2000)
    : 'A professional social media short video, modern, high quality, no text.';

  const headers = {
    Authorization: `Bearer ${openaiClient.apiKey}`,
    'Content-Type': 'application/json'
  };

  // ── Step 1: Submit ───────────────────────────────────────────────────────
  let jobId;
  try {
    const submitRes = await axios.post(
      VIDEO_API_BASE,
      { model, prompt: videoPrompt, size, seconds },
      { headers, timeout: SUBMIT_TIMEOUT_MS }
    );
    jobId = submitRes.data?.id;
    if (!jobId) {
      logger.warn('[Video] Sora did not return a job id', { data: submitRes.data });
      return null;
    }
    logger.info('[Video] Sora job submitted', { jobId, model, size, seconds });
  } catch (err) {
    logger.warn('[Video] Sora submit failed', {
      error: err.message,
      status: err.response?.status,
      openaiError: err.response?.data?.error?.message
    });
    throw err;
  }

  // ── Step 2: Poll ─────────────────────────────────────────────────────────
  const deadline = Date.now() + overallTimeoutMs;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));

    let statusRes;
    try {
      statusRes = await axios.get(`${VIDEO_API_BASE}/${jobId}`, { headers, timeout: POLL_TIMEOUT_MS });
    } catch (pollErr) {
      logger.warn('[Video] Sora poll request failed (will retry)', { jobId, error: pollErr.message });
      continue;
    }

    const status = statusRes.data?.status;
    logger.info('[Video] Sora job status', { jobId, status, progress: statusRes.data?.progress });

    if (status === 'completed') {
      // ── Step 3: Download ───────────────────────────────────────────────
      try {
        const dlRes = await axios.get(`${VIDEO_API_BASE}/${jobId}/content`, {
          headers: { Authorization: `Bearer ${openaiClient.apiKey}` },
          responseType: 'arraybuffer',
          timeout: DOWNLOAD_TIMEOUT_MS,
          maxContentLength: Infinity,
          maxBodyLength: Infinity
        });
        openaiClient.logVideoUsage(model, parseInt(seconds, 10) || 4);
        return Buffer.from(dlRes.data);
      } catch (dlErr) {
        logger.warn('[Video] MP4 download failed', { jobId, error: dlErr.message });
        return null;
      }
    }

    if (status === 'failed') {
      const reason = statusRes.data?.error?.message || 'Video generation failed';
      logger.warn('[Video] Sora job failed', { jobId, reason });
      const err = new Error(reason);
      err.soraFailed = true;
      err.soraStatus = status;
      throw err;
    }

    // statuses 'queued' | 'in_progress' — keep polling
  }

  logger.warn('[Video] Sora job timed out', { jobId, timeoutMs: overallTimeoutMs });
  return null;
}

module.exports = { generateVideo };
