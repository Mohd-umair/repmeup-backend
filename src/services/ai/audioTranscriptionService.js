/**
 * Audio Transcription Service
 *
 * Detects incoming voice-note interactions, resolves the audio binary per-platform,
 * and transcribes it via OpenAI Whisper so the rest of the AI pipeline (sentiment
 * analysis, intent classification, auto-reply) can operate on actual text.
 *
 * Platform audio URL resolution:
 *   WhatsApp   — interaction.metadata.mediaId   → whatsappService.getMediaUrl + downloadMedia
 *   Instagram  — metadata.incomingMessages[last].attachmentUrl  (direct Meta CDN URL)
 *   Facebook   — same as Instagram
 */

const axios = require('axios');
const PlatformConnection = require('../../models/PlatformConnection');
const whatsappService = require('../../integrations/whatsapp/whatsappService');
const openaiClient = require('./openaiClient');
const logger = require('../../config/logger');

const svcLogger = logger.createChild ? logger.createChild({ module: 'audioTranscriptionService' }) : logger;

/** Regex to match common audio placeholder strings stored in interaction.content */
const AUDIO_PLACEHOLDER_RE = /^\[(audio|Audio Message|voice_note|voice note)\]$/i;

/**
 * Returns true when the interaction represents an incoming voice note / audio message.
 * Checks both `contentType` and the placeholder pattern in `content`.
 *
 * @param {object} interaction
 * @returns {boolean}
 */
function isAudioInteraction(interaction) {
  if (!interaction) return false;
  if (interaction.contentType === 'audio') return true;
  const content = (interaction.content ?? '').trim();
  return AUDIO_PLACEHOLDER_RE.test(content);
}

/**
 * Resolve the audio binary for the given interaction.
 * Returns `{ buffer: Buffer, mimeType: string }` or throws if resolution fails.
 *
 * @param {object} interaction  - Mongoose document or plain object
 * @returns {Promise<{ buffer: Buffer, mimeType: string }>}
 */
async function resolveAudioBuffer(interaction) {
  const platform = (interaction.platform || '').toLowerCase();

  if (platform === 'whatsapp') {
    return _resolveWhatsAppAudio(interaction);
  }

  if (platform === 'instagram' || platform === 'facebook') {
    return _resolveMetaAudio(interaction);
  }

  throw new Error(`Unsupported platform for audio transcription: ${platform}`);
}

/**
 * Transcribe the voice note in the given interaction.
 * Returns the transcript string, or throws if transcription fails.
 *
 * @param {object} interaction
 * @returns {Promise<string>}
 */
async function transcribeInteractionAudio(interaction) {
  const { buffer, mimeType } = await resolveAudioBuffer(interaction);
  const transcript = await openaiClient.transcribeAudio(buffer, mimeType);
  return transcript;
}

// ─── Private helpers ──────────────────────────────────────────────────────────

async function _resolveWhatsAppAudio(interaction) {
  const mediaId = interaction.metadata?.mediaId;
  if (!mediaId) {
    throw new Error('[audioTranscriptionService] WhatsApp interaction has no metadata.mediaId');
  }

  // processAI.js populates platformConnection with only { connectedAt, createdAt }.
  // Load the full document so we have accessToken for the WhatsApp API call.
  const connId = interaction.platformConnection?._id || interaction.platformConnection;
  if (!connId) {
    throw new Error('[audioTranscriptionService] No platformConnection on interaction');
  }
  const connection = await PlatformConnection.findById(connId).lean();
  if (!connection) {
    throw new Error(`[audioTranscriptionService] PlatformConnection ${connId} not found`);
  }

  const mediaInfo = await whatsappService.getMediaUrl(connection, mediaId);
  if (!mediaInfo?.url) {
    throw new Error('[audioTranscriptionService] getMediaUrl returned no URL');
  }

  const download = await whatsappService.downloadMedia(connection, mediaInfo.url);
  if (!download?.data) {
    throw new Error('[audioTranscriptionService] downloadMedia returned no data');
  }

  const buffer = Buffer.isBuffer(download.data) ? download.data : Buffer.from(download.data);
  const mimeType = mediaInfo.mimeType || download.contentType || 'audio/ogg';
  return { buffer, mimeType };
}

async function _resolveMetaAudio(interaction) {
  // Find the last audio attachment in incomingMessages
  const messages = interaction.metadata?.incomingMessages;
  let attachmentUrl = null;

  if (Array.isArray(messages) && messages.length > 0) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.attachmentType === 'audio' && msg.attachmentUrl) {
        attachmentUrl = msg.attachmentUrl;
        break;
      }
    }
    // Fallback: pick the last entry's attachmentUrl regardless of type
    if (!attachmentUrl) {
      const last = messages[messages.length - 1];
      if (last?.attachmentUrl) attachmentUrl = last.attachmentUrl;
    }
  }

  if (!attachmentUrl) {
    throw new Error('[audioTranscriptionService] No audio attachmentUrl found in metadata.incomingMessages');
  }

  // Meta CDN URLs are short-lived and may require the page access token as a query param
  // (they usually embed it). Fetch the binary directly.
  let headers = {};
  const connId = interaction.platformConnection?._id || interaction.platformConnection;
  if (connId) {
    try {
      const connection = await PlatformConnection.findById(connId).select('accessToken').lean();
      if (connection?.accessToken) {
        headers['Authorization'] = `Bearer ${connection.accessToken}`;
      }
    } catch (e) {
      svcLogger.warn('[audioTranscriptionService] Could not load Meta connection for Authorization header', {
        connId: String(connId),
        error: e.message
      });
    }
  }

  const response = await axios.get(attachmentUrl, {
    headers,
    responseType: 'arraybuffer',
    timeout: 30000
  });

  const buffer = Buffer.from(response.data);
  const mimeType = response.headers['content-type'] || 'audio/mpeg';
  return { buffer, mimeType };
}

module.exports = {
  isAudioInteraction,
  resolveAudioBuffer,
  transcribeInteractionAudio
};
