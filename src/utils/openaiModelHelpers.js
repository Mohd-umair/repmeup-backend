/**
 * Pure helpers for working with OpenAI Chat Completion model quirks.
 *
 * Why these exist:
 *   OpenAI ships incompatible API conventions across model families. The "newer"
 *   chat models (gpt-5.x, o1/o3/o4) reject `max_tokens` and require
 *   `max_completion_tokens`, and they refuse custom temperature values. Older
 *   models (gpt-4, gpt-4o) use the old fields. Calling code shouldn't have to
 *   care — it asks these helpers for the correct field names per model.
 */

/** Default model to fall back to when nothing is configured. */
const FALLBACK_MODEL = 'gpt-4';

/** Aliases for short ChatGPT-style names → official Chat Completions model ids. */
const MODEL_ALIASES = Object.freeze({
  'gpt-5.3': 'gpt-5.3-chat-latest',
  'gpt-5-3': 'gpt-5.3-chat-latest',
  'gpt5.3': 'gpt-5.3-chat-latest'
});

/**
 * Normalize model id input.
 *   - empty / null  → fallback model
 *   - aliased name  → official id
 *   - otherwise     → lowercased trimmed value
 */
function normalizeOpenAIModelId(raw) {
  if (raw == null || String(raw).trim() === '') {
    return FALLBACK_MODEL;
  }
  const m = String(raw).trim().toLowerCase();
  return MODEL_ALIASES[m] || m;
}

/**
 * Returns true for "newer" OpenAI chat model families (gpt-5.x, o1, o3, o4)
 * that follow the new request-shape conventions.
 */
function isNewGenerationChatModel(model) {
  const m = (model || '').toLowerCase();
  return /^gpt-5/.test(m) || /^o1/.test(m) || /^o3/.test(m) || /^o4/.test(m);
}

/**
 * Returns the correct max-tokens field for a given model.
 *   { max_completion_tokens: N } for new-gen models
 *   { max_tokens: N } for older models
 */
function openAIChatCompletionMaxTokensField(model, maxValue) {
  if (isNewGenerationChatModel(model)) {
    return { max_completion_tokens: maxValue };
  }
  return { max_tokens: maxValue };
}

/**
 * Some new-gen models only accept the default sampling temperature.
 * Sending a custom value triggers a 400. This returns true for those models.
 */
function openAIChatModelUsesFixedTemperature(model) {
  return isNewGenerationChatModel(model);
}

/**
 * Returns the temperature field for a given model.
 *   {} (omit field) for fixed-temperature models
 *   { temperature: t } otherwise
 */
function openAIChatCompletionTemperatureField(model, temperature) {
  if (openAIChatModelUsesFixedTemperature(model)) {
    return {};
  }
  return { temperature };
}

/**
 * Extract plain text from the first choice of a Chat Completions response.
 * Handles both string content and multimodal content arrays.
 */
function completionTextFromOpenAIResponse(data) {
  const ch = data?.choices?.[0];
  if (!ch) return '';
  const msg = ch.message || ch;
  const c = msg?.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    return c
      .map((part) => {
        if (part && part.type === 'text' && typeof part.text === 'string') return part.text;
        if (typeof part === 'string') return part;
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  if (c != null && typeof c === 'object') {
    try {
      return JSON.stringify(c);
    } catch {
      return String(c);
    }
  }
  return c != null ? String(c) : '';
}

module.exports = {
  normalizeOpenAIModelId,
  openAIChatCompletionMaxTokensField,
  openAIChatModelUsesFixedTemperature,
  openAIChatCompletionTemperatureField,
  completionTextFromOpenAIResponse,
  FALLBACK_MODEL
};
