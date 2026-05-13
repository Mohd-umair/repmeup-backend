'use strict';

/**
 * OpenAI fallback for the Voice IVR. Used when Sarvam errors or is not configured.
 * Mirrors the surface of sarvamService.js so callers can swap providers with a flag.
 *
 *   transcribe → Whisper (audio.transcriptions)
 *   synthesize → TTS-1
 *   chat       → gpt-4o-mini (tools-capable)
 */

const axios = require('axios');
const FormData = require('form-data');
const logger = require('../../config/logger');

const svcLogger = logger.createChild({ module: 'openaiVoiceService' });
const OPENAI_BASE = 'https://api.openai.com/v1';

function authHeader(apiKey) {
  return { Authorization: `Bearer ${apiKey}` };
}

async function transcribe({ audioBuffer, apiKey, language = null }) {
  if (!apiKey) throw new Error('OpenAI API key missing');
  if (!Buffer.isBuffer(audioBuffer) || audioBuffer.length === 0) {
    return { transcript: '', languageDetected: null };
  }
  const form = new FormData();
  form.append('file', audioBuffer, { filename: 'audio.wav', contentType: 'audio/wav' });
  form.append('model', 'whisper-1');
  if (language) form.append('language', language.split('-')[0]);
  try {
    const response = await axios.post(`${OPENAI_BASE}/audio/transcriptions`, form, {
      headers: { ...form.getHeaders(), ...authHeader(apiKey) },
      timeout: 30000,
      maxBodyLength: Infinity
    });
    return {
      transcript: String(response.data?.text || '').trim(),
      languageDetected: language || null
    };
  } catch (err) {
    svcLogger.warn('OpenAI STT failed', { error: err.response?.data?.error?.message || err.message });
    throw err;
  }
}

async function synthesize({ text, apiKey, voiceId = 'alloy' }) {
  if (!apiKey) throw new Error('OpenAI API key missing');
  if (!text || !text.trim()) return Buffer.alloc(0);
  try {
    const response = await axios.post(
      `${OPENAI_BASE}/audio/speech`,
      { model: 'tts-1', voice: voiceId, input: text, response_format: 'wav' },
      {
        headers: { ...authHeader(apiKey), 'Content-Type': 'application/json' },
        responseType: 'arraybuffer',
        timeout: 30000
      }
    );
    return Buffer.from(response.data);
  } catch (err) {
    svcLogger.warn('OpenAI TTS failed', { error: err.response?.data?.error?.message || err.message });
    throw err;
  }
}

async function chat({ messages, apiKey, tools, model = 'gpt-4o-mini' }) {
  if (!apiKey) throw new Error('OpenAI API key missing');
  try {
    const body = { model, messages, temperature: 0.4, max_tokens: 400 };
    if (Array.isArray(tools) && tools.length) body.tools = tools;
    const response = await axios.post(`${OPENAI_BASE}/chat/completions`, body, {
      headers: { ...authHeader(apiKey), 'Content-Type': 'application/json' },
      timeout: 30000
    });
    const choice = response.data?.choices?.[0]?.message || {};
    return {
      content: choice.content || '',
      tool_calls: Array.isArray(choice.tool_calls) ? choice.tool_calls : null
    };
  } catch (err) {
    svcLogger.warn('OpenAI chat failed', { error: err.response?.data?.error?.message || err.message });
    throw err;
  }
}

module.exports = { transcribe, synthesize, chat };
