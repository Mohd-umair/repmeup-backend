/**
 * Brand Context Service
 *
 * Three context builders feed brand voice + visual style into AI prompts:
 *   - getBrandContext(orgId)         → text-prompt brand-tone block (tone, banned words, hashtags…)
 *   - getVisualStyleContext(orgId)   → text block describing colors/typography/composition for image gen
 *   - getReferenceOnlyContext(orgId) → Vision API analysis of up to 3 reference images,
 *                                       cached on BrandConfig.styleCache for 24h
 *
 * All three return null/empty objects on missing data — callers should be tolerant.
 */

const axios = require('axios');
const crypto = require('crypto');
const BrandConfig = require('../../models/BrandConfig');
const BrandReferenceImage = require('../../models/BrandReferenceImage');
const logger = require('../../config/logger');
const openaiClient = require('./openaiClient');
const brandProfileSourceService = require('../brandProfileSourceService');
const { topClusteredColors } = require('../../utils/colorClustering');

const STYLE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
// Bump when the vision style prompt template changes — forces cache invalidation.
const STYLE_PROMPT_VERSION = 'v2-no-text';

/**
 * Build the brand-tone block injected into TEXT generation prompts.
 */
async function getBrandContext(organizationId) {
  if (!organizationId) return null;
  try {
    const [config, activeConnectionIds] = await Promise.all([
      BrandConfig.findOne({ organization: organizationId }).lean(),
      brandProfileSourceService.getActiveConnectionIds(organizationId)
    ]);
    if (!config) return null;

    const parts = [];
    parts.push(`Brand tone: ${config.toneOfVoice || 'professional'}.`);
    if (config.personalityTags?.length > 0) {
      parts.push(`Brand personality: ${config.personalityTags.join(', ')}.`);
    }
    if (config.bannedWords?.length > 0) {
      parts.push(`Never use these words: ${config.bannedWords.join(', ')}.`);
    }
    if (config.approvedHashtags?.length > 0) {
      parts.push(`Prefer these hashtags when relevant: ${config.approvedHashtags.join(', ')}.`);
    }
    if (config.legalDisclaimers && config.legalDisclaimers.trim()) {
      parts.push(`Include this disclaimer when relevant: ${config.legalDisclaimers.trim()}`);
    }

    const bp = config.brandProfile;
    const ov = config.brandProfileOverrides || {};
    if (brandProfileSourceService.isProfileCurrent(bp, activeConnectionIds)) {
      const ws = ov.writingStyle || bp.writingStyle;
      if (ws) parts.push(`Writing style: ${ws}.`);
      const eu = ov.emojiUsage || bp.emojiUsage;
      if (eu && eu !== 'moderate') parts.push(`Emoji usage: ${eu}.`);
      const re = ov.recurringEmojis || bp.recurringEmojis;
      if (re?.length) parts.push(`Frequently uses emojis: ${re.join(', ')}.`);
      const pd = ov.personalityDescriptors || bp.personalityDescriptors;
      if (pd?.length) parts.push(`Brand character: ${pd.join(', ')}.`);
      const hs = ov.hashtagStrategy || bp.hashtagStrategy;
      if (hs?.avgCount) {
        // Only inject the COUNT as a style guideline.
        // Specific branded/generic hashtags from analysis become stale (e.g. campaign tags from old posts).
        // The user controls which hashtags to use via the manual "Approved Hashtags" field above.
        parts.push(`Hashtag count: use approximately ${hs.avgCount} hashtags per post.`);
      }
      const cta = ov.ctaStyle || bp.ctaStyle;
      if (cta?.length) parts.push(`CTA style: ${cta.join(', ')}.`);
      const im = ov.imageMood || bp.imageMood;
      if (im) parts.push(`Visual mood: ${im}.`);
      const cp = ov.colorPalette || bp.colorPalette;
      if (cp?.length) parts.push(`Color palette: ${cp.join(', ')}.`);
    }

    return parts.length ? parts.join(' ') : null;
  } catch (err) {
    logger.warn('Brand context fetch failed', { organizationId, err: err.message });
    return null;
  }
}

/**
 * Build a visual style block for IMAGE generation prompts.
 * Combines BrandConfig.brandProfile visual fields with aggregated reference image analysis.
 */
async function getVisualStyleContext(organizationId) {
  if (!organizationId) return null;
  try {
    const [config, refImages, activeConnectionIds] = await Promise.all([
      BrandConfig.findOne({ organization: organizationId }).select('brandProfile brandProfileOverrides').lean(),
      BrandReferenceImage.find({ organization: organizationId, analysis: { $ne: null } }).limit(20).lean(),
      brandProfileSourceService.getActiveConnectionIds(organizationId)
    ]);

    const profileIsCurrent = brandProfileSourceService.isProfileCurrent(
      config?.brandProfile,
      activeConnectionIds
    );
    const bp = profileIsCurrent ? config.brandProfile : null;
    const ov = profileIsCurrent ? (config.brandProfileOverrides || {}) : {};
    const parts = [];

    const palette = ov.colorPalette || bp?.colorPalette;
    if (palette?.length) parts.push(`Color palette: ${palette.join(', ')}`);

    const comp = ov.visualComposition || bp?.visualComposition;
    if (comp) parts.push(`Composition: ${comp}`);

    const typo = ov.typographyStyle || bp?.typographyStyle;
    if (typo) parts.push(`Typography: ${typo}`);

    const mood = ov.imageMood || bp?.imageMood;
    if (mood) parts.push(`Mood: ${mood}`);

    const logo = ov.logoPlacement || bp?.logoPlacement;
    if (logo && logo !== 'none detected') parts.push(`Logo: ${logo}`);

    if (refImages.length) {
      const colorFreq = {};
      const compFreq = {};
      const moodFreq = {};
      for (const ri of refImages) {
        const a = ri.analysis;
        (a.dominantColors || []).forEach((c) => { colorFreq[c] = (colorFreq[c] || 0) + 1; });
        if (a.compositionType) compFreq[a.compositionType] = (compFreq[a.compositionType] || 0) + 1;
        if (a.mood) moodFreq[a.mood] = (moodFreq[a.mood] || 0) + 1;
      }
      if (!palette?.length) {
        // Perceptual clustering, not raw exact-hex frequency — see
        // colorClustering.js for why exact-string counting loses real
        // deep/accent tones across multiple analyzed images.
        const topColors = topClusteredColors(colorFreq, { limit: 5 });
        if (topColors.length) parts.push(`Reference colors: ${topColors.join(', ')}`);
      }
      const topComp = Object.entries(compFreq).sort((a, b) => b[1] - a[1])[0]?.[0];
      if (topComp && !comp) parts.push(`Reference composition: ${topComp}`);
      const topMood = Object.entries(moodFreq).sort((a, b) => b[1] - a[1])[0]?.[0];
      if (topMood && !mood) parts.push(`Reference mood: ${topMood}`);
    }

    if (!parts.length) return null;
    return `Visual style requirements (follow strictly):\n- ${parts.join('\n- ')}`;
  } catch (err) {
    logger.warn('Visual style context fetch failed', { organizationId, err: err.message });
    return null;
  }
}

/**
 * Use GPT-4o Vision to analyze up to 3 reference images and produce a detailed
 * style specification. Result is cached on BrandConfig.styleCache for 24h and
 * invalidated when reference images change (Design Memory Phase 1).
 */
async function getReferenceOnlyContext(organizationId) {
  if (!organizationId) return { stylePrompt: null, imageUrls: [], styleSpec: null };
  try {
    // Sort must match brandReferenceImageController.list (the grid the user
    // actually sees/curates: { sortOrder: 1, createdAt: -1 }). Previously this
    // sorted by createdAt only, so the "first 2" images shown in the Brand
    // Hub grid were NOT necessarily the 2 images the Vision API analyzed for
    // style — uploading a newer image silently swapped which images drove
    // generation, with no way for the user to see or control that from the UI.
    const refImages = await BrandReferenceImage
      .find({ organization: organizationId, imageUrl: { $exists: true, $ne: '' } })
      .sort({ sortOrder: 1, createdAt: -1 })
      .limit(5)
      .lean();

    if (!refImages.length) return { stylePrompt: null, imageUrls: [], styleSpec: null };

    // Pass top-2 raw URLs to /v1/images/edits.
    const imageUrls = refImages.slice(0, 2).map((ri) => ri.imageUrl);

    // ── Style cache check ────────────────────────────────────────────────────
    const imageUrlsHash = crypto
      .createHash('md5')
      .update(imageUrls.join('|') + STYLE_PROMPT_VERSION)
      .digest('hex');
    const brandConfig = await BrandConfig.findOne({ organization: organizationId }).lean();
    const cache = brandConfig?.styleCache;
    const cacheValid = cache?.spec
      && cache.imageUrlsHash === imageUrlsHash
      && cache.analyzedAt
      && (Date.now() - new Date(cache.analyzedAt).getTime()) < STYLE_CACHE_TTL_MS;

    if (cacheValid) {
      logger.info('Style cache HIT — skipping Vision API call', { organizationId });
      return { stylePrompt: cache.spec, imageUrls, styleSpec: null };
    }
    logger.info('Style cache MISS — running Vision analysis', { organizationId });

    // Download up to 3 images and convert to base64 data URLs for vision input.
    const imageContents = [];
    for (const ri of refImages.slice(0, 3)) {
      try {
        const resp = await axios.get(ri.imageUrl, { responseType: 'arraybuffer', timeout: 15000 });
        const mime = resp.headers['content-type'] || 'image/jpeg';
        const b64 = Buffer.from(resp.data).toString('base64');
        // 'high' (was 'low') so the model sees full resolution — low detail
        // downsamples the image and was why colorPalette extraction only
        // ever returned the single largest/darkest block of color instead
        // of the full palette including secondary/accent tones.
        imageContents.push({
          type: 'image_url',
          image_url: { url: `data:${mime};base64,${b64}`, detail: 'high' }
        });
      } catch (dlErr) {
        logger.warn('Reference image download for vision analysis failed', {
          url: ri.imageUrl?.substring(0, 100),
          err: dlErr.message
        });
      }
    }

    if (!imageContents.length) return { stylePrompt: null, imageUrls };

    const visionPrompt = `You are a design system analyst. Analyze these ${imageContents.length} brand reference image(s) and produce a PRECISE style specification that another AI image generator must follow to create NEW images in the EXACT same visual style.

Respond with ONLY this JSON (no markdown, no explanation):
{
  "medium": "graphic design" or "photography" or "illustration" or "3d render" or "mixed media",
  "style": "describe the overall design style in 5-10 words, e.g. premium modern corporate, playful cartoon infographic, bold flat vector",
  "colorPalette": ["exact color 1", "exact color 2", ...5-8 total — sample background, subject, accents, AND shadow/highlight tones separately; do not reduce a dark image to just black/near-black, extract the real secondary and accent hues too, with precise hex values],
  "gradients": "describe any gradient usage or 'none'",
  "background": "describe background treatment precisely, e.g. solid purple, gradient orange-to-yellow, textured dark, soft blur photo",
  "layout": "describe the spatial arrangement: centered, split panel, grid, asymmetric, etc.",
  "typography": "describe text style: bold sans-serif headings, thin elegant, bubble letters, hand-drawn, etc.",
  "textPlacement": "where text appears: top, center overlay, bottom banner, scattered, etc.",
  "illustrationStyle": "if illustrations exist: flat vector, cartoon characters, isometric, line art, realistic, 3d icons, etc. or 'none'",
  "iconography": "describe any icons/emojis/badges used, or 'none'",
  "decorativeElements": "describe borders, shapes, patterns, stickers, ribbons, sparkles, etc. or 'none'",
  "peopleUsage": "how people appear: cartoon characters, photo cutouts, illustrated, silhouettes, or 'none'",
  "mood": "emotional tone: professional, playful, energetic, minimal, luxurious, fun, educational, etc.",
  "spacing": "dense and packed, moderate, clean with whitespace, etc.",
  "brandElements": "any visible logos, watermarks, brand marks, or 'none'",
  "overallImpression": "1-2 sentence summary of how the final output should look — be very specific"
}`;

    const response = await openaiClient.chatCompletion(
      {
        model: openaiClient.visionModel,
        messages: [
          { role: 'system', content: visionPrompt },
          {
            role: 'user',
            content: [
              { type: 'text', text: `Analyze these ${imageContents.length} brand reference image(s) and extract the precise visual style specification.` },
              ...imageContents
            ]
          }
        ],
        max_tokens: 800
      },
      { feature: 'content_studio.reference_style_analysis' },
      { timeout: 45000 }
    );

    const text = response.data?.choices?.[0]?.message?.content;
    if (!text) return { stylePrompt: null, imageUrls, styleSpec: null };

    let styleSpec;
    try {
      let cleaned = text.trim();
      const m = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (m) cleaned = m[1].trim();
      styleSpec = JSON.parse(cleaned);
    } catch {
      logger.warn('Vision style spec parse failed, using raw text', { text: text.substring(0, 200) });
      return {
        stylePrompt: `STYLE SPECIFICATION from reference images (follow exactly):\n${text.substring(0, 1200)}`,
        imageUrls,
        styleSpec: null
      };
    }

    const lines = [
      'CRITICAL — You MUST replicate this EXACT visual style. Reference images are attached — match them precisely.',
      '',
      `Medium: ${styleSpec.medium || 'graphic design'} — if "graphic design" or "illustration", do NOT generate photography.`,
      `Style: ${styleSpec.style || 'professional marketing creative'}`,
      `Color palette: ${Array.isArray(styleSpec.colorPalette) ? styleSpec.colorPalette.join(', ') : styleSpec.colorPalette || 'brand colors'}`
    ];
    if (styleSpec.gradients && styleSpec.gradients !== 'none') lines.push(`Gradients: ${styleSpec.gradients}`);
    lines.push(`Background: ${styleSpec.background || 'match reference'}`);
    lines.push(`Layout: ${styleSpec.layout || 'centered'}`);
    lines.push(`Typography: ${styleSpec.typography || 'bold modern'}`);
    if (styleSpec.textPlacement) lines.push(`Text placement: ${styleSpec.textPlacement}`);
    if (styleSpec.illustrationStyle && styleSpec.illustrationStyle !== 'none') {
      lines.push(`Illustration style: ${styleSpec.illustrationStyle}`);
    }
    if (styleSpec.iconography && styleSpec.iconography !== 'none') lines.push(`Icons: ${styleSpec.iconography}`);
    if (styleSpec.decorativeElements && styleSpec.decorativeElements !== 'none') {
      lines.push(`Decorative elements: ${styleSpec.decorativeElements}`);
    }
    if (styleSpec.peopleUsage && styleSpec.peopleUsage !== 'none') {
      lines.push(`People style: ${styleSpec.peopleUsage}`);
    }
    lines.push(`Mood: ${styleSpec.mood || 'professional'}`);
    lines.push(`Spacing: ${styleSpec.spacing || 'balanced'}`);
    if (styleSpec.brandElements && styleSpec.brandElements !== 'none') {
      lines.push(`Brand elements: ${styleSpec.brandElements}`);
    }
    lines.push('');
    lines.push(`OVERALL: ${styleSpec.overallImpression || 'Match the exact look and feel of the brand reference images.'}`);
    lines.push('');
    lines.push('STRICT INSTRUCTIONS:');
    lines.push('- The generated design MUST closely match the attached reference images');
    lines.push('- Maintain visual consistency: same color scheme, same layout patterns, same illustration style');
    lines.push('- Do NOT introduce new visual styles or deviate from the references');
    lines.push('- Keep layout, spacing, and typography similar to the references');
    lines.push('- CRITICAL TEXT RULE: Any text visible in the image (on signs, doors, laptop screens, product packaging, posters, props, or any surface) MUST be real, meaningful English words relevant to the post topic. No gibberish, no nonsense words, no random characters, no placeholder text under any circumstance. If a brand logo appears on any surface, render the exact logo provided in the reference images — never invent a fictional logo or brand name.');

    const stylePrompt = lines.join('\n');

    // ── Save to style cache (non-blocking) ───────────────────────────────────
    BrandConfig.updateOne(
      { organization: organizationId },
      { $set: { styleCache: { spec: stylePrompt, analyzedAt: new Date(), imageUrlsHash } } },
      { upsert: false }
    ).catch((err) => logger.warn('Style cache save failed (non-blocking)', { organizationId, err: err.message }));

    return { stylePrompt, imageUrls, styleSpec };
  } catch (err) {
    logger.warn('Reference-only context (vision) failed', { organizationId, err: err.message });
    return { stylePrompt: null, imageUrls: [], styleSpec: null };
  }
}

/**
 * Error thrown by `resolveProductShootReferences` when a requested reference
 * cannot be resolved (missing, expired, or belongs to another organization).
 * Kept as a plain tagged Error (not a class import cycle) so callers in
 * `postAiGenerationService` can check `err.code === 'REFERENCE_NOT_FOUND'`.
 */
function referenceNotFoundError(message) {
  const err = new Error(message);
  err.code = 'REFERENCE_NOT_FOUND';
  return err;
}

/**
 * Resolve the exact product + style images for one Product Shoot generation
 * request. Unlike `getReferenceOnlyContext` (which always uses the org's
 * top-N curated references as an undifferentiated style pool), this gives
 * the caller full control over WHICH image is the product to preserve and
 * WHICH images are style-only inspiration — see plan "Separate product
 * identity from visual style".
 *
 * Every ID is re-resolved from the DB scoped to the caller's organization
 * (and, for ephemeral uploads, the requesting user) — a client-supplied
 * imageUrl is never trusted directly.
 *
 * @param {string} organizationId
 * @param {string} userId
 * @param {object} refs
 * @param {string} [refs.productReferenceImageId] - BrandReferenceImage._id (mutually exclusive with inputImageId)
 * @param {string} [refs.inputImageId] - GenerationInputImage._id (ephemeral upload, mutually exclusive with productReferenceImageId)
 * @param {string[]} [refs.styleReferenceImageIds] - up to 3 BrandReferenceImage._id
 * @returns {Promise<{ productImageUrl: string|null, styleImageUrls: string[] }>}
 */
async function resolveProductShootReferences(organizationId, userId, refs = {}) {
  const { productReferenceImageId, inputImageId, styleReferenceImageIds = [] } = refs;
  let productImageUrl = null;

  if (productReferenceImageId && inputImageId) {
    throw referenceNotFoundError('Provide either productReferenceImageId or inputImageId, not both');
  }

  if (productReferenceImageId) {
    const doc = await BrandReferenceImage.findOne({ _id: productReferenceImageId, organization: organizationId }).lean();
    if (!doc) throw referenceNotFoundError('Selected product reference image was not found');
    productImageUrl = doc.imageUrl;
  } else if (inputImageId) {
    const GenerationInputImage = require('../../models/GenerationInputImage');
    const doc = await GenerationInputImage.findOne({
      _id: inputImageId,
      organization: organizationId,
      user: userId
    }).lean();
    if (!doc) throw referenceNotFoundError('Uploaded product image was not found or does not belong to you');
    if (doc.expiresAt && doc.expiresAt.getTime() < Date.now()) {
      throw referenceNotFoundError('Uploaded product image has expired — please re-upload it');
    }
    productImageUrl = doc.imageUrl;
  }

  let styleImageUrls = [];
  if (Array.isArray(styleReferenceImageIds) && styleReferenceImageIds.length) {
    const capped = styleReferenceImageIds.slice(0, 3);
    const docs = await BrandReferenceImage.find({
      _id: { $in: capped },
      organization: organizationId
    }).select('_id imageUrl').lean();
    const byId = new Map(docs.map((d) => [String(d._id), d.imageUrl]));
    // Preserve caller-specified order rather than Mongo's $in result order.
    styleImageUrls = capped.map((id) => byId.get(String(id))).filter(Boolean);
    if (styleImageUrls.length !== capped.length) {
      throw referenceNotFoundError('One or more selected style reference images were not found');
    }
  }

  return { productImageUrl, styleImageUrls };
}

module.exports = {
  getBrandContext,
  getVisualStyleContext,
  getReferenceOnlyContext,
  resolveProductShootReferences
};
