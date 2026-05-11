/**
 * OpenAI Chat Completions HTTP client.
 *
 * Owns:
 *   - The API key, base URL, and configured model ids (chat / classification / vision)
 *   - The single shared axios call to /v1/chat/completions
 *   - Non-blocking token-usage logging into AiApiUsage
 *
 * This is the only place in the codebase that should talk to OpenAI's chat
 * completions endpoint directly. Other services should go through this client
 * so that token usage, error logging, and timeouts are consistent.
 */

const axios = require('axios');
const FormData = require('form-data');
const aiApiUsageService = require('../aiApiUsageService');
const logger = require('../../config/logger');
const { getAiRequestContext } = require('../aiRequestContext');
const {
  normalizeOpenAIModelId,
  completionTextFromOpenAIResponse
} = require('../../utils/openaiModelHelpers');

const DEFAULT_TIMEOUT_MS = 30000;
const OPENAI_CHAT_URL = 'https://api.openai.com/v1/chat/completions';
const OPENAI_TRANSCRIPTION_URL = 'https://api.openai.com/v1/audio/transcriptions';

/** Map common audio mime types to an appropriate file extension for the Whisper upload. */
function mimeToExtension(mimeType) {
  const map = {
    'audio/ogg': 'ogg',
    'audio/ogg; codecs=opus': 'ogg',
    'audio/mpeg': 'mp3',
    'audio/mp4': 'mp4',
    'audio/mp4a-latm': 'm4a',
    'audio/webm': 'webm',
    'audio/webm; codecs=opus': 'webm',
    'audio/wav': 'wav',
    'audio/x-wav': 'wav',
    'audio/flac': 'flac',
    'audio/x-m4a': 'm4a',
    'audio/aac': 'mp4',
  };
  const base = (mimeType || '').split(';')[0].trim().toLowerCase();
  return map[base] || map[mimeType] || 'ogg';
}

class OpenAIClient {
  constructor() {
    this.apiKey = process.env.OPENAI_API_KEY;
    this.url = OPENAI_CHAT_URL;
    this.chatModel = normalizeOpenAIModelId(process.env.OPENAI_MODEL);
    // Cheaper model for classification-only tasks (sentiment, intent, topics, bucket).
    this.classificationModel = normalizeOpenAIModelId(
      process.env.OPENAI_CLASSIFICATION_MODEL || 'gpt-4o-mini'
    );
    // Vision-capable model. The primary chat model (gpt-5.3-chat-latest) does NOT
    // support image_url content, so vision tasks always go through this one.
    this.visionModel = normalizeOpenAIModelId(
      process.env.OPENAI_VISION_MODEL || 'gpt-4o'
    );

    this.provider = 'openai';

    if (process.env.AI_PROVIDER && process.env.AI_PROVIDER.toLowerCase() === 'ollama') {
      logger.warn('AI_PROVIDER=ollama is no longer supported; OpenAI only. Set OPENAI_API_KEY.');
    }

    if (this.apiKey && this.apiKey.trim() !== '') {
      logger.info('🤖 AI Provider: OPENAI', {
        chatModel: this.chatModel,
        classificationModel: this.classificationModel,
        visionModel: this.visionModel
      });
    } else {
      logger.warn('AI Service: OPENAI_API_KEY is not set — AI features will fail until configured.');
    }
  }

  /** True iff a usable API key is configured. */
  hasApiKey() {
    return !!(this.apiKey && this.apiKey.trim() !== '');
  }

  /**
   * Merge per-call log overrides with the request's AsyncLocalStorage AI context
   * so that token usage records always carry organizationId/userId/feature.
   */
  _mergeAiLogContext(overrides = {}) {
    const store = getAiRequestContext();
    return {
      organizationId: overrides.organizationId !== undefined ? overrides.organizationId : store.organizationId,
      userId: overrides.userId !== undefined ? overrides.userId : store.userId,
      feature: overrides.feature || store.feature || 'unknown',
      metadata: overrides.metadata || {}
    };
  }

  /**
   * POST to /v1/chat/completions with token usage persisted to AiApiUsage (non-blocking).
   *
   * @param {object} requestBody  - OpenAI request body (must include `model` or one will be defaulted)
   * @param {object} [logOverrides]  - { organizationId, userId, feature, metadata } overrides
   * @param {object} [axiosConfig]  - extra axios config (e.g. { timeout: 45000 })
   * @returns {Promise<import('axios').AxiosResponse>}
   */
  async chatCompletion(requestBody, logOverrides = {}, axiosConfig = {}) {
    const ctx = this._mergeAiLogContext(logOverrides);
    const defaultAxios = {
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json'
      },
      timeout: DEFAULT_TIMEOUT_MS
    };
    const response = await axios.post(this.url, requestBody, { ...defaultAxios, ...axiosConfig });
    const usage = response.data?.usage;
    if (usage) {
      const completionText = completionTextFromOpenAIResponse(response.data);
      aiApiUsageService.recordChatUsage({
        organizationId: ctx.organizationId,
        userId: ctx.userId,
        feature: ctx.feature,
        model: requestBody.model || this.chatModel,
        promptTokens: usage.prompt_tokens,
        completionTokens: usage.completion_tokens,
        totalTokens: usage.total_tokens,
        promptMessages: requestBody.messages,
        completionText,
        metadata: ctx.metadata
      });
    }
    return response;
  }

  /** Record image generation token usage. Non-blocking. */
  logImageUsage(model, size, quality, prompt = '', apiUsage = null) {
    const ctx = this._mergeAiLogContext({});
    const usage = apiUsage || {};
    const inputTokensDetails = usage.input_tokens_details || {};
    aiApiUsageService.recordImageUsage({
      organizationId: ctx.organizationId,
      userId: ctx.userId,
      feature: ctx.feature || 'image.generation',
      model,
      size,
      quality,
      promptTokens: Number(usage.input_tokens) || 0,
      inputTextTokens: Number(inputTokensDetails.text_tokens) || 0,
      inputImageTokens: Number(inputTokensDetails.image_tokens) || 0,
      completionTokens: Number(usage.output_tokens) || 0,
      totalTokens: Number(usage.total_tokens) || 0,
      metadata: { prompt: prompt ? String(prompt).substring(0, 3000) : '' }
    });
  }

  /**
   * Transcribe an audio buffer using OpenAI Whisper (whisper-1).
   *
   * @param {Buffer} audioBuffer  - Raw audio binary
   * @param {string} mimeType     - MIME type of the audio (e.g. 'audio/ogg', 'audio/mpeg')
   * @returns {Promise<string>}   - Transcription text
   */
  async transcribeAudio(audioBuffer, mimeType) {
    if (!this.apiKey || !this.apiKey.trim()) {
      throw new Error('OPENAI_API_KEY is not configured — cannot transcribe audio');
    }
    const ext = mimeToExtension(mimeType);
    const form = new FormData();
    form.append('file', audioBuffer, { filename: `audio.${ext}`, contentType: mimeType || 'audio/ogg' });
    form.append('model', 'whisper-1');

    const response = await axios.post(OPENAI_TRANSCRIPTION_URL, form, {
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        ...form.getHeaders()
      },
      timeout: 60000
    });

    const text = response.data?.text;
    if (typeof text !== 'string') {
      throw new Error('Whisper API returned no transcription text');
    }
    return text.trim();
  }

  /** Record video generation usage. Non-blocking. */
  logVideoUsage(model, durationSeconds) {
    const ctx = this._mergeAiLogContext({});
    aiApiUsageService.recordVideoUsage({
      organizationId: ctx.organizationId,
      userId: ctx.userId,
      feature: ctx.feature || 'video.generation',
      model,
      durationSeconds,
      metadata: {}
    });
  }
}

module.exports = new OpenAIClient();
