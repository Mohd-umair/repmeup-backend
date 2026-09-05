const {
  normalizeOpenAIModelId,
  openAIChatCompletionMaxTokensField
} = require('../../../src/utils/openaiModelHelpers');

describe('openaiModelHelpers', () => {
  test('normalizeOpenAIModelId remaps retired gpt-5.3-chat-latest to gpt-5.4', () => {
    expect(normalizeOpenAIModelId('gpt-5.3-chat-latest')).toBe('gpt-5.4');
  });

  test('normalizeOpenAIModelId remaps other gpt-5 *-chat-latest ids', () => {
    expect(normalizeOpenAIModelId('gpt-5.9-chat-latest')).toBe('gpt-5.4');
  });

  test('normalizeOpenAIModelId keeps gpt-5.4', () => {
    expect(normalizeOpenAIModelId('gpt-5.4')).toBe('gpt-5.4');
  });

  test('openAIChatCompletionMaxTokensField uses max_completion_tokens for gpt-5.4', () => {
    expect(openAIChatCompletionMaxTokensField('gpt-5.4', 500)).toEqual({
      max_completion_tokens: 500
    });
  });
});
