'use strict';

/**
 * Sarvam AI integration for the Voice IVR.
 * https://docs.sarvam.ai
 *
 * Endpoints used:
 *   POST https://api.sarvam.ai/speech-to-text-translate (or /speech-to-text)
 *   POST https://api.sarvam.ai/text-to-speech
 *   POST https://api.sarvam.ai/v1/chat/completions  (Sarvam-M / Saarika)
 *
 * Auth: `api-subscription-key: <key>` header.
 */

const axios = require('axios');
const FormData = require('form-data');
const logger = require('../../config/logger');

const svcLogger = logger.createChild({ module: 'sarvamService' });

const SARVAM_BASE_URL = 'https://api.sarvam.ai';

/** @param {string} apiKey */
function authHeaders(apiKey) {
  return {
    'api-subscription-key': apiKey
  };
}

/**
 * Speech-to-Text — Sarvam Saarika model.
 * @param {object} p
 * @param {Buffer} p.audioBuffer 16 kHz mono WAV
 * @param {string} p.apiKey
 * @param {string} [p.language='unknown'] ISO BCP-47 code (e.g. 'en-IN', 'hi-IN') or 'unknown' for auto-detect
 * @param {string} [p.model='saarika:v2']
 * @returns {Promise<{ transcript: string, languageDetected: string|null }>}
 */
async function transcribe({ audioBuffer, apiKey, language = 'unknown', model = 'saarika:v2' }) {
  if (!apiKey) throw new Error('Sarvam API key missing');
  if (!Buffer.isBuffer(audioBuffer) || audioBuffer.length === 0) {
    return { transcript: '', languageDetected: null };
  }
  const form = new FormData();
  form.append('file', audioBuffer, { filename: 'audio.wav', contentType: 'audio/wav' });
  form.append('model', model);
  form.append('language_code', language);

  try {
    const response = await axios.post(`${SARVAM_BASE_URL}/speech-to-text`, form, {
      headers: { ...form.getHeaders(), ...authHeaders(apiKey) },
      timeout: 30000,
      maxBodyLength: Infinity
    });
    const data = response.data || {};
    return {
      transcript: String(data.transcript || data.text || '').trim(),
      languageDetected: data.language_code || data.language || null
    };
  } catch (err) {
    const apiMsg = err.response?.data?.error?.message || err.response?.data?.detail || err.message;
    svcLogger.warn('Sarvam STT failed', { error: apiMsg, status: err.response?.status });
    const e = new Error(apiMsg);
    e.statusCode = err.response?.status || 500;
    throw e;
  }
}

/**
 * Text-to-Speech — Sarvam Bulbul model. Returns mulaw 8 kHz audio (Twilio format).
 *
 * @param {object} p
 * @param {string} p.text
 * @param {string} p.apiKey
 * @param {string} [p.voiceId='meera']
 * @param {string} [p.language='en-IN']
 * @param {string} [p.model='bulbul:v1']
 * @returns {Promise<Buffer>} Audio bytes (the gateway converts to mulaw 8 kHz with ffmpeg)
 */
async function synthesize({ text, apiKey, voiceId = 'meera', language = 'en-IN', model = 'bulbul:v1' }) {
  if (!apiKey) throw new Error('Sarvam API key missing');
  if (!text || !text.trim()) return Buffer.alloc(0);
  try {
    const response = await axios.post(
      `${SARVAM_BASE_URL}/text-to-speech`,
      {
        inputs: [text],
        target_language_code: language,
        speaker: voiceId,
        model,
        speech_sample_rate: 8000,
        enable_preprocessing: true
      },
      {
        headers: { ...authHeaders(apiKey), 'Content-Type': 'application/json' },
        timeout: 30000,
        responseType: 'json'
      }
    );
    const audios = response.data?.audios || [];
    if (!audios.length) return Buffer.alloc(0);
    // Sarvam returns base64-encoded WAV; the gateway converts to mulaw via ffmpeg.
    return Buffer.from(audios[0], 'base64');
  } catch (err) {
    const apiMsg = err.response?.data?.error?.message || err.response?.data?.detail || err.message;
    svcLogger.warn('Sarvam TTS failed', { error: apiMsg, status: err.response?.status });
    const e = new Error(apiMsg);
    e.statusCode = err.response?.status || 500;
    throw e;
  }
}

/**
 * Sarvam chat completions (Sarvam-M, OpenAI-compatible).
 *
 * @param {object} p
 * @param {Array<{role:'system'|'user'|'assistant'|'tool', content:string, tool_calls?: any}>} p.messages
 * @param {string} p.apiKey
 * @param {Array<object>} [p.tools] OpenAI tools format
 * @param {string} [p.model='sarvam-m']
 * @returns {Promise<{ content: string, tool_calls: any[]|null }>}
 */
async function chat({ messages, apiKey, tools, model = 'sarvam-m' }) {
  if (!apiKey) throw new Error('Sarvam API key missing');
  try {
    const body = {
      model,
      messages,
      temperature: 0.4,
      max_tokens: 400
    };
    if (Array.isArray(tools) && tools.length) body.tools = tools;

    const response = await axios.post(
      `${SARVAM_BASE_URL}/v1/chat/completions`,
      body,
      {
        headers: { ...authHeaders(apiKey), 'Content-Type': 'application/json' },
        timeout: 30000
      }
    );
    const choice = response.data?.choices?.[0]?.message || {};
    return {
      content: choice.content || '',
      tool_calls: Array.isArray(choice.tool_calls) ? choice.tool_calls : null
    };
  } catch (err) {
    const apiMsg = err.response?.data?.error?.message || err.response?.data?.detail || err.message;
    svcLogger.warn('Sarvam chat failed', { error: apiMsg, status: err.response?.status });
    const e = new Error(apiMsg);
    e.statusCode = err.response?.status || 500;
    throw e;
  }
}

module.exports = {
  transcribe,
  synthesize,
  chat
};
