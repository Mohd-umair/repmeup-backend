/**
 * Post AI Generation Service
 *
 * All AI-powered post-creation orchestration (text + image + video) used by
 * the Content Studio and /api/posts/generate* endpoints.
 *
 * What lives here
 * ───────────────
 *   1. Pure prompt builders          — sanitizeForImagePrompt, buildImagePrompt, buildVideoPrompt
 *   2. Credit-gated AI orchestrators — generatePostText, generatePostVariants,
 *                                      generateVariantImage, submitVariantVideoJob,
 *                                      getVideoJobStatus
 *   3. Helpers                       — compositeLogo, persistGeneratedMedia,
 *                                      saveMediaLibraryEntry, classifySafetyRejection
 *
 * Error contract
 * ──────────────
 * Orchestrators throw `PostAiGenerationError` with `statusCode` and optional
 * `code`. Controllers translate directly:
 *
 *   catch (e) {
 *     if (e instanceof PostAiGenerationError) {
 *       return res.status(e.statusCode).json({
 *         success: false, code: e.code, message: e.message, ...e.extras
 *       });
 *     }
 *     …
 *   }
 *
 * Credit lifecycle
 * ────────────────
 * Each orchestrator owns the credit-check → run-AI → credit-deduct loop
 * end-to-end. On failure, credits that were deducted are rolled back before
 * the error is rethrown. Controllers never call `aiCreditService` directly.
 */

const Media = require('../models/Media');
const VideoJob = require('../models/VideoJob');
const storageService = require('./storageService');
const aiService = require('./aiService');
const aiCreditService = require('./aiCreditService');
const { runWithAiContextAndUsageId } = require('./aiRequestContext');
const { isProductShootEnabled } = require('../utils/featureFlags');
const logger = require('../config/logger');
const path = require('path');
const fs = require('fs').promises;

// ═══════════════════════════════════════════════════════════════════════════
// Error class — shared contract between service and controller
// ═══════════════════════════════════════════════════════════════════════════
class PostAiGenerationError extends Error {
  /**
   * @param {string} message
   * @param {object} [opts]
   * @param {number} [opts.statusCode=500]  HTTP status the controller should return
   * @param {string} [opts.code]             machine-readable error code for the client
   * @param {object} [opts.extras]           extra fields to merge into the JSON response
   */
  constructor(message, { statusCode = 500, code = null, extras = null } = {}) {
    super(message);
    this.name = 'PostAiGenerationError';
    this.statusCode = statusCode;
    this.code = code;
    this.extras = extras;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. Pure prompt-building utilities
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Known copyrighted / IP-sensitive terms replaced with safe generic alternatives
 * BEFORE sending to DALL-E / Sora. Without this the OpenAI safety system rejects
 * a meaningful fraction of prompts with "content_policy_violation".
 */
const IP_REPLACEMENTS = [
  // Anime / manga
  [/(pokémon|pokemon)\s*characters?/gi,   'animated creatures'],
  [/(pokémon|pokemon)/gi,                 'animated cartoon series'],
  [/(pikachu|charmander|squirtle|bulbasaur|eevee|mewtwo)/gi, 'animated creature'],
  [/(ash\s+ketchum|misty|brock|team\s+rocket)/gi, 'animated series protagonist'],
  [/(goku|vegeta|piccolo|gohan|bulma)/gi, 'anime warrior hero'],
  [/(naruto|sasuke|kakashi|sakura|itachi)/gi, 'anime ninja protagonist'],
  [/(luffy|zoro|nami|sanji|usopp)/gi,    'anime adventure hero'],
  [/(dragon\s*ball(\s*z|\s*super)?)/gi,  'classic anime series'],
  [/(one\s*piece)/gi,                    'anime adventure series'],
  [/(attack\s+on\s+titan|aot)/gi,        'anime action series'],
  [/(fullmetal\s+alchemist)/gi,          'anime series'],
  [/(sailor\s*moon)/gi,                  'magical anime series'],
  [/(death\s+note)/gi,                   'anime thriller series'],
  [/(evangelion|neon\s+genesis)/gi,      'mecha anime series'],
  // Gaming
  [/(mario|luigi|princess\s+peach|bowser|toad)/gi, 'video game character'],
  [/(link|zelda|ganon(dorf)?)/gi,        'fantasy video game hero'],
  [/(sonic\s+the\s+hedgehog|sonic)/gi,   'video game character'],
  [/(master\s+chief|halo)/gi,            'sci-fi video game hero'],
  [/(pac.?man)/gi,                       'arcade game character'],
  // Comics / superheroes
  [/(spider.?man|peter\s+parker)/gi,     'web-slinging superhero'],
  [/(batman|bruce\s+wayne)/gi,           'dark knight superhero'],
  [/(superman|clark\s+kent)/gi,          'caped superhero'],
  [/(iron\s*man|tony\s+stark)/gi,        'armored superhero'],
  [/(captain\s+america|steve\s+rogers)/gi, 'patriotic superhero'],
  [/(thor|loki|avengers)/gi,             'superhero character'],
  [/(wonder\s+woman)/gi,                 'warrior superhero'],
  [/(black\s+panther)/gi,                'superhero character'],
  // Movie / TV franchises
  [/(darth\s+vader|luke\s+skywalker|yoda|obi.?wan|star\s+wars|jedi|sith|the\s+force)/gi, 'sci-fi space hero'],
  [/(harry\s+potter|hermione|ron\s+weasley|dumbledore|voldemort|hogwarts)/gi, 'young wizard protagonist'],
  [/(gandalf|frodo|bilbo|aragorn|sauron|lord\s+of\s+the\s+rings|hobbit)/gi, 'fantasy hero'],
  [/(mickey\s+mouse|minnie\s+mouse|donald\s+duck|goofy)/gi, 'classic cartoon character'],
  [/(simpsons?|homer|bart|marge|lisa)/gi, 'animated sitcom character'],
  [/(shrek|fiona|donkey)/gi,             'animated movie character'],
  // Safety blanket
  [/real\s+person|celebrity|influencer\s+named/gi, 'public figure'],
];

/** Strip emoji / non-printable chars and replace copyrighted IP with safe generics. */
function sanitizeForImagePrompt(text) {
  if (!text) return '';
  let result = text
    .replace(/[#@\n\r]/g, ' ')
    .replace(/[^\x20-\x7E]/g, '')   // non-printable / emoji
    .replace(/\s+/g, ' ')
    .trim();
  for (const [pattern, replacement] of IP_REPLACEMENTS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

/**
 * Build a DALL-E prompt for one content-studio variant.
 * Each variant index rotates through a different variation directive so the
 * resulting set of images is visually distinct.
 *
 * The caption (variantContent) is intentionally NOT included — AI image models
 * distort brand names and unusual words from captions. Caption text is shown
 * outside the image, never rendered inside it.
 */
function buildImagePrompt({ topic, variantContent: _unusedCaption, imageConfig = {}, variantIndex = 0, contentType = '' }) {
  const styleDescriptors = {
    'photorealistic': 'ultra-realistic photography, DSLR quality, sharp 8K detail, no CGI',
    'cinematic':      'cinematic film still, anamorphic lens flare, movie-grade color grading, widescreen',
    'minimalist':     'minimalist design, vast clean white space, geometric simplicity, negative space composition',
    '3d-render':      '3D CGI render, soft ambient occlusion, ray-traced depth of field, product visualization quality',
    'illustration':   'digital illustration, flat design vector art, modern graphic style, clean lines',
    'corporate':      'professional corporate photography, polished business aesthetic, high-end office environment',
    'futuristic':     'futuristic sci-fi concept art, neon light accents, holographic UI elements, cyberpunk aesthetic',
    'vintage':        'vintage retro film photography, analog grain texture, faded warm palette, nostalgic 1970s feel',
    'bold-graphic':   'bold high-contrast graphic poster art, editorial design, strong geometric composition',
    'watercolor':     'soft watercolor painting, visible expressive brushstrokes, artistic paper texture, painterly',
    'dark-moody':     'dark moody noir photography, deep dramatic shadows, chiaroscuro contrast, cinematic atmosphere',
    'pastel-life':    'bright airy lifestyle photography, pastel soft tones, natural golden light, consumer-friendly warmth'
  };

  const variationDirectives = [
    'Hero shot: subject centered prominently, clean uncluttered background, confident direct composition.',
    'Environmental context: subject integrated into relevant setting, rule-of-thirds framing, storytelling depth.',
    'Abstract close-up: tight macro detail of subject, bold foreground crop, abstract artistic interpretation.',
    'Wide establishing shot: expansive scene with subject as part of larger narrative, atmospheric depth.',
    'Dynamic diagonal: subject at striking diagonal angle, energy and motion implied, graphic impact.',
    'Flat lay overhead: bird\'s eye top-down arrangement, organized flat lay aesthetic, product catalog feel.'
  ];

  const styleDesc        = styleDescriptors[imageConfig.style] || 'professional social media photography, high quality';
  const moodPart         = imageConfig.mood         ? `${imageConfig.mood.toLowerCase()} emotional atmosphere` : '';
  const lightingPart     = imageConfig.lighting     ? `${imageConfig.lighting.toLowerCase()} lighting` : '';
  const compositionPart  = imageConfig.composition  ? `${imageConfig.composition.toLowerCase()} composition` : '';
  const palettePart      = imageConfig.colorPalette ? `${imageConfig.colorPalette.toLowerCase()} color palette` : '';
  const anglePart        = imageConfig.cameraAngle  ? `${imageConfig.cameraAngle.toLowerCase()} camera angle` : '';
  const variationNote    = variationDirectives[variantIndex % variationDirectives.length];
  const safeTopic        = sanitizeForImagePrompt(topic.trim()).substring(0, 120);

  const promptParts = [
    styleDesc,
    `Subject: ${safeTopic}`,
    moodPart,
    lightingPart,
    compositionPart,
    palettePart,
    anglePart,
    variationNote,
    contentType === 'image-layover'
      ? `HEADLINE TEXT (render exactly as written, exactly these words): "${safeTopic.split(' ').slice(0, 8).join(' ')}". Bold modern typography, high contrast. No other words or text anywhere else in the image.`
      : 'Do NOT render any brand name, company name, or organisation name as text inside the image — brands are represented by their logo only. Any other text visible (on signs, screens, props) must be real, common English words relevant to the topic.',
    'Ultra high quality, suitable for professional social media post.',
    `seed:${Date.now() % 100000 + variantIndex * 13337}`
  ].filter(Boolean);

  return promptParts.join(', ');
}

/**
 * Build the neutral reference-mode prompt — the visual style is fully
 * controlled by uploaded brand references, so we send only the subject +
 * safety instructions.
 */
function buildReferenceImagePrompt({ topic, variantIndex = 0, contentType = '' }) {
  const safeTopic = sanitizeForImagePrompt(topic.trim()).substring(0, 120);
  const variationDirectives = [
    'Hero composition: subject centered, clean uncluttered background.',
    'Environmental composition: subject in a relevant setting, rule-of-thirds framing.',
    'Abstract close-up: tight crop on distinctive product detail.',
    'Wide establishing shot: subject as part of a larger scene.',
    'Dynamic diagonal: subject at a striking diagonal angle.',
    'Flat lay overhead: bird\'s-eye arrangement of the subject.'
  ];
  const variationNote = variationDirectives[variantIndex % variationDirectives.length];
  return [
    `Social media post about: ${safeTopic}`,
    variationNote,
    contentType === 'image-layover'
      ? `HEADLINE TEXT (render exactly as written, exactly these words): "${safeTopic.split(' ').slice(0, 8).join(' ')}". No other words or text anywhere else in the image.`
      : 'Do NOT render any brand name, company name, or organisation name as text inside the image — brands are represented by their logo only. Any other text visible (on signs, screens, props) must be real, common English words relevant to the topic.',
    'High quality, platform-ready. This variant MUST be visually distinct from other variants of the same topic.',
    `seed:${Date.now() % 100000 + variantIndex * 13337}`
  ].filter(Boolean).join(', ');
}

/** Build a cinematic Sora prompt from a VideoConfig payload. */
function buildVideoPrompt({ topic, variantContent, videoConfig = {}, variantIndex = 0 }) {
  const styleDescriptors = {
    cinematic:   'cinematic short film scene, anamorphic lens, movie-grade color grading, dramatic lighting',
    realistic:   'ultra-realistic live action footage, natural lighting, documentary handheld camera feel',
    animated:    'smooth 3D animation, modern motion graphics, vibrant colors, fluid transitions',
    documentary: 'documentary style footage, authentic real-world setting, journalistic framing',
    energetic:   'fast-paced dynamic edit, quick cuts, high energy motion, bold visual rhythm'
  };

  const toneDescriptors = {
    energetic:    'high-energy, fast-paced, exciting',
    calm:         'calm, serene, slow-motion elegance',
    professional: 'polished, corporate, clean and authoritative',
    playful:      'fun, colorful, upbeat, cheerful'
  };

  const variationAngles = [
    'Opening establishing shot with gradual zoom-in, setting the scene.',
    'Close-up product or subject detail reveal with motion blur transitions.',
    'Aerial or wide cinematic sweep across the subject environment.'
  ];

  const safeTopic = sanitizeForImagePrompt(topic.trim()).substring(0, 100);
  const rawHint   = variantContent ? variantContent.split(/[.\n!?]/)[0].trim() : '';
  const hint      = sanitizeForImagePrompt(rawHint).substring(0, 80);

  const styleDesc = styleDescriptors[videoConfig.style] || 'professional social media short video, high quality';
  const toneDesc  = toneDescriptors[videoConfig.tone]   || 'engaging and professional';
  const angleNote = variationAngles[variantIndex % variationAngles.length];

  const parts = [
    styleDesc,
    `Subject: ${safeTopic}`,
    hint ? `Theme: ${hint}` : '',
    toneDesc,
    angleNote,
    'No text overlays, no captions, no subtitles, no watermarks.',
    'Ultra high quality, suitable for professional social media reel.'
  ].filter(Boolean);

  return parts.join(', ');
}

// ═══════════════════════════════════════════════════════════════════════════
// 2. Helpers — storage, media library, logo compositing, error classification
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Overlay `logoUrl` onto `baseBuffer` at the requested position.
 * Returns the original buffer on any failure — compositing is best-effort.
 */
async function compositeLogo(baseBuffer, logoUrl, logoPosition) {
  try {
    const sharp = require('sharp');
    const https = require('https');
    const http = require('http');

    const fetchBuffer = (url) =>
      new Promise((resolve, reject) => {
        const mod = url.startsWith('https') ? https : http;
        mod
          .get(url, (resp) => {
            const chunks = [];
            resp.on('data', (c) => chunks.push(c));
            resp.on('end', () => resolve(Buffer.concat(chunks)));
            resp.on('error', reject);
          })
          .on('error', reject);
      });

    const logoBuffer = await fetchBuffer(logoUrl);
    const baseImage = sharp(baseBuffer);
    const meta = await baseImage.metadata();
    const logoSize = Math.round(Math.min(meta.width, meta.height) * 0.18);
    const margin = Math.round(logoSize * 0.3);

    const resizedLogo = await sharp(logoBuffer)
      .resize(logoSize, logoSize, { fit: 'inside', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toBuffer();

    const logoMeta = await sharp(resizedLogo).metadata();
    const lw = logoMeta.width;
    const lh = logoMeta.height;

    const posMap = {
      'top-left':      { top: margin,                       left: margin },
      'top-center':    { top: margin,                       left: Math.round((meta.width - lw) / 2) },
      'top-right':     { top: margin,                       left: meta.width - lw - margin },
      'bottom-left':   { top: meta.height - lh - margin,   left: margin },
      'bottom-center': { top: meta.height - lh - margin,   left: Math.round((meta.width - lw) / 2) },
      'bottom-right':  { top: meta.height - lh - margin,   left: meta.width - lw - margin }
    };
    const gravity = posMap[logoPosition] || posMap['bottom-right'];

    const finalBuffer = await baseImage
      .composite([{ input: resizedLogo, ...gravity }])
      .png()
      .toBuffer();

    logger.info('[Content Studio] Logo composited', { position: logoPosition });
    return finalBuffer;
  } catch (logoErr) {
    logger.warn('[Content Studio] Logo compositing failed, using original image', {
      error: logoErr.message
    });
    return baseBuffer;
  }
}

/**
 * Persist a generated media buffer to S3 (preferred) or local disk.
 * Returns descriptor fields used by Media entries and HTTP responses.
 *
 * @param {Buffer} buffer
 * @param {string} filename
 * @param {string} mimeType  e.g. 'image/png' | 'video/mp4'
 * @param {string|object} organizationId
 * @param {object} [opts]
 * @param {object} [opts.req]      Express request — only used for local-disk fallback URL
 * @param {'image'|'video'} [opts.kind='image']   affects fallback URL scheme
 */
async function persistGeneratedMedia(buffer, filename, mimeType, organizationId, opts = {}) {
  const { req = null, kind = 'image' } = opts;

  if (storageService.isS3Configured()) {
    const key = storageService.buildPostsKey(organizationId, filename);
    const { publicUrl, key: s3Key } = await storageService.uploadBuffer(key, buffer, mimeType);
    return {
      publicUrl,
      filePath: publicUrl,
      s3Key,
      storageType: 's3'
    };
  }

  const uploadDir = path.join(__dirname, '../../uploads/posts');
  await fs.mkdir(uploadDir, { recursive: true });
  const fullPath = path.join(uploadDir, filename);
  await fs.writeFile(fullPath, buffer);

  let publicUrl;
  if (req) {
    publicUrl = storageService.resolvePublicUrl(fullPath, req);
  } else {
    // Video background-job path: no req available, fall back to env-based URL
    const baseUrl = (process.env.BASE_URL || process.env.API_URL || 'https://repmeup.in')
      .replace(/\/api\/?$/, '');
    publicUrl = kind === 'video'
      ? `${baseUrl}/api/posts/media/${filename}`
      : `${baseUrl}/uploads/posts/${filename}`;
  }

  return {
    publicUrl,
    filePath: fullPath,
    s3Key: null,
    storageType: 'local'
  };
}

/**
 * Save a media library entry. Never throws — library writes are best-effort.
 * @returns {Promise<string|null>} the created Media doc's `_id`, or `null` on failure.
 *   Callers that only care about success/failure can still do `!!id`; the id
 *   itself is surfaced to the frontend (`mediaLibraryId`) so a variant image
 *   can later be referenced in a carousel via `mediaLibraryIds[]` without a
 *   second lookup.
 */
async function saveMediaLibraryEntry({
  filename,
  filePath,
  publicUrl,
  s3Key,
  storageType,
  mimeType,
  mediaType,
  size,
  userId,
  organizationId,
  tags,
  description,
  metadata
}) {
  try {
    const doc = await Media.create({
      filename,
      originalName: filename,
      filePath,
      publicUrl,
      s3Key: s3Key || undefined,
      storageType,
      mimeType,
      mediaType,
      size,
      user: userId,
      organization: organizationId,
      tags,
      description,
      metadata: metadata || null
    });
    return String(doc._id);
  } catch (mediaErr) {
    logger.warn('[Content Studio] Failed to save to media library', { error: mediaErr.message });
    return null;
  }
}

/**
 * Classify an OpenAI error as a safety / content-policy rejection so the
 * controller can return 422 with a user-friendly message instead of a generic 500.
 */
function classifySafetyRejection(error) {
  if (!error) return false;

  const msg = (
    error?.response?.data?.error?.message ||
    error?.openaiError ||
    error?.message ||
    ''
  ).toLowerCase();

  const statusMatches = error?.response?.status === 400 || error?.soraFailed === true;
  const keywordMatches =
    msg.includes('safety') ||
    msg.includes('rejected') ||
    msg.includes('content policy') ||
    msg.includes('content_policy') ||
    msg.includes('violates') ||
    msg.includes('blocked') ||
    msg.includes('moderation');

  return Boolean(statusMatches && keywordMatches);
}

/**
 * Perform a credit-check. Throws PostAiGenerationError(403) when the caller is
 * out of credits so controllers can translate to a uniform response.
 */
async function enforceCreditAvailability(organizationId, needed) {
  const check = await aiCreditService.checkCredits(organizationId, needed);
  if (!check.allowed) {
    throw new PostAiGenerationError(check.error || 'Insufficient AI credits', {
      statusCode: 403,
      code: 'AI_CREDITS_EXCEEDED',
      extras: {
        credits: {
          current: check.current,
          limit: check.limit,
          remaining: check.remaining,
          needed
        }
      }
    });
  }
  return check;
}

/**
 * Best-effort rollback. Never throws — a failed rollback is logged but must not
 * mask the original error.
 */
async function safeRollbackCredits(organizationId, amount, ctx) {
  if (!amount || !organizationId) return;
  try {
    await aiCreditService.rollbackCredits(organizationId, amount, ctx);
  } catch (err) {
    logger.error('[PostAiGenerationService] credit rollback failed', {
      error: err.message,
      organizationId: String(organizationId),
      amount
    });
  }
}

/** Build the `credits` response block from an updatedCredits record + the amount used. */
function buildCreditsPayload(updated, used) {
  return {
    used,
    current: updated.current,
    limit: updated.limit,
    remaining: updated.remaining,
    isUnlimited: updated.isUnlimited
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// 3. Orchestrators — the public API
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Generate one post (same or custom per-platform).
 *
 * @returns {Promise<{ data: any, credits: object }>}
 */
async function generatePostText({ prompt, platforms, mode, postType, organizationId, userId }) {
  if (!prompt || !platforms || platforms.length === 0) {
    throw new PostAiGenerationError('Prompt and platforms are required', { statusCode: 400 });
  }
  if (!['same', 'custom'].includes(mode)) {
    throw new PostAiGenerationError('Mode must be "same" or "custom"', { statusCode: 400 });
  }

  const creditsNeeded = mode === 'same' ? 1 : platforms.length;
  await enforceCreditAvailability(organizationId, creditsNeeded);

  let deducted = 0;
  try {
    const { result, aiApiUsageId } = await runWithAiContextAndUsageId(
      { organizationId, userId, feature: 'content_studio.post_generate' },
      () => aiService.generatePost(prompt, platforms, mode, postType, organizationId)
    );

    await aiCreditService.deductCredits(
      organizationId,
      result.creditsUsed,
      {
        operation: 'post_generation',
        userId,
        prompt: prompt.substring(0, 100),
        platforms,
        mode,
        postType
      },
      { aiApiUsageId }
    );
    deducted = result.creditsUsed;

    const updated = await aiCreditService.getUsage(organizationId);
    return { data: result, credits: buildCreditsPayload(updated, result.creditsUsed) };
  } catch (err) {
    await safeRollbackCredits(organizationId, deducted, {
      operation: 'post_generation',
      userId,
      reason: err.message
    });
    throw err;
  }
}

/**
 * Generate multiple post variants (Content Studio).
 * Clamps count to the [1, 5] range.
 */
async function generatePostVariants({
  topic,
  platforms,
  count,
  audience,
  intent,
  mood,
  includeTrend,
  postType,
  generationMode,
  eventTemplateId,
  organizationId,
  userId
}) {
  if (!topic || !platforms || !Array.isArray(platforms) || platforms.length === 0) {
    throw new PostAiGenerationError('Topic and platforms are required', { statusCode: 400 });
  }

  const variantCount = Math.min(parseInt(count, 10) || 3, 5);
  await enforceCreditAvailability(organizationId, variantCount);

  let deducted = 0;
  try {
    const { result, aiApiUsageId } = await runWithAiContextAndUsageId(
      { organizationId, userId, feature: 'content_studio.post_variants' },
      async () => {
        let occasionContext = null;
        if (eventTemplateId) {
          // Lazy-require to avoid pulling a rarely-used model into the startup graph
          const EventTemplate = require('../models/EventTemplate');
          const tpl = await EventTemplate.findOne({
            _id: eventTemplateId,
            organization: organizationId
          }).lean();
          if (tpl) {
            occasionContext = {
              name: tpl.name,
              eventType: tpl.eventType,
              sampleCaption: tpl.sampleCaption || '',
              hashtags: tpl.hashtags || [],
              cta: tpl.cta || '',
              eventStyle: tpl.eventStyle || null
            };
          }
        }
        return aiService.generatePostVariants(topic, platforms, {
          count: variantCount,
          organizationId,
          userId,
          postType: postType || 'post',
          audience: audience || '',
          intent: intent || '',
          mood: mood || '',
          includeTrend: !!includeTrend,
          generationMode: generationMode || 'instant',
          occasionContext
        });
      }
    );

    await aiCreditService.deductCredits(
      organizationId,
      variantCount,
      {
        operation: 'post_variants',
        userId,
        topic: topic.substring(0, 100),
        platforms,
        variantCount
      },
      { aiApiUsageId }
    );
    deducted = variantCount;

    const updated = await aiCreditService.getUsage(organizationId);
    return { data: result, credits: buildCreditsPayload(updated, variantCount) };
  } catch (err) {
    await safeRollbackCredits(organizationId, deducted, {
      operation: 'post_variants',
      userId,
      reason: err.message
    });
    throw err;
  }
}

/**
 * Generate a single AI image for a content-studio variant.
 *
 * Full lifecycle:
 *   1. Credit gate (throws 403 if short)
 *   2. Build prompt (reference-mode vs configured)
 *   3. Apply occasion template visual style (if any)
 *   4. Call aiService.generateImage
 *   5. Optional logo compositing
 *   6. Persist to S3 or local disk
 *   7. Save to media library (best-effort)
 *   8. Deduct credit (rollback on any failure above step 4)
 *
 * @returns {Promise<{ imageUrl, savedToLibrary, designDna, credits }>}
 */
async function generateVariantImage({
  topic,
  variantContent,
  imageConfig,
  variantIndex,
  contentType,
  generationMode,
  logoOverlay,
  logoPosition,
  logoUrl,
  eventTemplateId,
  includePeople,
  peopleNationality,
  // Product Shoot (see plan "Reference-Powered Product Shoot") — mutually
  // exclusive product source, plus up to 3 style-only references.
  productReferenceImageId,
  inputImageId,
  styleReferenceImageIds,
  fidelityMode,
  shootConfig,
  organizationId,
  userId,
  req = null
}) {
  if (!topic) {
    throw new PostAiGenerationError('topic is required', { statusCode: 400 });
  }

  const isProductShoot = !!(productReferenceImageId || inputImageId);
  if (isProductShoot && !isProductShootEnabled()) {
    // Emergency kill switch (plan §6) — fail loudly and specifically rather
    // than silently reinterpreting the request as legacy reference mode,
    // which would ignore the user's chosen primary product without telling them.
    throw new PostAiGenerationError(
      'Product Shoot is temporarily unavailable. Please try again shortly.',
      { statusCode: 503, code: 'PRODUCT_SHOOT_UNAVAILABLE' }
    );
  }
  if (productReferenceImageId && inputImageId) {
    throw new PostAiGenerationError(
      'Provide either an existing product reference or a new upload, not both',
      { statusCode: 400 }
    );
  }

  let productShootRefs = null;
  let normalizedShootConfig = {};
  let normalizedFidelityMode = 'strict';
  if (isProductShoot) {
    const { validateShootConfig, normalizeFidelityMode, validateStyleReferenceIds } = require('../utils/productShootValidation');
    const { value: shootValue, errors: shootErrors } = validateShootConfig(shootConfig);
    const { value: styleIds, errors: styleErrors } = validateStyleReferenceIds(styleReferenceImageIds);
    const allErrors = [...shootErrors, ...styleErrors];
    if (allErrors.length) {
      throw new PostAiGenerationError(allErrors.join('; '), { statusCode: 400, code: 'INVALID_SHOOT_CONFIG' });
    }
    normalizedShootConfig = shootValue;
    normalizedFidelityMode = normalizeFidelityMode(fidelityMode);

    const brandContextService = require('./ai/brandContextService');
    try {
      productShootRefs = await brandContextService.resolveProductShootReferences(organizationId, userId, {
        productReferenceImageId,
        inputImageId,
        styleReferenceImageIds: styleIds
      });
    } catch (err) {
      if (err.code === 'REFERENCE_NOT_FOUND') {
        throw new PostAiGenerationError(err.message, { statusCode: 404, code: 'REFERENCE_NOT_FOUND' });
      }
      throw err;
    }
  }

  await enforceCreditAvailability(organizationId, 1);

  // ── 1. Build the prompt ────────────────────────────────────────────────
  const safeVariantIndex = typeof variantIndex === 'number' ? variantIndex : 0;
  const isReferenceMode = generationMode === 'reference';
  // Product Shoot reuses the neutral reference-mode prompt as its base —
  // the role-aware "preserve product / style only" instructions are layered
  // on top inside imageGenerationService.assembleImagePrompt, not here.
  let imagePrompt = (isReferenceMode || isProductShoot)
    ? buildReferenceImagePrompt({
        topic,
        variantIndex: safeVariantIndex,
        contentType: contentType || ''
      })
    : buildImagePrompt({
        topic,
        variantContent,
        imageConfig: imageConfig || {},
        variantIndex: safeVariantIndex,
        contentType: contentType || ''
      });

  if (isProductShoot) {
    // shootConfig.includePeople already drives the people instruction inside
    // buildProductShootPromptBlock — avoid emitting a second, possibly
    // conflicting instruction here.
  } else if (includePeople) {
    const nationalityPart = peopleNationality ? `${peopleNationality} ` : '';
    imagePrompt += ` Include ${nationalityPart}people naturally in the scene — diverse, authentic, candid.`;
  } else {
    imagePrompt += ' Do NOT include any people, faces, or human figures in the image.';
  }

  logger.info('[Content Studio] AI image prompt', {
    variantIndex: safeVariantIndex,
    isProductShoot,
    prompt: imagePrompt.substring(0, 500)
  });

  // ── 2. Resolve brand context based on generation mode ──────────────────
  //   'instant'     → no brand context (generic AI generation)
  //   'brand-voice' → full visual style context (brand profile + reference images)
  //   'reference'   → reference images only (ignores brand profile visuals)
  //   product shoot → explicit role-aware product + style images (see below)
  const imageOrgId = (isProductShoot || (generationMode && generationMode !== 'instant')) ? organizationId : null;
  const imageOptions = generationMode === 'reference' ? { referenceOnly: true } : {};

  if (isProductShoot) {
    imageOptions.productShoot = {
      productImageUrl: productShootRefs.productImageUrl,
      styleImageUrls: productShootRefs.styleImageUrls,
      fidelityMode: normalizedFidelityMode,
      shootConfig: normalizedShootConfig,
      variantIndex: safeVariantIndex
    };
  }

  if (eventTemplateId) {
    const EventTemplate = require('../models/EventTemplate');
    const tpl = await EventTemplate.findOne({
      _id: eventTemplateId,
      organization: organizationId
    }).lean();
    if (tpl?.eventStyle) {
      imageOptions.occasionVisualStyle = tpl.eventStyle;
    }
  }

  // ── 3. Run the AI + post-process + persist (single try/finally for credit safety) ──
  // Structured timing/outcome logs (plan §6 "Reliability, lifecycle, and
  // observability" — generation latency, success/failure, provider errors)
  // deliberately avoid raw prompts/image bytes, only ids/config/duration.
  let deducted = 0;
  const genStartedAt = Date.now();
  try {
    const { result: genResult, aiApiUsageId } = await runWithAiContextAndUsageId(
      {
        organizationId,
        userId,
        feature: `content_studio.variant_image.${safeVariantIndex}`
      },
      () => aiService.generateImage(imagePrompt, imageOrgId, imageOptions)
    );

    const buffer = genResult?.buffer ?? null;
    const capturedStyleSpec = genResult?.styleSpec ?? null;
    const capturedImagePrompt = genResult?.imagePrompt ?? imagePrompt;

    if (!buffer) {
      throw new PostAiGenerationError('Image generation failed. Please try again.', {
        statusCode: 500
      });
    }

    // Optional logo overlay
    const finalBuffer =
      logoOverlay && logoUrl && logoPosition
        ? await compositeLogo(buffer, logoUrl, logoPosition)
        : buffer;

    // Persist
    const filename = `ai-${Date.now()}-${Math.floor(Math.random() * 1000)}.png`;
    const persisted = await persistGeneratedMedia(
      finalBuffer,
      filename,
      'image/png',
      organizationId,
      { req, kind: 'image' }
    );

    const mediaLibraryId = await saveMediaLibraryEntry({
      filename,
      filePath: persisted.filePath,
      publicUrl: persisted.publicUrl,
      s3Key: persisted.s3Key,
      storageType: persisted.storageType,
      mimeType: 'image/png',
      mediaType: 'image',
      size: finalBuffer.length,
      userId,
      organizationId,
      tags: isProductShoot ? ['ai-generated', 'content-studio', 'product-shoot'] : ['ai-generated', 'content-studio'],
      description: `Reppy generated for: ${topic.substring(0, 80)}`,
      // Provenance (plan: "Preserve generation provenance in output metadata")
      // — ids/config only, never raw prompts or image bytes.
      metadata: isProductShoot ? {
        source: 'product_shoot',
        productReferenceImageId: productReferenceImageId || null,
        inputImageId: inputImageId || null,
        styleReferenceImageIds: productShootRefs?.styleImageUrls?.length ? (styleReferenceImageIds || []) : [],
        fidelityMode: normalizedFidelityMode,
        shootConfig: normalizedShootConfig,
        generatedBy: userId
      } : null
    });

    await aiCreditService.deductCredits(
      organizationId,
      1,
      {
        operation: 'post_variants_image',
        userId,
        topic: topic.substring(0, 100)
      },
      { aiApiUsageId }
    );
    deducted = 1;

    const updated = await aiCreditService.getUsage(organizationId);

    logger.info('[metrics] content_studio.variant_image.generated', {
      organizationId, variantIndex: safeVariantIndex, isProductShoot,
      fidelityMode: isProductShoot ? normalizedFidelityMode : undefined,
      preset: isProductShoot ? normalizedShootConfig.preset : undefined,
      outcome: 'success', durationMs: Date.now() - genStartedAt
    });

    return {
      imageUrl: persisted.publicUrl,
      savedToLibrary: !!mediaLibraryId,
      // Lets the frontend add this exact generated image to an Instagram
      // carousel later via POST /posts/{save-draft,schedule,publish,to-approval}
      // { mediaLibraryIds: [...] } without re-uploading or re-resolving it.
      mediaLibraryId,
      designDna: {
        generationPrompt: capturedImagePrompt,
        layoutType: capturedStyleSpec?.layout || null,
        colors: capturedStyleSpec?.colorPalette || [],
        medium: capturedStyleSpec?.medium || null,
        style: capturedStyleSpec?.style || null
      },
      credits: buildCreditsPayload(updated, 1)
    };
  } catch (err) {
    await safeRollbackCredits(organizationId, deducted, {
      operation: 'post_variants_image',
      userId,
      reason: err.message
    });

    logger.warn('[metrics] content_studio.variant_image.generated', {
      organizationId, variantIndex: safeVariantIndex, isProductShoot,
      fidelityMode: isProductShoot ? normalizedFidelityMode : undefined,
      outcome: 'failure', durationMs: Date.now() - genStartedAt,
      errorCode: err.code || err.name || 'UNKNOWN'
    });

    // Re-throw PostAiGenerationError as-is; translate OpenAI safety rejection to 422
    if (err instanceof PostAiGenerationError) throw err;

    if (classifySafetyRejection(err)) {
      throw new PostAiGenerationError(
        'Image could not be generated because the topic or content references copyrighted characters, brands, or restricted subjects. Try rephrasing your topic to be more generic (e.g. "nostalgic cartoon memories" instead of specific character names).',
        { statusCode: 422, code: 'CONTENT_POLICY' }
      );
    }

    throw err;
  }
}

/**
 * Submit an AI video generation job. Returns immediately with a jobId so the
 * browser connection is released; the actual Sora call runs in a background
 * promise and updates the VideoJob record on completion / failure.
 *
 * Credit is deducted *only* on successful completion inside the background task
 * — if the job fails, no credit is spent.
 *
 * @returns {Promise<{ jobId: string }>}
 */
async function submitVariantVideoJob({
  topic,
  variantContent,
  videoConfig,
  variantIndex,
  organizationId,
  userId
}) {
  if (!topic) {
    throw new PostAiGenerationError('topic is required', { statusCode: 400 });
  }

  await enforceCreditAvailability(organizationId, 1);

  const jobId = `vjob_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  await VideoJob.create({ jobId, status: 'pending', organizationId });

  // Intentionally not awaited — runs AFTER the HTTP response is sent.
  _runVideoJobInBackground({
    jobId,
    topic,
    variantContent,
    videoConfig,
    variantIndex,
    organizationId,
    userId
  }).catch((err) => {
    // Safety net — errors should already be caught inside the inner try/catch,
    // but if something slips through we at least surface it.
    logger.error('[Video] Uncaught background error', { jobId, error: err.message });
  });

  return { jobId };
}

/**
 * Internal: runs the Sora job, persists the resulting video, updates the
 * VideoJob record. Exported only so tests can await completion deterministically.
 */
async function _runVideoJobInBackground({
  jobId,
  topic,
  variantContent,
  videoConfig,
  variantIndex,
  organizationId,
  userId
}) {
  try {
    const vIdx = typeof variantIndex === 'number' ? variantIndex : 0;
    const videoPrompt = buildVideoPrompt({
      topic,
      variantContent,
      videoConfig: videoConfig || {},
      variantIndex: vIdx
    });
    logger.info('[Content Studio] AI video prompt', {
      variantIndex: vIdx,
      prompt: videoPrompt.substring(0, 500)
    });

    const cfg = videoConfig || {};
    const { result: buffer, aiApiUsageId } = await runWithAiContextAndUsageId(
      { organizationId, userId, feature: `content_studio.variant_video.${vIdx}` },
      () =>
        aiService.generateVideo(videoPrompt, {
          duration: cfg.duration || 4,
          aspect: cfg.aspect || '9:16'
        })
    );

    if (!buffer) {
      await VideoJob.findOneAndUpdate(
        { jobId },
        {
          status: 'failed',
          error: { code: 'VIDEO_FAILED', message: 'Video generation returned no data. Please try again.' }
        }
      );
      return;
    }

    const filename = `ai-video-${Date.now()}-${Math.floor(Math.random() * 1000)}.mp4`;
    const persisted = await persistGeneratedMedia(buffer, filename, 'video/mp4', organizationId, {
      kind: 'video'
    });

    await VideoJob.findOneAndUpdate({ jobId }, { status: 'completed', videoUrl: persisted.publicUrl });

    await aiCreditService.deductCredits(
      organizationId,
      1,
      {
        operation: 'post_variants_video',
        userId,
        topic: topic.substring(0, 100)
      },
      { aiApiUsageId }
    );

    logger.info('[Video] Job completed', { jobId, videoUrl: persisted.publicUrl });
  } catch (err) {
    logger.error('[Video] Background generation error', {
      jobId,
      error: err.message,
      stack: err.stack
    });

    const errorDoc = classifySafetyRejection(err)
      ? { code: 'CONTENT_POLICY', message: 'Video blocked due to content policy. Try rephrasing your topic.' }
      : { code: 'VIDEO_FAILED', message: err.message || 'Video generation failed.' };

    await VideoJob.findOneAndUpdate({ jobId }, { status: 'failed', error: errorDoc });
  }
}

/** Poll the status of a video generation job. */
async function getVideoJobStatus(jobId) {
  const job = await VideoJob.findOne({ jobId })
    .select('jobId status videoUrl error')
    .lean();

  if (!job) {
    throw new PostAiGenerationError('Job not found or expired', { statusCode: 404 });
  }

  return {
    status: job.status,
    videoUrl: job.videoUrl || null,
    error: job.error || null
  };
}

// ═══════════════════════════════════════════════════════════════════════════
module.exports = {
  // Error contract
  PostAiGenerationError,

  // Pure prompt builders — exported for testing and possible reuse
  IP_REPLACEMENTS,
  sanitizeForImagePrompt,
  buildImagePrompt,
  buildReferenceImagePrompt,
  buildVideoPrompt,

  // Helpers (exported for testing)
  compositeLogo,
  persistGeneratedMedia,
  saveMediaLibraryEntry,
  classifySafetyRejection,

  // Orchestrators (the public API)
  generatePostText,
  generatePostVariants,
  generateVariantImage,
  submitVariantVideoJob,
  getVideoJobStatus,

  // Exposed for deterministic tests only
  _runVideoJobInBackground
};
