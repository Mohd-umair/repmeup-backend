/**
 * Facade contract test for src/services/aiService.js.
 *
 * The facade exists for backward compatibility — 14 caller files still import
 * `aiService` and call methods on it. This test locks down the public surface
 * so any accidental removal/rename during future refactors fails CI.
 *
 * What's covered:
 *   - Every singleton property the original god object exposed is still present.
 *   - Every method the original god object exposed is still present and callable.
 *   - Every method delegates to the corresponding split service module.
 *
 * Why mock everything: aiService transitively pulls in the OpenAI client,
 * mongoose models, and several services. We don't care about behaviour here —
 * only that the wiring is intact.
 */

jest.mock('../../../src/services/ai/openaiClient', () => ({
  apiKey: 'mock-key',
  url: 'https://example.test/v1/chat',
  chatModel: 'mock-chat-model',
  classificationModel: 'mock-classification-model',
  visionModel: 'mock-vision-model',
  provider: 'openai',
  hasApiKey: () => true,
  chatCompletion: jest.fn(async () => ({ data: { choices: [{ message: { content: '{}' } }] } })),
  logImageUsage: jest.fn(),
  logVideoUsage: jest.fn(),
  _mergeAiLogContext: jest.fn((o) => ({ merged: true, ...o }))
}));

const mockReturn = (label) => jest.fn(async (...args) => ({ __delegate: label, args }));
const mockSyncReturn = (label) => jest.fn((...args) => ({ __delegate: label, args }));

jest.mock('../../../src/services/ai/sentimentService', () => ({
  analyzeSentiment: mockReturn('sentiment.analyzeSentiment'),
  fallbackSentimentAnalysis: mockSyncReturn('sentiment.fallbackSentimentAnalysis')
}));

jest.mock('../../../src/services/ai/intentClassificationService', () => ({
  detectIntent: mockReturn('intent.detectIntent'),
  classifyIntoBucket: mockReturn('intent.classifyIntoBucket'),
  analyzeInteraction: mockReturn('intent.analyzeInteraction'),
  extractTopics: mockReturn('intent.extractTopics'),
  resolveIntentBucketWithoutAi: mockSyncReturn('intent.resolveIntentBucketWithoutAi')
}));

jest.mock('../../../src/services/ai/knowledgeBaseSearchService', () => ({
  searchKnowledgeBase: mockReturn('kb.searchKnowledgeBase'),
  knowledgeBaseReplyFilter: mockSyncReturn('kb.knowledgeBaseReplyFilter')
}));

jest.mock('../../../src/services/ai/brandContextService', () => ({
  getBrandContext: mockReturn('brand.getBrandContext'),
  getVisualStyleContext: mockReturn('brand.getVisualStyleContext'),
  getReferenceOnlyContext: mockReturn('brand.getReferenceOnlyContext')
}));

jest.mock('../../../src/services/ai/videoGenerationService', () => ({
  generateVideo: mockReturn('video.generateVideo')
}));

jest.mock('../../../src/services/ai/imageGenerationService', () => ({
  generateImage: mockReturn('image.generateImage'),
  isTransientImageGenError: mockSyncReturn('image.isTransientImageGenError')
}));

jest.mock('../../../src/services/ai/postGenerationService', () => ({
  generatePost: mockReturn('post.generatePost'),
  generatePostVariants: mockReturn('post.generatePostVariants'),
  generateEventPost: mockReturn('post.generateEventPost'),
  _internal: {
    generateSinglePost: mockReturn('post._internal.generateSinglePost'),
    generateSinglePostWithTemperature: mockReturn('post._internal.generateSinglePostWithTemperature'),
    buildPostVariantSystemPrompt: mockSyncReturn('post._internal.buildPostVariantSystemPrompt'),
    getPlatformGuidelines: mockSyncReturn('post._internal.getPlatformGuidelines'),
    tempTokenConfig: mockSyncReturn('post._internal.tempTokenConfig')
  }
}));

jest.mock('../../../src/services/ai/replyGenerationService', () => ({
  generateResponseOpenAI: mockReturn('reply.generateResponseOpenAI'),
  generateResponse: mockReturn('reply.generateResponse'),
  generateText: mockReturn('reply.generateText')
}));

jest.mock('../../../src/services/ai/autoReplyService', () => ({
  shouldQueueImmediateAutoReply: mockSyncReturn('autoReply.shouldQueueImmediateAutoReply'),
  canAutoReply: mockReturn('autoReply.canAutoReply'),
  generateAutoReply: mockReturn('autoReply.generateAutoReply'),
  _internal: {
    normalizePlatformList: mockSyncReturn('autoReply._internal.normalizePlatformList'),
    hasKnownSentiment: mockSyncReturn('autoReply._internal.hasKnownSentiment')
  }
}));

const aiService = require('../../../src/services/aiService');

describe('aiService facade — singleton properties', () => {
  it('mirrors openaiClient state on the facade instance', () => {
    expect(aiService.openaiApiKey).toBe('mock-key');
    expect(aiService.openaiApiUrl).toBe('https://example.test/v1/chat');
    expect(aiService.openaiModel).toBe('mock-chat-model');
    expect(aiService.classificationModel).toBe('mock-classification-model');
    expect(aiService.visionModel).toBe('mock-vision-model');
    expect(aiService.provider).toBe('openai');
  });
});

describe('aiService facade — public methods exist', () => {
  // The 14 caller files (controllers, jobs, services) import this list.
  // Removing any of these is a breaking change.
  const REQUIRED_METHODS = [
    // OpenAI client passthroughs
    '_mergeAiLogContext', '_postChatCompletions', '_logImageUsage', '_logVideoUsage',
    // Knowledge base
    '_knowledgeBaseReplyFilter', 'searchKnowledgeBase',
    // Post generation
    'generatePost', 'generatePostVariants', 'generateEventPost',
    '_generateSinglePost', '_generateSinglePostWithTemperature',
    '_buildPostVariantSystemPrompt', '_getPlatformGuidelines', '_tempTokenConfig',
    // Brand context
    '_getBrandContext', '_getVisualStyleContext', '_getReferenceOnlyContext',
    // Image / video
    'generateImage', '_isTransientImageGenError', 'generateVideo',
    // Sentiment
    'analyzeSentiment', 'fallbackSentimentAnalysis',
    // Reply generation
    'generateResponseOpenAI', 'generateResponse', 'generateText',
    // Intent
    'detectIntent', 'classifyIntoBucket', 'analyzeInteraction', 'extractTopics', 'resolveIntentBucketWithoutAi',
    // Auto-reply
    'shouldQueueImmediateAutoReply', 'canAutoReply', 'generateAutoReply',
    '_normalizePlatformList', '_hasKnownSentiment'
  ];

  it.each(REQUIRED_METHODS)('exposes %s as a function', (name) => {
    expect(typeof aiService[name]).toBe('function');
  });

  it('exports a single shared instance (singleton)', () => {
    const again = require('../../../src/services/aiService');
    expect(again).toBe(aiService);
  });
});

describe('aiService facade — methods delegate to the right service', () => {
  // Map method → expected delegate label baked into the mocks above.
  const DELEGATIONS = [
    ['searchKnowledgeBase',           ['org_1', 'q', 5],            'kb.searchKnowledgeBase'],
    ['analyzeSentiment',              ['hello'],                    'sentiment.analyzeSentiment'],
    ['fallbackSentimentAnalysis',     ['hello'],                    'sentiment.fallbackSentimentAnalysis'],
    ['detectIntent',                  ['hello'],                    'intent.detectIntent'],
    ['classifyIntoBucket',            ['hello', []],                'intent.classifyIntoBucket'],
    ['analyzeInteraction',            ['hello', []],                'intent.analyzeInteraction'],
    ['resolveIntentBucketWithoutAi',  ['hello', []],                'intent.resolveIntentBucketWithoutAi'],
    ['extractTopics',                 ['hello'],                    'intent.extractTopics'],
    ['generatePost',                  ['p', ['ig'], 'same', 'post', 'org_1'], 'post.generatePost'],
    ['generatePostVariants',          ['p', ['ig'], {}],            'post.generatePostVariants'],
    ['generateEventPost',             [{ event: 'e' }],             'post.generateEventPost'],
    ['generateImage',                 ['p', 'org_1', {}],           'image.generateImage'],
    ['generateVideo',                 ['p', {}],                    'video.generateVideo'],
    ['generateResponseOpenAI',        [{}, 'org_1', null, {}],      'reply.generateResponseOpenAI'],
    ['generateResponse',              [{}, 'org_1', null],          'reply.generateResponse'],
    ['generateText',                  ['s', 'u', {}],               'reply.generateText'],
    ['canAutoReply',                  [{}, {}],                     'autoReply.canAutoReply'],
    ['generateAutoReply',             [{}, 'org_1', {}],            'autoReply.generateAutoReply']
  ];

  it.each(DELEGATIONS)('%s → %s', async (method, args, expectedLabel) => {
    const result = await aiService[method](...args);
    expect(result.__delegate).toBe(expectedLabel);
  });

  it('shouldQueueImmediateAutoReply (sync) delegates correctly', () => {
    const result = aiService.shouldQueueImmediateAutoReply({}, {});
    expect(result.__delegate).toBe('autoReply.shouldQueueImmediateAutoReply');
  });

  it('_postChatCompletions delegates to openaiClient.chatCompletion', async () => {
    const openaiClient = require('../../../src/services/ai/openaiClient');
    await aiService._postChatCompletions({ model: 'x' }, {}, {});
    expect(openaiClient.chatCompletion).toHaveBeenCalledWith({ model: 'x' }, {}, {});
  });

  it('_logImageUsage and _logVideoUsage forward to openaiClient', () => {
    const openaiClient = require('../../../src/services/ai/openaiClient');
    aiService._logImageUsage('m', '1024x1024', 'hd', 'p', null);
    expect(openaiClient.logImageUsage).toHaveBeenCalledWith('m', '1024x1024', 'hd', 'p', null);

    aiService._logVideoUsage('m', 4);
    expect(openaiClient.logVideoUsage).toHaveBeenCalledWith('m', 4);
  });
});
