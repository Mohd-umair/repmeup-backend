/**
 * Heuristic USD estimates for OpenAI usage. Override with env for your contracted rates.
 * Not a substitute for invoices — use for internal dashboards only.
 */

function parseUsdPerMillion(envVal, defaultVal) {
  const n = parseFloat(envVal);
  return Number.isFinite(n) ? n : defaultVal;
}

function getChatPricingUsdPer1M() {
  return {
    input: parseUsdPerMillion(process.env.OPENAI_USD_PER_1M_INPUT, 2),
    output: parseUsdPerMillion(process.env.OPENAI_USD_PER_1M_OUTPUT, 10)
  };
}

/**
 * @param {string} [_model] reserved for per-model tables
 * @param {number} promptTokens
 * @param {number} completionTokens
 */
function estimateChatUsd(_model, promptTokens, completionTokens) {
  const { input, output } = getChatPricingUsdPer1M();
  const pt = Math.max(0, Number(promptTokens) || 0);
  const ct = Math.max(0, Number(completionTokens) || 0);
  return (pt / 1e6) * input + (ct / 1e6) * output;
}

function estimateImageUsd(size = '1024x1024', quality = 'medium') {
  const q = (quality || 'medium').toLowerCase();
  const key = `${size}|${q}`;
  const envMap = {
    '1024x1024|medium': process.env.OPENAI_IMAGE_USD_MEDIUM_1024,
    '1024x1024|high': process.env.OPENAI_IMAGE_USD_HIGH_1024,
    '1024x1536|high': process.env.OPENAI_IMAGE_USD_HIGH_PORTRAIT
  };
  const raw = envMap[key] || process.env.OPENAI_IMAGE_USD_ESTIMATE;
  if (raw != null && raw !== '') {
    const n = parseFloat(raw);
    if (Number.isFinite(n)) return n;
  }
  if (q === 'high') return 0.167;
  if (q === 'low') return 0.011;
  return 0.042; // medium
}

/**
 * Calculate actual USD cost from token counts returned by gpt-image-1.
 * gpt-image-1 pricing: $5/1M text input, $10/1M image input, $40/1M output (image) tokens.
 * Falls back to flat-rate estimate if tokens are not available.
 * @param {number} inputTextTokens
 * @param {number} inputImageTokens
 * @param {number} outputTokens
 * @param {string} size
 * @param {string} quality
 */
function estimateImageUsdFromTokens(inputTextTokens, inputImageTokens, outputTokens, size, quality) {
  const iText = Math.max(0, Number(inputTextTokens) || 0);
  const iImg  = Math.max(0, Number(inputImageTokens) || 0);
  const oTok  = Math.max(0, Number(outputTokens) || 0);
  if (iText === 0 && iImg === 0 && oTok === 0) {
    return estimateImageUsd(size, quality); // fall back to flat rate
  }
  const usdPerMInputText  = parseUsdPerMillion(process.env.OPENAI_IMAGE_USD_PER_1M_INPUT_TEXT,   5.0);
  const usdPerMInputImage = parseUsdPerMillion(process.env.OPENAI_IMAGE_USD_PER_1M_INPUT_IMAGE,  10.0);
  const usdPerMOutput     = parseUsdPerMillion(process.env.OPENAI_IMAGE_USD_PER_1M_OUTPUT,       40.0);
  return (iText / 1e6) * usdPerMInputText + (iImg / 1e6) * usdPerMInputImage + (oTok / 1e6) * usdPerMOutput;
}

function estimateVideoUsd(durationSeconds = 4) {
  const raw = process.env.OPENAI_VIDEO_USD_PER_CLIP;
  if (raw != null && raw !== '') {
    const n = parseFloat(raw);
    if (Number.isFinite(n)) return n;
  }
  const d = Math.max(1, Number(durationSeconds) || 4);
  return 0.15 * (d / 4);
}

module.exports = {
  getChatPricingUsdPer1M,
  estimateChatUsd,
  estimateImageUsd,
  estimateImageUsdFromTokens,
  estimateVideoUsd
};
