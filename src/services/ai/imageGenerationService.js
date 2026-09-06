/**
 * Image Generation Service (OpenAI Images API)
 *
 * Routes between two endpoints based on whether reference images are present:
 *   - /v1/images/edits        when referenceOnly mode and the org has reference images
 *   - /v1/images/generations  for standard text-only generation
 *
 * Brand context layering (in priority order, lowest to highest in the prompt):
 *   1. Visual style description (referenceOnly: full styleSpec; otherwise summary)
 *   2. Top-3 high-performing past styles (Design Memory phase 3, referenceOnly only)
 *   3. Base prompt (caller-supplied)
 *   4. Occasion visual style override (highest brand priority)
 *   5. Hard-enforcement suffix on text quality (always last)
 *
 * Network resilience:
 *   - Up to OPENAI_IMAGE_MAX_RETRIES attempts (1..5, default 3) with exponential backoff
 *   - Only retries on transient errors (5xx, 429, network/timeout)
 *   - Returns null on terminal failure rather than throwing — callers fall back to no-image posts
 *
 * Returns: { buffer: Buffer, styleSpec: object|null, imagePrompt: string } | null
 */

const axios = require('axios');
const logger = require('../../config/logger');
const openaiClient = require('./openaiClient');
const brandContextService = require('./brandContextService');

const IMAGE_GEN_URL = 'https://api.openai.com/v1/images/generations';
const IMAGE_EDIT_URL = 'https://api.openai.com/v1/images/edits';

const DEFAULT_SIZE = '1024x1024';
// gpt-image-1 only supports these three sizes — map the Shoot Brief's
// platform aspect ratio to the closest one rather than exposing raw pixel
// dimensions to the frontend.
const ASPECT_RATIO_TO_SIZE = {
  '1:1': '1024x1024',
  '4:5': '1024x1536',
  '9:16': '1024x1536',
  '16:9': '1536x1024'
};
const DEFAULT_QUALITY = 'medium';
const DEFAULT_MAX_RETRIES = 3;
const MIN_MAX_RETRIES = 1;
const MAX_MAX_RETRIES = 5;
const DEFAULT_TIMEOUT_MS = 120000;
const MIN_TIMEOUT_MS = 60000;
const MAX_TIMEOUT_MS = 300000;
const URL_DOWNLOAD_TIMEOUT_MS = 60000;
const MAX_PROMPT_CHARS = 4000;

const TEXT_ENFORCEMENT_SUFFIX =
  '\n\nABSOLUTE RULE — TEXT QUALITY: Any text visible anywhere in the image (on signs, doors, screens, packaging, labels, posters, props, or any surface) MUST be real, meaningful, correctly spelled English words relevant to the post topic. No gibberish. No nonsense words. No random characters. No placeholder text. If the prompt specifies an exact headline, render it exactly. If a brand logo is shown in a reference image, reproduce that exact logo on branded surfaces — never invent a fictional logo. Violation of this rule makes the image completely unusable for professional use.';

const TRANSIENT_HTTP_STATUSES = new Set([429, 502, 503, 504]);
const TRANSIENT_ERROR_CODES = new Set([
  'ECONNRESET', 'ECONNABORTED', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND'
]);
const TRANSIENT_MESSAGE_PARTS = [
  'aborted', 'timeout', 'socket', 'hang up', 'econnreset', 'network'
];

/** @returns {boolean} true if the error is worth retrying. */
function isTransientImageGenError(error) {
  if (TRANSIENT_HTTP_STATUSES.has(error.response?.status)) return true;
  if (error.code && TRANSIENT_ERROR_CODES.has(error.code)) return true;
  const msg = String(error.message || '').toLowerCase();
  return TRANSIENT_MESSAGE_PARTS.some((p) => msg.includes(p));
}

/**
 * Look up the org's brand logo URL (used as the trailing reference image so
 * the model can see and reproduce it on any branded surface in the scene).
 * @returns {Promise<string|null>}
 */
async function fetchOrgLogoUrl(organizationId) {
  if (!organizationId) return null;
  try {
    /**
     * `posts.logo` decides whether the brand logo is placed into generated imagery.
     * Not entitled returns null, exactly like "no logo uploaded" — image generation
     * proceeds unbranded rather than failing. A plan gate should remove the extra,
     * never the whole feature the customer is paying credits for.
     */
    const entitlementsService = require('../entitlementsService');
    const { FEATURE_KEYS } = require('../../config/featureCatalog');
    if (!(await entitlementsService.can(String(organizationId), FEATURE_KEYS.POSTS_LOGO))) {
      return null;
    }

    const Organization = require('../../models/Organization');
    const org = await Organization.findById(organizationId).select('logo').lean();
    return org?.logo || null;
  } catch (_) {
    return null; // non-blocking
  }
}

/**
 * Append top-performing past styles (Design Memory phase 3) to the prompt as
 * inspiration. Returns the original prompt unchanged on any failure.
 */
async function appendTopStylesContext(basePrompt, organizationId) {
  try {
    const designMemoryService = require('../designMemoryService');
    const topStyles = await designMemoryService.getTopStyleSpecs(organizationId, 3);
    if (!topStyles?.length) return basePrompt;

    const topStyleLines = topStyles
      .filter((s) => s.layoutType || (s.colors && s.colors.length))
      .map((s, i) => {
        const parts = [];
        if (s.layoutType) parts.push(`layout: ${s.layoutType}`);
        if (s.colors?.length) parts.push(`colors: ${s.colors.join(', ')}`);
        if (s.style) parts.push(`style: ${s.style}`);
        if (s.medium) parts.push(`medium: ${s.medium}`);
        return `  ${i + 1}. ${parts.join(', ')} (engagement score: ${s.designScore || 0})`;
      });

    if (!topStyleLines.length) return basePrompt;
    return `${basePrompt}\n\nHigh-performing design patterns for this brand (use as additional inspiration, do not override the main style spec):\n${topStyleLines.join('\n')}`;
  } catch (memErr) {
    logger.warn('Design memory blend failed (non-blocking)', { organizationId, err: memErr.message });
    return basePrompt;
  }
}

const FIDELITY_INSTRUCTIONS = {
  strict: 'STRICT PRODUCT FIDELITY (highest priority): Preserve the exact product from the FIRST reference image — identical logo, packaging text, colors, proportions, materials, and quantity/count. Do NOT redesign, restyle, recolor, or alter the product itself in any way. The product must be immediately recognizable as the exact same item.',
  balanced: 'BALANCED PRODUCT FIDELITY: Keep the product from the FIRST reference image clearly recognizable — same logo, same core colors, same general shape/packaging — but you may adjust its composition, scale, or minor framing to fit the new scene.',
  creative: 'CREATIVE INTERPRETATION: Use the product from the FIRST reference image as creative inspiration. You may reinterpret its presentation, styling, and framing more freely, but keep its brand identity (logo/name) intact.'
};

const SHOOT_FIELD_LABELS = {
  background: {
    white: 'clean pure-white studio background', black: 'deep black studio background',
    gradient: 'smooth studio gradient background', 'lifestyle-scene': 'natural lifestyle environment background',
    outdoor: 'outdoor natural setting', 'textured-surface': 'textured surface backdrop (e.g. marble, wood, fabric)',
    'brand-color': "background using the brand's primary color", 'match-reference': 'background matching the style reference image(s)'
  },
  lighting: {
    'soft-studio': 'soft even studio lighting', dramatic: 'dramatic directional lighting with strong shadows',
    'natural-daylight': 'natural daylight', 'golden-hour': 'warm golden-hour lighting',
    'high-key': 'bright high-key lighting, minimal shadows', 'low-key': 'moody low-key lighting, deep shadows'
  },
  cameraAngle: {
    front: 'straight-on front angle', 'three-quarter': 'three-quarter angle',
    'top-down': 'top-down overhead angle', 'close-up': 'tight close-up macro angle', 'wide-shot': 'wide establishing shot'
  },
  placement: {
    centered: 'centered in frame', 'off-center': 'off-center, rule-of-thirds placement',
    floating: 'floating/levitating presentation', 'on-surface': 'resting on a surface',
    'in-hand': 'held in a hand'
  }
};

/**
 * Distinct camera stations around the product. Each variant MUST land on a
 * different station so a 3-variant request does not burn 3 credits on the
 * same front catalog shot.
 */
const PRODUCT_SHOOT_ORBIT = [
  { degrees: 0, elevation: 'eye-level', framing: 'front-facing hero catalog shot of the product face' },
  { degrees: 90, elevation: 'slightly above eye-level', framing: 'right-side profile of the product' },
  { degrees: 180, elevation: 'eye-level', framing: 'rear view showing the back of the product' },
  { degrees: 270, elevation: 'slightly above eye-level', framing: 'left-side profile of the product' },
  { degrees: 45, elevation: 'eye-level', framing: 'front-right three-quarter view' },
  { degrees: 135, elevation: 'slightly low', framing: 'back-right three-quarter view' },
  { degrees: 225, elevation: 'eye-level', framing: 'back-left three-quarter view' },
  { degrees: 315, elevation: 'slightly above', framing: 'front-left three-quarter view' }
];

function resolveProductShootOrbit(variantIndex = 0) {
  const idx = Number.isInteger(variantIndex) && variantIndex >= 0 ? variantIndex : 0;
  return PRODUCT_SHOOT_ORBIT[idx % PRODUCT_SHOOT_ORBIT.length];
}

/**
 * Build the role-aware prompt block for a Product Shoot generation.
 * Distinguishes "preserve this exact product" from "borrow visual style
 * only" — the #1 gap in the previous undifferentiated reference pool (see
 * plan "Make AI generation deterministic, safe, and fidelity-aware").
 */
function buildProductShootPromptBlock({ hasProduct, styleCount, fidelityMode, shootConfig = {}, variantIndex = 0 }) {
  const lines = [];
  let refIndex = 1;

  if (hasProduct) {
    lines.push(`Reference image ${refIndex}: the EXACT PRODUCT to feature in this shoot.`);
    lines.push(FIDELITY_INSTRUCTIONS[fidelityMode] || FIDELITY_INSTRUCTIONS.strict);
    refIndex += 1;
  }
  if (styleCount > 0) {
    const range = styleCount === 1 ? `Reference image ${refIndex}` : `Reference images ${refIndex}-${refIndex + styleCount - 1}`;
    lines.push(`${range}: STYLE INSPIRATION ONLY (background, mood, lighting, composition) — do NOT copy any product/object shown in these into the scene, only borrow their visual style.`);
  }

  const orbit = resolveProductShootOrbit(variantIndex);
  lines.push(
    `360-DEGREE PRODUCT PHOTOSHOOT — this image is ONE unique camera station on a full orbit around the same product. ` +
    `Station ${variantIndex + 1}: ${orbit.degrees}° azimuth, ${orbit.elevation}, ${orbit.framing}. ` +
    `Keep the exact same product, lighting, and background. ONLY the camera position around the product changes. ` +
    `Do NOT repeat a front-on catalog shot unless this station is 0°. This variant MUST be visually distinct from other orbit stations.`
  );

  const shootParts = [];
  if (shootConfig.background) shootParts.push(SHOOT_FIELD_LABELS.background[shootConfig.background]);
  if (shootConfig.lighting) shootParts.push(SHOOT_FIELD_LABELS.lighting[shootConfig.lighting]);
  if (shootConfig.cameraAngle) shootParts.push(`preferred framing ${SHOOT_FIELD_LABELS.cameraAngle[shootConfig.cameraAngle]} (orbit station above overrides the viewing angle)`);
  if (shootConfig.placement) shootParts.push(`product ${SHOOT_FIELD_LABELS.placement[shootConfig.placement]}`);
  if (shootParts.length) lines.push(`Shoot direction: ${shootParts.filter(Boolean).join(', ')}.`);

  lines.push(shootConfig.includePeople
    ? 'Include people naturally interacting with or near the product — diverse, authentic, candid.'
    : 'Do NOT include any people, faces, or human figures in the image — product-only shot.');

  if (shootConfig.textSafeZone) {
    lines.push('Leave a clean, low-detail margin/safe zone suitable for overlaying caption text — do not place the product or busy detail in that margin.');
  }
  if (shootConfig.customInstructions) {
    lines.push(`Additional creative direction: ${shootConfig.customInstructions}`);
  }

  return lines.join('\n');
}

/** Build the occasion-style block. Returns '' if nothing applies. */
function buildOccasionStyleBlock(occasionVisualStyle) {
  if (!occasionVisualStyle) return '';
  const ov = occasionVisualStyle;
  const parts = [];
  if (ov.dominantColors?.length) parts.push(`Dominant colors: ${ov.dominantColors.join(', ')}.`);
  if (ov.mood) parts.push(`Visual mood: ${ov.mood}.`);
  if (ov.layoutPattern) parts.push(`Layout: ${ov.layoutPattern}.`);
  if (ov.typography) parts.push(`Typography: ${ov.typography}.`);
  if (ov.decorativeElements?.length) parts.push(`Decorative elements: ${ov.decorativeElements.join(', ')}.`);
  return parts.length ? `\n\nOccasion visual style (highest priority): ${parts.join(' ')}` : '';
}

/**
 * Assemble the full prompt with brand + style + occasion + enforcement layers.
 * Returns { imagePrompt, referenceImageUrls, capturedStyleSpec }.
 */
async function assembleImagePrompt(prompt, organizationId, options) {
  let basePrompt = typeof prompt === 'string' && prompt.length > 0
    ? prompt
    : 'Professional social media post image, modern, high quality';

  let referenceImageUrls = [];
  let capturedStyleSpec = null;

  const orgLogoUrl = await fetchOrgLogoUrl(organizationId);
  if (orgLogoUrl) {
    basePrompt += `\n\nBRAND LOGO: The last reference image is the organisation's official logo. If any branded surface appears in the scene (signs, screens, packaging, walls), reproduce this exact logo visually — copy its colours, shape, and lettering precisely from the reference. Do not invent or alter the logo.`;
  }

  if (options.productShoot) {
    // Role-aware path: caller has already resolved exact product/style
    // image URLs (see brandContextService.resolveProductShootReferences) —
    // do NOT fall back to the org's undifferentiated top-N reference pool.
    const { productImageUrl, styleImageUrls = [], fidelityMode = 'strict', shootConfig = {}, variantIndex = 0 } = options.productShoot;
    const shootBlock = buildProductShootPromptBlock({
      hasProduct: !!productImageUrl,
      styleCount: styleImageUrls.length,
      fidelityMode,
      shootConfig,
      variantIndex
    });
    basePrompt = `${shootBlock}\n\n${basePrompt}`;
    referenceImageUrls = [
      ...(productImageUrl ? [productImageUrl] : []),
      ...styleImageUrls
    ];
  } else if (organizationId) {
    if (options.referenceOnly) {
      const refCtx = await brandContextService.getReferenceOnlyContext(organizationId);
      if (refCtx.stylePrompt) basePrompt = `${refCtx.stylePrompt}\n\n${basePrompt}`;
      if (refCtx.imageUrls?.length) referenceImageUrls = refCtx.imageUrls;
      if (refCtx.styleSpec) capturedStyleSpec = refCtx.styleSpec;
      basePrompt = await appendTopStylesContext(basePrompt, organizationId);
    } else {
      const visualCtx = await brandContextService.getVisualStyleContext(organizationId);
      if (visualCtx) basePrompt = `${visualCtx}\n\n${basePrompt}`;
    }
  }

  basePrompt += buildOccasionStyleBlock(options.occasionVisualStyle);

  if (orgLogoUrl && !referenceImageUrls.includes(orgLogoUrl)) {
    referenceImageUrls = [...referenceImageUrls, orgLogoUrl];
  }

  const imagePrompt = (basePrompt + TEXT_ENFORCEMENT_SUFFIX).substring(0, MAX_PROMPT_CHARS);
  return { imagePrompt, referenceImageUrls, capturedStyleSpec };
}

function clampInt(value, min, max, fallback) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

/**
 * Fetch raw image bytes either from base64 in the API response or by
 * downloading the returned URL. Returns null if neither is present.
 */
async function extractImageBuffer(responseData) {
  const b64 = responseData?.data?.[0]?.b64_json;
  if (b64) return Buffer.from(b64, 'base64');

  const imageUrl = responseData?.data?.[0]?.url;
  if (!imageUrl) return null;

  const imgResponse = await axios.get(imageUrl, {
    responseType: 'arraybuffer',
    timeout: URL_DOWNLOAD_TIMEOUT_MS,
    maxContentLength: Infinity
  });
  return Buffer.from(imgResponse.data);
}

/**
 * Generate an image via OpenAI Image API.
 *
 * @param {string} prompt - Description of the image to generate
 * @param {string|null} [organizationId] - If provided, brand visual style is layered in
 * @param {object} [options]
 * @param {boolean} [options.referenceOnly]      - Use /images/edits with reference images
 * @param {object}  [options.occasionVisualStyle] - Highest-priority visual override
 * @param {object}  [options.productShoot]        - Role-aware product-shoot mode (takes priority over referenceOnly/brand-voice context)
 * @param {string|null} [options.productShoot.productImageUrl] - exact product to preserve (sent as reference image 1)
 * @param {string[]}    [options.productShoot.styleImageUrls]  - up to 3 style-only reference images
 * @param {string}      [options.productShoot.fidelityMode]    - 'strict' | 'balanced' | 'creative'
 * @param {object}      [options.productShoot.shootConfig]     - background/lighting/cameraAngle/placement/includePeople/textSafeZone/customInstructions
 * @param {number}      [options.productShoot.variantIndex]    - drives the 360° orbit station so variants are not identical
 * @returns {Promise<{buffer: Buffer, styleSpec: object|null, imagePrompt: string}|null>}
 */
async function generateImage(prompt, organizationId = null, options = {}) {
  if (!openaiClient.hasApiKey()) return null;

  const { imagePrompt, referenceImageUrls, capturedStyleSpec } = await assembleImagePrompt(
    prompt, organizationId, options
  );

  const model = process.env.OPENAI_IMAGE_MODEL || 'gpt-image-1';
  const requestedRatio = options.productShoot?.shootConfig?.aspectRatio;
  const size = ASPECT_RATIO_TO_SIZE[requestedRatio] || DEFAULT_SIZE;
  const quality = DEFAULT_QUALITY;
  const maxAttempts = clampInt(process.env.OPENAI_IMAGE_MAX_RETRIES, MIN_MAX_RETRIES, MAX_MAX_RETRIES, DEFAULT_MAX_RETRIES);
  const imageTimeout = clampInt(process.env.OPENAI_IMAGE_TIMEOUT_MS, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);

  const useEditsEndpoint = referenceImageUrls.length > 0;
  const endpoint = useEditsEndpoint ? IMAGE_EDIT_URL : IMAGE_GEN_URL;

  const requestBody = useEditsEndpoint
    ? {
      model,
      prompt: imagePrompt,
      images: referenceImageUrls.map((url) => ({ image_url: url })),
      n: 1,
      size,
      quality
    }
    : { model, prompt: imagePrompt, n: 1, size, quality };

  const axiosConfig = {
    headers: {
      Authorization: `Bearer ${openaiClient.apiKey}`,
      'Content-Type': 'application/json'
    },
    timeout: imageTimeout,
    maxContentLength: Infinity,
    maxBodyLength: Infinity
  };

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      if (useEditsEndpoint) {
        logger.info('[AI Image] Using /images/edits', { references: referenceImageUrls.length });
      }
      const response = await axios.post(endpoint, requestBody, axiosConfig);
      const apiUsage = response.data?.usage || null;
      const buffer = await extractImageBuffer(response.data);
      if (!buffer) return null;

      openaiClient.logImageUsage(model, size, quality, imagePrompt, apiUsage);
      return { buffer, styleSpec: capturedStyleSpec, imagePrompt };
    } catch (error) {
      const status = error.response?.status;
      const data = error.response?.data;
      const transient = isTransientImageGenError(error);
      const willRetry = transient && attempt < maxAttempts;

      logger.warn('AI image generation failed', {
        attempt,
        maxAttempts,
        endpoint: useEditsEndpoint ? '/images/edits' : '/images/generations',
        error: error.message,
        code: error.code,
        status,
        openaiError: data?.error?.message || data?.message,
        willRetry
      });

      if (willRetry) {
        const delayMs = Math.min(2000 * 2 ** (attempt - 1), 16000);
        await new Promise((r) => setTimeout(r, delayMs));
        continue;
      }
      return null;
    }
  }
  return null;
}

module.exports = {
  generateImage,
  isTransientImageGenError,
  resolveProductShootOrbit,
  PRODUCT_SHOOT_ORBIT
};
