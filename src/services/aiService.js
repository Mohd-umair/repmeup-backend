/**
 * AI Service — Backward-compatible facade.
 *
 * Originally a 2,178-line god object; now a thin pass-through to focused
 * modules under services/ai/. The public method shape and singleton properties
 * are preserved so the 14 caller files (controllers, jobs, services, routes)
 * don't need to change.
 *
 * Internal modules (do NOT import this file from them — risk of a cycle):
 *   utils/openaiModelHelpers.js                 — pure model/field helpers
 *   services/ai/openaiClient.js                 — OpenAI HTTP wrapper + usage logging
 *   services/ai/sentimentService.js             — analyzeSentiment / fallbackSentimentAnalysis
 *   services/ai/intentClassificationService.js  — detectIntent / classifyIntoBucket / analyzeInteraction / extractTopics / resolveIntentBucketWithoutAi
 *   services/ai/knowledgeBaseSearchService.js   — searchKnowledgeBase
 *   services/ai/brandContextService.js          — getBrandContext / getVisualStyleContext / getReferenceOnlyContext
 *   services/ai/postGenerationService.js        — generatePost / generatePostVariants / generateEventPost
 *   services/ai/imageGenerationService.js       — generateImage
 *   services/ai/videoGenerationService.js       — generateVideo
 *   services/ai/replyGenerationService.js       — generateResponse / generateResponseOpenAI / generateText
 *   services/ai/autoReplyService.js             — generateAutoReply / canAutoReply / shouldQueueImmediateAutoReply
 *
 * NEW CALLERS: import the specific service module directly. This facade exists
 * solely for backward compatibility with existing call sites.
 */

const openaiClient = require('./ai/openaiClient');
const sentimentService = require('./ai/sentimentService');
const intentClassificationService = require('./ai/intentClassificationService');
const knowledgeBaseSearchService = require('./ai/knowledgeBaseSearchService');
const brandContextService = require('./ai/brandContextService');
const videoGenerationService = require('./ai/videoGenerationService');
const imageGenerationService = require('./ai/imageGenerationService');
const postGenerationService = require('./ai/postGenerationService');
const replyGenerationService = require('./ai/replyGenerationService');
const autoReplyService = require('./ai/autoReplyService');

class AIService {
  constructor() {
    // ── Singleton properties exposed for backward-compat ──────────────────────
    // Several callers (controllers/diagnostics/services) read these fields directly.
    // They are mirrors of openaiClient state — DO NOT mutate; treat as read-only.
    this.openaiApiKey = openaiClient.apiKey;
    this.openaiApiUrl = openaiClient.url;
    this.openaiModel = openaiClient.chatModel;
    this.classificationModel = openaiClient.classificationModel;
    this.visionModel = openaiClient.visionModel;
    this.provider = openaiClient.provider;
    // Note: openaiClient logs the startup banner itself; nothing more to do here.
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Low-level OpenAI client (delegates to services/ai/openaiClient.js).
  // Kept as instance methods because some controllers call
  //   aiService._postChatCompletions(...)
  // directly. New code should import `openaiClient` and call `chatCompletion`.
  // ────────────────────────────────────────────────────────────────────────────

  _mergeAiLogContext(overrides = {}) {
    return openaiClient._mergeAiLogContext(overrides);
  }

  async _postChatCompletions(requestBody, logOverrides = {}, axiosConfig = {}) {
    return openaiClient.chatCompletion(requestBody, logOverrides, axiosConfig);
  }

  _logImageUsage(model, size, quality, prompt = '', apiUsage = null) {
    return openaiClient.logImageUsage(model, size, quality, prompt, apiUsage);
  }

  _logVideoUsage(model, durationSeconds) {
    return openaiClient.logVideoUsage(model, durationSeconds);
  }

  _knowledgeBaseReplyFilter(organizationId) {
    return knowledgeBaseSearchService.knowledgeBaseReplyFilter(organizationId);
  }

  /** @see services/ai/knowledgeBaseSearchService.js#searchKnowledgeBase */
  async searchKnowledgeBase(organizationId, query, limit = 5) {
    return knowledgeBaseSearchService.searchKnowledgeBase(organizationId, query, limit);
  }

  /** @see services/ai/postGenerationService.js#generatePost */
  async generatePost(prompt, platforms, mode = 'same', postType = 'post', organizationId = null) {
    return postGenerationService.generatePost(prompt, platforms, mode, postType, organizationId);
  }

  /** @see services/ai/postGenerationService.js#generatePostVariants */
  async generatePostVariants(prompt, platforms, options = {}) {
    return postGenerationService.generatePostVariants(prompt, platforms, options);
  }

  /** @see services/ai/postGenerationService.js#generateEventPost */
  async generateEventPost(opts) {
    return postGenerationService.generateEventPost(opts);
  }

  /** @see services/ai/brandContextService.js#getBrandContext */
  async _getBrandContext(organizationId) {
    return brandContextService.getBrandContext(organizationId);
  }

  /** @see services/ai/brandContextService.js#getVisualStyleContext */
  async _getVisualStyleContext(organizationId) {
    return brandContextService.getVisualStyleContext(organizationId);
  }

  /** @see services/ai/brandContextService.js#getReferenceOnlyContext */
  async _getReferenceOnlyContext(organizationId) {
    return brandContextService.getReferenceOnlyContext(organizationId);
  }

  // ── Backward-compat shims for the old private helpers ────────────────────
  // These were never on the public API but a small handful of tests / inline
  // callers may still reach for them. Delegate to the post service internals.

  async _generateSinglePost(prompt, platforms, postType, brandContext = null) {
    return postGenerationService._internal.generateSinglePost(prompt, platforms, postType, brandContext);
  }

  async _generateSinglePostWithTemperature(systemPrompt, userPrompt, temperature = 0.8) {
    return postGenerationService._internal.generateSinglePostWithTemperature(systemPrompt, userPrompt, temperature);
  }

  _buildPostVariantSystemPrompt(platforms, postType, brandContext, occasionContext = null) {
    return postGenerationService._internal.buildPostVariantSystemPrompt(platforms, postType, brandContext, occasionContext);
  }

  _getPlatformGuidelines(platforms, postType) {
    return postGenerationService._internal.getPlatformGuidelines(platforms, postType);
  }

  _tempTokenConfig(temp, max) {
    return postGenerationService._internal.tempTokenConfig(temp, max);
  }

  /** @see services/ai/imageGenerationService.js#isTransientImageGenError */
  _isTransientImageGenError(error) {
    return imageGenerationService.isTransientImageGenError(error);
  }

  /** @see services/ai/imageGenerationService.js#generateImage */
  async generateImage(prompt, organizationId = null, options = {}) {
    return imageGenerationService.generateImage(prompt, organizationId, options);
  }

  /** @see services/ai/videoGenerationService.js#generateVideo */
  async generateVideo(prompt, options = {}) {
    return videoGenerationService.generateVideo(prompt, options);
  }

  /** @see services/ai/sentimentService.js#analyzeSentiment */
  async analyzeSentiment(content) {
    return sentimentService.analyzeSentiment(content);
  }

  /** @see services/ai/sentimentService.js#fallbackSentimentAnalysis */
  fallbackSentimentAnalysis(content) {
    return sentimentService.fallbackSentimentAnalysis(content);
  }

  /** @see services/ai/replyGenerationService.js#generateResponseOpenAI */
  async generateResponseOpenAI(interaction, organizationId = null, knowledgeBase = null, options = {}) {
    return replyGenerationService.generateResponseOpenAI(interaction, organizationId, knowledgeBase, options);
  }

  /** @see services/ai/replyGenerationService.js#generateResponse */
  async generateResponse(interaction, organizationId = null, knowledgeBase = null) {
    return replyGenerationService.generateResponse(interaction, organizationId, knowledgeBase);
  }

  /** @see services/ai/replyGenerationService.js#generateText */
  async generateText(systemPrompt, userPrompt, options = {}) {
    return replyGenerationService.generateText(systemPrompt, userPrompt, options);
  }

  /** @see services/ai/intentClassificationService.js#detectIntent */
  async detectIntent(content) {
    return intentClassificationService.detectIntent(content);
  }

  /** @see services/ai/intentClassificationService.js#classifyIntoBucket */
  async classifyIntoBucket(content, buckets) {
    return intentClassificationService.classifyIntoBucket(content, buckets);
  }

  /** @see services/ai/intentClassificationService.js#analyzeInteraction */
  async analyzeInteraction(content, buckets = []) {
    return intentClassificationService.analyzeInteraction(content, buckets);
  }

  /** @see services/ai/intentClassificationService.js#resolveIntentBucketWithoutAi */
  resolveIntentBucketWithoutAi(content, buckets = []) {
    return intentClassificationService.resolveIntentBucketWithoutAi(content, buckets);
  }

  /** @see services/ai/intentClassificationService.js#extractTopics */
  async extractTopics(content) {
    return intentClassificationService.extractTopics(content);
  }

  /** @see services/ai/autoReplyService.js#shouldQueueImmediateAutoReply */
  shouldQueueImmediateAutoReply(interaction, organizationDoc) {
    return autoReplyService.shouldQueueImmediateAutoReply(interaction, organizationDoc);
  }

  /** @see services/ai/autoReplyService.js#canAutoReply */
  async canAutoReply(interaction, organizationSettings = {}) {
    return autoReplyService.canAutoReply(interaction, organizationSettings);
  }

  /** @see services/ai/autoReplyService.js#generateAutoReply */
  async generateAutoReply(interaction, organizationId, organizationSettings = {}) {
    return autoReplyService.generateAutoReply(interaction, organizationId, organizationSettings);
  }

  /** @see services/ai/openaiClient.js#transcribeAudio */
  async transcribeAudio(audioBuffer, mimeType) {
    return openaiClient.transcribeAudio(audioBuffer, mimeType);
  }

  // ── Backward-compat shims for the old private helpers ────────────────────
  _normalizePlatformList(list) {
    return autoReplyService._internal.normalizePlatformList(list);
  }

  _hasKnownSentiment(interaction) {
    return autoReplyService._internal.hasKnownSentiment(interaction);
  }
}


module.exports = new AIService();

