const ScheduledPost = require('../models/ScheduledPost');
const PlatformConnection = require('../models/PlatformConnection');
const Media = require('../models/Media');
const VideoJob = require('../models/VideoJob');
const instagramService = require('../integrations/meta/instagramService');
const facebookService = require('../integrations/meta/facebookService');
const linkedinService = require('../integrations/linkedin/linkedinService');
const aiService = require('../services/aiService');
const aiCreditService = require('../services/aiCreditService');
const auditLogController = require('./auditLogController');
const multer = require('multer');
const path = require('path');
const fs = require('fs').promises;
const crypto = require('crypto');
const { validateMedia, getRequirementsText } = require('../config/platformMediaRequirements');

// Configure multer for media uploads
const storage = multer.diskStorage({
  destination: async function (req, file, cb) {
    const uploadDir = path.join(__dirname, '../../uploads/posts');
    try {
      await fs.mkdir(uploadDir, { recursive: true });
      cb(null, uploadDir);
    } catch (error) {
      cb(error);
    }
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({
  storage: storage,
  limits: {
    fileSize: 8 * 1024 * 1024 // 8MB limit per file
  },
  fileFilter: function (req, file, cb) {
    const allowedTypes = /jpeg|jpg|png|mp4/;
    const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = allowedTypes.test(file.mimetype);

    if (mimetype && extname) {
      return cb(null, true);
    } else {
      cb(new Error('Only JPEG, PNG, and MP4 files are allowed'));
    }
  }
}).array('media', 10); // Support up to 10 files for carousel posts

/**
 * @desc    Generate post content with AI
 * @route   POST /api/posts/generate
 * @access  Private
 */
exports.generatePostWithAI = async (req, res) => {
  let creditsDeducted = 0;
  let organizationId;
  try {
    const { prompt, platforms, mode, postType } = req.body;
    organizationId = req.user.organization?._id || req.user.organization;

    if (!prompt || !platforms || platforms.length === 0) {
      return res.status(400).json({ success: false, message: 'Prompt and platforms are required' });
    }
    if (!['same', 'custom'].includes(mode)) {
      return res.status(400).json({ success: false, message: 'Mode must be "same" or "custom"' });
    }

    const creditsNeeded = mode === 'same' ? 1 : platforms.length;
    const creditCheck = await aiCreditService.checkCredits(organizationId, creditsNeeded);
    if (!creditCheck.allowed) {
      return res.status(403).json({
        success: false,
        message: creditCheck.error || 'Insufficient AI credits',
        credits: { current: creditCheck.current, limit: creditCheck.limit, remaining: creditCheck.remaining, needed: creditsNeeded }
      });
    }

    const result = await aiService.generatePost(prompt, platforms, mode, postType, organizationId);

    await aiCreditService.deductCredits(organizationId, result.creditsUsed, {
      operation: 'post_generation', userId: req.user._id,
      prompt: prompt.substring(0, 100), platforms, mode, postType
    });
    creditsDeducted = result.creditsUsed;

    const updatedCredits = await aiCreditService.getUsage(organizationId);

    res.status(200).json({
      success: true, data: result,
      credits: { used: result.creditsUsed, current: updatedCredits.current, limit: updatedCredits.limit, remaining: updatedCredits.remaining, isUnlimited: updatedCredits.isUnlimited }
    });
  } catch (error) {
    console.error('Generate post with AI error:', error);
    if (creditsDeducted > 0 && organizationId) {
      await aiCreditService.rollbackCredits(organizationId, creditsDeducted, { operation: 'post_generation', userId: req.user?._id, reason: error.message });
    }
    res.status(500).json({ success: false, message: error.message || 'Failed to generate post' });
  }
};

/**
 * @desc    Generate multiple post variants (Content Studio)
 * @route   POST /api/posts/generate-variants
 * @access  Private
 */
exports.generatePostVariantsWithAI = async (req, res) => {
  let creditsDeducted = 0;
  let organizationId;
  try {
    const { topic, platforms, count, audience, intent, mood, includeTrend, postType } = req.body;
    organizationId = req.user.organization?._id || req.user.organization;

    if (!topic || !platforms || !Array.isArray(platforms) || platforms.length === 0) {
      return res.status(400).json({ success: false, message: 'Topic and platforms are required' });
    }

    const variantCount = Math.min(parseInt(count, 10) || 3, 5);

    const creditCheck = await aiCreditService.checkCredits(organizationId, variantCount);
    if (!creditCheck.allowed) {
      return res.status(403).json({
        success: false, message: creditCheck.error || 'Insufficient AI credits',
        credits: { current: creditCheck.current, limit: creditCheck.limit, remaining: creditCheck.remaining, needed: variantCount }
      });
    }

    const result = await aiService.generatePostVariants(topic, platforms, {
      count: variantCount, organizationId, postType: postType || 'post',
      audience: audience || '', intent: intent || '', mood: mood || '', includeTrend: !!includeTrend
    });

    await aiCreditService.deductCredits(organizationId, variantCount, {
      operation: 'post_variants', userId: req.user._id, topic: topic.substring(0, 100), platforms, variantCount
    });
    creditsDeducted += variantCount;

    const updatedCredits = await aiCreditService.getUsage(organizationId);

    res.status(200).json({
      success: true, data: result,
      credits: { used: variantCount, current: updatedCredits.current, limit: updatedCredits.limit, remaining: updatedCredits.remaining, isUnlimited: updatedCredits.isUnlimited }
    });
  } catch (error) {
    console.error('Generate post variants error:', error);
    if (creditsDeducted > 0 && organizationId) {
      await aiCreditService.rollbackCredits(organizationId, creditsDeducted, { operation: 'post_variants', userId: req.user?._id, reason: error.message });
    }
    res.status(500).json({ success: false, message: error.message || 'Failed to generate variants' });
  }
};

/**
 * @desc    Generate a single AI image for one content-studio variant.
 *          Called per-variant from the frontend AFTER text variants are received,
 *          so each request is independent and well within any proxy timeout.
 * @route   POST /api/posts/generate-variant-image
 * @access  Private
 */
/**
 * Build a richly structured, unique image prompt from user-selected style options.
 * Each variant index gets a different primary variation directive to enforce diversity.
 */
/**
 * Replaces known copyrighted / safety-triggering IP terms with safe generic alternatives
 * so DALL-E doesn't reject the prompt for copyright or policy violations.
 */
const IP_REPLACEMENTS = [
  // Anime / manga characters & franchises
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
  [/(fullmetal\s+alchemist)/gi,           'anime series'],
  [/(sailor\s*moon)/gi,                  'magical anime series'],
  [/(death\s+note)/gi,                   'anime thriller series'],
  [/(evangelion|neon\s+genesis)/gi,      'mecha anime series'],
  // Gaming characters
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
  // Movies & TV franchise characters
  [/(darth\s+vader|luke\s+skywalker|yoda|obi.?wan|star\s+wars|jedi|sith|the\s+force)/gi, 'sci-fi space hero'],
  [/(harry\s+potter|hermione|ron\s+weasley|dumbledore|voldemort|hogwarts)/gi, 'young wizard protagonist'],
  [/(gandalf|frodo|bilbo|aragorn|sauron|lord\s+of\s+the\s+rings|hobbit)/gi, 'fantasy hero'],
  [/(mickey\s+mouse|minnie\s+mouse|donald\s+duck|goofy)/gi, 'classic cartoon character'],
  [/(simpsons?|homer|bart|marge|lisa)/gi, 'animated sitcom character'],
  [/(shrek|fiona|donkey)/gi,             'animated movie character'],
  // General safety — things that commonly trigger DALL-E
  [/real\s+person|celebrity|influencer\s+named/gi, 'public figure'],
];

function sanitizeForImagePrompt(text) {
  if (!text) return '';
  let result = text
    .replace(/[#@\n\r]/g, ' ')
    .replace(/[^\x20-\x7E]/g, '')   // strip non-printable / emoji
    .replace(/\s+/g, ' ')
    .trim();
  for (const [pattern, replacement] of IP_REPLACEMENTS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

function buildImagePrompt({ topic, variantContent, imageConfig = {}, variantIndex = 0, contentType = '' }) {
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

  // Each variant index forces a distinct visual angle to prevent identical outputs
  const variationDirectives = [
    'Hero shot: subject centered prominently, clean uncluttered background, confident direct composition.',
    'Environmental context: subject integrated into relevant setting, rule-of-thirds framing, storytelling depth.',
    'Abstract close-up: tight macro detail of subject, bold foreground crop, abstract artistic interpretation.',
    'Wide establishing shot: expansive scene with subject as part of larger narrative, atmospheric depth.',
    'Dynamic diagonal: subject at striking diagonal angle, energy and motion implied, graphic impact.',
    'Flat lay overhead: bird\'s eye top-down arrangement, organized flat lay aesthetic, product catalog feel.'
  ];

  const styleDesc        = styleDescriptors[imageConfig.style] || 'professional social media photography, high quality';
  const moodPart         = imageConfig.mood        ? `${imageConfig.mood.toLowerCase()} emotional atmosphere` : '';
  const lightingPart     = imageConfig.lighting    ? `${imageConfig.lighting.toLowerCase()} lighting` : '';
  const compositionPart  = imageConfig.composition ? `${imageConfig.composition.toLowerCase()} composition` : '';
  const palettePart      = imageConfig.colorPalette? `${imageConfig.colorPalette.toLowerCase()} color palette` : '';
  const anglePart        = imageConfig.cameraAngle ? `${imageConfig.cameraAngle.toLowerCase()} camera angle` : '';
  const variationNote    = variationDirectives[variantIndex % variationDirectives.length];

  // Sanitize topic — strip IP/copyright terms so DALL-E safety system doesn't reject
  const safeTopic = sanitizeForImagePrompt(topic.trim()).substring(0, 120);

  // Derive a short thematic hint from the post content (first sentence, sanitized, ≤80 chars)
  const rawHint = variantContent
    ? variantContent.split(/[.\n!?]/)[0].trim()
    : '';
  const contentHint = sanitizeForImagePrompt(rawHint).substring(0, 80);

  const promptParts = [
    styleDesc,
    `Subject: ${safeTopic}`,
    contentHint ? `Theme: ${contentHint}` : '',
    moodPart,
    lightingPart,
    compositionPart,
    palettePart,
    anglePart,
    variationNote,
    contentType === 'image-layover'
      ? `Include the headline text "${safeTopic.split(' ').slice(0, 8).join(' ')}" as a bold, stylish graphic overlay in the scene, modern typography, high contrast — text rendered in the image itself.`
      : 'No text overlays, no watermarks, no logos, no words.',
    'Ultra high quality, suitable for professional social media post.',
    `seed:${Date.now() % 100000 + variantIndex * 13337}`  // soft uniqueness token
  ].filter(Boolean);

  return promptParts.join(', ');
}

exports.generateVariantImage = async (req, res) => {
  let creditsDeducted = 0;
  let organizationId;
  try {
    const { topic, variantContent, imageConfig, variantIndex, contentType, logoOverlay, logoPosition, logoUrl } = req.body;
    organizationId = req.user.organization?._id || req.user.organization;
    const userId = req.user._id;

    if (!topic) {
      return res.status(400).json({ success: false, message: 'topic is required' });
    }

    const creditCheck = await aiCreditService.checkCredits(organizationId, 1);
    if (!creditCheck.allowed) {
      return res.status(403).json({
        success: false, message: creditCheck.error || 'Insufficient AI credits',
        code: 'AI_CREDITS_EXCEEDED'
      });
    }

    const imagePrompt = buildImagePrompt({
      topic,
      variantContent,
      imageConfig: imageConfig || {},
      variantIndex: typeof variantIndex === 'number' ? variantIndex : 0,
      contentType: contentType || ''
    });
    console.log('[Content Studio] AI image prompt (variant %d):\n', variantIndex, imagePrompt);

    const uploadDir = path.join(__dirname, '../../uploads/posts');
    await fs.mkdir(uploadDir, { recursive: true });

    const buffer = await aiService.generateImage(imagePrompt);
    if (!buffer) {
      return res.status(500).json({ success: false, message: 'Image generation failed. Please try again.' });
    }

    // ── Optional: logo compositing via sharp ─────────────────────────────────
    let finalBuffer = buffer;
    if (logoOverlay && logoUrl && logoPosition) {
      try {
        const sharp = require('sharp');
        const https = require('https');
        const http = require('http');

        // Fetch logo buffer from URL
        const fetchBuffer = (url) => new Promise((resolve, reject) => {
          const mod = url.startsWith('https') ? https : http;
          mod.get(url, (resp) => {
            const chunks = [];
            resp.on('data', (c) => chunks.push(c));
            resp.on('end', () => resolve(Buffer.concat(chunks)));
            resp.on('error', reject);
          }).on('error', reject);
        });

        const logoBuffer = await fetchBuffer(logoUrl);
        const baseImage = sharp(buffer);
        const meta = await baseImage.metadata();
        const logoSize = Math.round(Math.min(meta.width, meta.height) * 0.18);
        const margin  = Math.round(logoSize * 0.3);

        const resizedLogo = await sharp(logoBuffer)
          .resize(logoSize, logoSize, { fit: 'inside', background: { r: 0, g: 0, b: 0, alpha: 0 } })
          .png()
          .toBuffer();

        const logoMeta = await sharp(resizedLogo).metadata();
        const lw = logoMeta.width;
        const lh = logoMeta.height;

        const posMap = {
          'top-left':      { top: margin,                             left: margin },
          'top-center':    { top: margin,                             left: Math.round((meta.width - lw) / 2) },
          'top-right':     { top: margin,                             left: meta.width - lw - margin },
          'bottom-left':   { top: meta.height - lh - margin,         left: margin },
          'bottom-center': { top: meta.height - lh - margin,         left: Math.round((meta.width - lw) / 2) },
          'bottom-right':  { top: meta.height - lh - margin,         left: meta.width - lw - margin },
        };
        const gravity = posMap[logoPosition] || posMap['bottom-right'];

        finalBuffer = await baseImage
          .composite([{ input: resizedLogo, ...gravity }])
          .png()
          .toBuffer();
        console.log(`[Content Studio] Logo composited at ${logoPosition}`);
      } catch (logoErr) {
        console.warn('[Content Studio] Logo compositing failed, using original image:', logoErr.message);
        finalBuffer = buffer;
      }
    }

    const filename = `ai-${Date.now()}-${Math.floor(Math.random() * 1000)}.png`;
    const fullPath = path.join(uploadDir, filename);
    await fs.writeFile(fullPath, finalBuffer);
    const imageUrl = getPublicMediaUrl(fullPath, req);

    // ── Auto-save to Media Library ────────────────────────────────────────────
    let savedToLibrary = false;
    try {
      const stat = await fs.stat(fullPath);
      await Media.create({
        filename,
        originalName: filename,
        filePath: fullPath,
        publicUrl: imageUrl,
        mimeType: 'image/png',
        mediaType: 'image',
        size: stat.size,
        user: userId,
        organization: organizationId,
        tags: ['ai-generated', 'content-studio'],
        description: `AI generated for: ${topic.substring(0, 80)}`
      });
      savedToLibrary = true;
    } catch (mediaErr) {
      console.warn('[Content Studio] Failed to save image to media library:', mediaErr.message);
    }

    await aiCreditService.deductCredits(organizationId, 1, {
      operation: 'post_variants_image', userId: req.user._id,
      topic: topic.substring(0, 100)
    });
    creditsDeducted = 1;

    const updatedCredits = await aiCreditService.getUsage(organizationId);

    res.status(200).json({
      success: true, imageUrl, savedToLibrary,
      credits: { used: 1, current: updatedCredits.current, limit: updatedCredits.limit, remaining: updatedCredits.remaining, isUnlimited: updatedCredits.isUnlimited }
    });
  } catch (error) {
    console.error('Generate variant image error:', error);
    if (creditsDeducted > 0 && organizationId) {
      await aiCreditService.rollbackCredits(organizationId, creditsDeducted, { operation: 'post_variants_image', userId: req.user?._id, reason: error.message });
    }

    // Detect OpenAI safety / content-policy rejection (HTTP 400 with safety message)
    const openaiMsg = error?.response?.data?.error?.message || error?.openaiError || '';
    const isSafetyRejection =
      error?.response?.status === 400 &&
      (openaiMsg.toLowerCase().includes('safety') ||
       openaiMsg.toLowerCase().includes('rejected') ||
       openaiMsg.toLowerCase().includes('content policy') ||
       openaiMsg.toLowerCase().includes('content_policy') ||
       openaiMsg.toLowerCase().includes('violates') ||
       openaiMsg.toLowerCase().includes('blocked') ||
       openaiMsg.toLowerCase().includes('moderation'));

    if (isSafetyRejection) {
      return res.status(422).json({
        success: false,
        code: 'CONTENT_POLICY',
        message: 'Image could not be generated because the topic or content references copyrighted characters, brands, or restricted subjects. Try rephrasing your topic to be more generic (e.g. "nostalgic cartoon memories" instead of specific character names).'
      });
    }

    res.status(500).json({ success: false, message: error.message || 'Failed to generate image' });
  }
};

// ─── Video Generation ────────────────────────────────────────────────────────

/**
 * Build a cinematic direction prompt for Sora from the user's VideoConfig.
 * Sanitised the same way as image prompts so copyrighted terms don't trigger rejections.
 */
function buildVideoPrompt({ topic, variantContent, videoConfig = {}, variantIndex = 0 }) {
  const styleDescriptors = {
    cinematic:    'cinematic short film scene, anamorphic lens, movie-grade color grading, dramatic lighting',
    realistic:    'ultra-realistic live action footage, natural lighting, documentary handheld camera feel',
    animated:     'smooth 3D animation, modern motion graphics, vibrant colors, fluid transitions',
    documentary:  'documentary style footage, authentic real-world setting, journalistic framing',
    energetic:    'fast-paced dynamic edit, quick cuts, high energy motion, bold visual rhythm',
  };

  const toneDescriptors = {
    energetic:    'high-energy, fast-paced, exciting',
    calm:         'calm, serene, slow-motion elegance',
    professional: 'polished, corporate, clean and authoritative',
    playful:      'fun, colorful, upbeat, cheerful',
  };

  const variationAngles = [
    'Opening establishing shot with gradual zoom-in, setting the scene.',
    'Close-up product or subject detail reveal with motion blur transitions.',
    'Aerial or wide cinematic sweep across the subject environment.',
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
    'Ultra high quality, suitable for professional social media reel.',
  ].filter(Boolean);

  return parts.join(', ');
}

/**
 * @desc    Submit an AI video generation job (returns jobId immediately — non-blocking).
 *          Avoids nginx proxy-timeout issues by not holding the HTTP connection open.
 * @route   POST /api/posts/generate-variant-video
 * @access  Private
 */
exports.generateVariantVideo = async (req, res) => {
  try {
    const { topic, variantContent, videoConfig, variantIndex } = req.body;
    const organizationId = req.user.organization?._id || req.user.organization;
    const userId = req.user._id;

    if (!topic) {
      return res.status(400).json({ success: false, message: 'topic is required' });
    }

    // Credit gate — fail fast before we even start
    const creditCheck = await aiCreditService.checkCredits(organizationId, 1);
    if (!creditCheck.allowed) {
      return res.status(403).json({
        success: false, message: creditCheck.error || 'Insufficient AI credits',
        code: 'AI_CREDITS_EXCEEDED'
      });
    }

    const jobId = `vjob_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    await VideoJob.create({ jobId, status: 'pending', organizationId });

    // ── Respond immediately so the browser connection is released ────────────
    res.status(202).json({ success: true, jobId });

    // ── Background generation (no await — runs after response is sent) ───────
    ;(async () => {
      try {
        const videoPrompt = buildVideoPrompt({
          topic,
          variantContent,
          videoConfig: videoConfig || {},
          variantIndex: typeof variantIndex === 'number' ? variantIndex : 0
        });
        console.log('[Content Studio] AI video prompt (variant %d):\n', variantIndex, videoPrompt);

        const cfg = videoConfig || {};
        const buffer = await aiService.generateVideo(videoPrompt, {
          duration: cfg.duration || 4,
          aspect:   cfg.aspect   || '9:16'
        });

        if (!buffer) {
          await VideoJob.findOneAndUpdate({ jobId }, {
            status: 'failed',
            error: { code: 'VIDEO_FAILED', message: 'Video generation returned no data. Please try again.' }
          });
          return;
        }

        const uploadDir = path.join(__dirname, '../../uploads/posts');
        await fs.mkdir(uploadDir, { recursive: true });
        const filename = `ai-video-${Date.now()}-${Math.floor(Math.random() * 1000)}.mp4`;
        const fullPath = path.join(uploadDir, filename);
        await fs.writeFile(fullPath, buffer);

        // Build URL without req (req is already gone after response was sent)
        const baseUrl = (process.env.BASE_URL || process.env.API_URL || 'https://repmeup.in').replace(/\/api\/?$/, '');
        const videoUrl = `${baseUrl}/api/posts/media/${filename}`;

        await VideoJob.findOneAndUpdate({ jobId }, { status: 'completed', videoUrl });

        await aiCreditService.deductCredits(organizationId, 1, {
          operation: 'post_variants_video', userId, topic: topic.substring(0, 100)
        });

        console.log('[Video] Job completed:', jobId, videoUrl);
      } catch (err) {
        console.error('[Video] Background generation error:', err.message);

        const openaiMsg = err?.response?.data?.error?.message || err?.openaiError || err?.message || '';
        const isSafety =
          (err?.response?.status === 400 || err?.soraFailed) &&
          (openaiMsg.toLowerCase().includes('safety') ||
           openaiMsg.toLowerCase().includes('rejected') ||
           openaiMsg.toLowerCase().includes('content policy') ||
           openaiMsg.toLowerCase().includes('content_policy') ||
           openaiMsg.toLowerCase().includes('violates') ||
           openaiMsg.toLowerCase().includes('blocked') ||
           openaiMsg.toLowerCase().includes('moderation'));

        await VideoJob.findOneAndUpdate({ jobId }, {
          status: 'failed',
          error: isSafety
            ? { code: 'CONTENT_POLICY', message: 'Video blocked due to content policy. Try rephrasing your topic.' }
            : { code: 'VIDEO_FAILED', message: err.message || 'Video generation failed.' }
        });
      }
    })();

  } catch (error) {
    console.error('Generate variant video submit error:', error);
    res.status(500).json({ success: false, message: error.message || 'Failed to start video generation' });
  }
};

/**
 * @desc    Poll the status of a video generation job
 * @route   GET /api/posts/video-job/:jobId
 * @access  Private
 */
exports.getVideoJobStatus = async (req, res) => {
  try {
    const job = await VideoJob.findOne({ jobId: req.params.jobId })
      .select('jobId status videoUrl error')
      .lean();

    if (!job) {
      return res.status(404).json({ success: false, message: 'Job not found or expired' });
    }

    res.json({ success: true, status: job.status, videoUrl: job.videoUrl || null, error: job.error || null });
  } catch (err) {
    console.error('Video job status error:', err);
    res.status(500).json({ success: false, message: 'Failed to fetch job status' });
  }
};

/**
 * @desc    Save an AI-generated variant as a draft
 * @route   POST /api/posts/save-draft
 * @access  Private
 */
exports.saveDraft = async (req, res) => {
  try {
    const {
      platform, content, postType, mediaUrl, generatedBy,
      topic, audience, intent, mood, contentType, postFormat,
      visualStyle, logoOverlay, logoPosition
    } = req.body;
    const organizationId = req.user.organization?._id || req.user.organization;
    const userId = req.user._id;

    if (!platform || !content) {
      return res.status(400).json({ success: false, message: 'platform and content are required' });
    }

    const connection = await PlatformConnection.findOne({
      organization: organizationId,
      platform: platform.toLowerCase(),
      isActive: true
    });

    if (!connection) {
      return res.status(404).json({ success: false, message: `No active ${platform} connection found. Connect the platform in Settings.` });
    }

    const draftData = {
      organization: organizationId,
      user: userId,
      platform: platform.toLowerCase(),
      platformConnection: connection._id,
      content: content.trim(),
      postType: postType || 'post',
      status: 'draft',
      generatedBy: generatedBy || 'ai',
      metadata: {
        topic: topic || '',
        audience: audience || '',
        intent: intent || '',
        mood: mood || '',
        contentType: contentType || 'text',
        postFormat: postFormat || 'post',
        visualStyle: visualStyle || '',
        logoOverlay: logoOverlay || false,
        logoPosition: logoPosition || 'bottom-right'
      }
    };

    if (mediaUrl) {
      const filename = typeof mediaUrl === 'string' ? mediaUrl.split('/api/posts/media/').pop()?.split('?')[0]?.trim() : null;
      if (filename) {
        const uploadDir = path.join(__dirname, '../../uploads/posts');
        const fullPath = path.join(uploadDir, filename);
        draftData.mediaStoragePath = fullPath;
        draftData.mediaType = filename.endsWith('.mp4') ? 'video' : 'image';
      } else {
        draftData.mediaUrl = mediaUrl;
      }
    }

    const draft = await ScheduledPost.create(draftData);
    console.log(`[Content Studio] Draft saved: ${draft._id} for org ${organizationId}`);

    res.status(201).json({ success: true, draft });
  } catch (err) {
    console.error('Save draft error:', err);
    res.status(500).json({ success: false, message: err.message || 'Failed to save draft' });
  }
};

/**
 * @desc    Publish post immediately
 * @route   POST /api/posts/publish
 * @access  Private
 */
exports.publishPost = async (req, res) => {
  upload(req, res, async function (err) {
    if (err) {
      console.error('Upload error:', err);
      return res.status(400).json({ message: err.message });
    }

    try {
      const { platform, content, scheduledFor, postType, mediaLibraryId, mediaLibraryIds, mediaUrl } = req.body;
      const userId = req.user.id;
      const organizationId = req.user.organization?._id || req.user.organization;

      if (!platform || !content) {
        return res.status(400).json({ message: 'Platform and content are required' });
      }

      // Get platform connection
      // For Facebook, we need a page-level connection with platformPageId
      let query = {
        organization: organizationId,
        platform: platform.toLowerCase(),
        isActive: true
      };

      // For Facebook, specifically look for page connections (with platformPageId)
      if (platform.toLowerCase() === 'facebook') {
        query.platformPageId = { $exists: true, $ne: null };
        query.usesAccountSlot = true; // Page connections use account slots
      }

      const connection = await PlatformConnection.findOne(query);

      if (!connection) {
        if (platform.toLowerCase() === 'facebook') {
          return res.status(404).json({ 
            message: 'No Facebook page connection found. Please connect a Facebook page from Settings.' 
          });
        }
        if (platform.toLowerCase() === 'youtube') {
          return res.status(404).json({
            success: false,
            code: 'PLATFORM_NOT_CONNECTED',
            message: 'YouTube is not connected. Go to Settings → Social Accounts and connect your YouTube channel before posting videos.',
            platform: 'youtube'
          });
        }
        return res.status(404).json({ message: `No active ${platform} connection found` });
      }

      // YouTube publishing guard — not yet implemented, guide user to download
      if (platform.toLowerCase() === 'youtube') {
        return res.status(501).json({
          success: false,
          code: 'PLATFORM_NOT_IMPLEMENTED',
          message: 'Direct YouTube publishing is coming soon. For now, download your video and upload it via YouTube Studio.',
          platform: 'youtube',
          downloadUrl: req.body.mediaUrl || null
        });
      }

      // Prepare post data
      const postData = {
        organization: organizationId,
        user: userId,
        platform: platform.toLowerCase(),
        platformConnection: connection._id,
        content: content.trim(),
        postType: postType || 'post'
      };

      // Check if using media from library or uploading new media
      if (mediaLibraryIds && mediaLibraryIds.length > 0) {
        // Multiple media from library (carousel)
        const libraryIds = Array.isArray(mediaLibraryIds) ? mediaLibraryIds : JSON.parse(mediaLibraryIds);
        const libraryMediaItems = await Media.find({
          _id: { $in: libraryIds },
          organization: organizationId
        });

        if (libraryMediaItems.length !== libraryIds.length) {
          return res.status(404).json({
            success: false,
            message: 'Some media items not found in library or do not belong to your organization'
          });
        }

        postData.mediaStoragePaths = libraryMediaItems.map(m => m.filePath);
        postData.mediaTypes = libraryMediaItems.map(m => m.mediaType);
        postData.mediaLibraryIds = libraryMediaItems.map(m => m._id);
        
        // For backward compatibility
        postData.mediaStoragePath = libraryMediaItems[0].filePath;
        postData.mediaType = libraryMediaItems[0].mediaType;

        console.log(`📚 [Post] Using ${libraryMediaItems.length} items from library for carousel`);
      } else if (mediaLibraryId) {
        // Single media from library
        const libraryMedia = await Media.findOne({
          _id: mediaLibraryId,
          organization: organizationId
        });

        if (!libraryMedia) {
          return res.status(404).json({
            success: false,
            message: 'Media not found in library or does not belong to your organization'
          });
        }

        postData.mediaStoragePath = libraryMedia.filePath;
        postData.mediaType = libraryMedia.mediaType;
        postData.mediaLibraryId = libraryMedia._id;

        console.log(`📚 [Post] Using media from library: ${libraryMedia.originalName}`);
      } else if (req.files && req.files.length > 0) {
        // Multiple media files (carousel)
        const mediaStoragePaths = [];
        const mediaTypes = [];
        
        for (const file of req.files) {
          const mediaType = file.mimetype.startsWith('image') ? 'image' : 'video';
          const fileExtension = path.extname(file.originalname);
          
          // Validate each media file
          const validation = validateMedia(
            platform.toLowerCase(),
            mediaType,
            file.size,
            fileExtension,
            postType
          );

          if (!validation.valid) {
            // Delete all uploaded files on validation failure
            for (const f of req.files) {
              try {
                await fs.unlink(f.path);
              } catch (err) {
                console.error('Error deleting file:', err);
              }
            }
            
            return res.status(400).json({
              success: false,
              message: `Media validation failed for ${file.originalname}`,
              errors: validation.errors,
              warnings: validation.warnings
            });
          }

          if (validation.warnings.length > 0) {
            console.warn(`⚠️ Media warnings for ${file.originalname}:`, validation.warnings);
          }

          mediaStoragePaths.push(file.path);
          mediaTypes.push(mediaType);
        }

        postData.mediaStoragePaths = mediaStoragePaths;
        postData.mediaTypes = mediaTypes;
        
        // For backward compatibility, also set single media fields to first item
        postData.mediaStoragePath = mediaStoragePaths[0];
        postData.mediaType = mediaTypes[0];
        
        console.log(`📎 [Upload] ${mediaStoragePaths.length} media files uploaded for carousel`);
      } else if (req.file) {
        // Single media file (legacy support)
        const mediaType = req.file.mimetype.startsWith('image') ? 'image' : 'video';
        const fileExtension = path.extname(req.file.originalname);
        
        // Validate media against platform requirements
        const validation = validateMedia(
          platform.toLowerCase(),
          mediaType,
          req.file.size,
          fileExtension,
          postType
        );

        if (!validation.valid) {
          // Delete uploaded file
          try {
            await fs.unlink(req.file.path);
          } catch (err) {
            console.error('Error deleting invalid file:', err);
          }
          
          return res.status(400).json({
            success: false,
            message: 'Media validation failed',
            errors: validation.errors,
            warnings: validation.warnings
          });
        }

        // Log warnings if any
        if (validation.warnings.length > 0) {
          console.warn('⚠️ Media warnings:', validation.warnings);
        }

        postData.mediaStoragePath = req.file.path;
        postData.mediaType = mediaType;
      } else if (mediaUrl && typeof mediaUrl === 'string' && mediaUrl.includes('/api/posts/media/')) {
        const filename = mediaUrl.split('/api/posts/media/').pop()?.split('?')[0]?.trim();
        if (filename) {
          const uploadDir = path.join(__dirname, '../../uploads/posts');
          const fullPath = path.join(uploadDir, filename);
          try {
            await fs.access(fullPath);
            postData.mediaStoragePath = fullPath;
            postData.mediaType = 'image';
          } catch {
            console.warn('[Publish] AI-generated media file not found, publishing without image');
          }
        }
      }

      // If scheduled for later, save and return
      if (scheduledFor) {
        postData.scheduledFor = new Date(scheduledFor);
        postData.status = 'scheduled';

        const scheduledPost = await ScheduledPost.create(postData);

        return res.status(201).json({
          message: 'Post scheduled successfully',
          post: scheduledPost
        });
      }

      // Publish immediately
      postData.status = 'publishing';
      const post = await ScheduledPost.create(postData);

      let result;
      try {
        // Publish to platform
        switch (platform.toLowerCase()) {
          case 'instagram':
            result = await publishToInstagram(connection, post, req);
            break;
          case 'facebook':
            result = await publishToFacebook(connection, post, req);
            break;
          case 'linkedin':
            result = await publishToLinkedIn(connection, post);
            break;
          case 'youtube':
            // Guarded above — should not reach here
            throw new Error('YouTube publishing is not yet implemented. Please upload via YouTube Studio.');
          default:
            throw new Error(`Publishing to ${platform} is not yet supported`);
        }

        // Update post with result
        post.status = 'published';
        post.publishedAt = new Date();
        post.platformPostId = result.postId;
        post.platformPostUrl = result.postUrl;
        await post.save();

        // Track media usage if using library media
        if (post.mediaLibraryId) {
          try {
            const media = await Media.findById(post.mediaLibraryId);
            if (media) {
              await media.incrementUsage();
              console.log(`📈 [Media Library] Usage incremented for ${media.originalName}`);
            }
          } catch (err) {
            console.error('Error tracking media usage:', err);
            // Non-critical, don't fail the request
          }
        }

        // Track usage for carousel media
        if (post.mediaLibraryIds && post.mediaLibraryIds.length > 0) {
          try {
            for (const mediaId of post.mediaLibraryIds) {
              const media = await Media.findById(mediaId);
              if (media) {
                await media.incrementUsage();
              }
            }
            console.log(`📈 [Media Library] Usage incremented for ${post.mediaLibraryIds.length} carousel items`);
          } catch (err) {
            console.error('Error tracking carousel media usage:', err);
            // Non-critical, don't fail the request
          }
        }

        res.status(201).json({
          message: 'Post published successfully',
          post: post,
          platformPostUrl: result.postUrl
        });
      } catch (error) {
        console.error('Publishing error:', error);
        post.status = 'failed';
        post.error = error.message;
        await post.save();

        // Return detailed platform error if available
        const errorResponse = {
          message: 'Failed to publish post',
          error: error.message
        };

        if (error.platformError) {
          errorResponse.platformError = error.platformError;
        }

        res.status(500).json(errorResponse);
      }
    } catch (error) {
      console.error('Publish post error:', error);
      res.status(500).json({ message: error.message });
    }
  });
};

/**
 * @desc    Schedule post for later
 * @route   POST /api/posts/schedule
 * @access  Private
 */
exports.schedulePost = async (req, res) => {
  upload(req, res, async function (err) {
    if (err) {
      console.error('Upload error:', err);
      return res.status(400).json({ message: err.message });
    }

    try {
      const { platform, content, scheduledFor, postType, mediaLibraryId, mediaUrl } = req.body;
      const userId = req.user.id;
      const organizationId = req.user.organization?._id || req.user.organization;

      if (!platform || !content || !scheduledFor) {
        return res.status(400).json({ message: 'Platform, content, and scheduledFor are required' });
      }

      let query = {
        organization: organizationId,
        platform: platform.toLowerCase(),
        isActive: true
      };
      if (platform.toLowerCase() === 'facebook') {
        query.platformPageId = { $exists: true, $ne: null };
        query.usesAccountSlot = true;
      }
      const connection = await PlatformConnection.findOne(query);

      if (!connection) {
        if (platform.toLowerCase() === 'facebook') {
          return res.status(404).json({ 
            message: 'No Facebook page connection found. Please connect a Facebook page from Settings.' 
          });
        }
        return res.status(404).json({ message: `No active ${platform} connection found` });
      }

      const postData = {
        organization: organizationId,
        user: userId,
        platform: platform.toLowerCase(),
        platformConnection: connection._id,
        content: content.trim(),
        scheduledFor: new Date(scheduledFor),
        status: 'scheduled',
        postType: postType || 'post'
      };

      // Check if using media from library, AI-generated media URL, or uploading new media
      if (mediaLibraryId) {
        // Use media from library
        const libraryMedia = await Media.findOne({
          _id: mediaLibraryId,
          organization: organizationId
        });

        if (!libraryMedia) {
          return res.status(404).json({
            success: false,
            message: 'Media not found in library or does not belong to your organization'
          });
        }

        // Use library media's file path and type
        postData.mediaStoragePath = libraryMedia.filePath;
        postData.mediaType = libraryMedia.mediaType;
        postData.mediaLibraryId = libraryMedia._id; // Track which library media is used

        console.log(`📚 [Post] Using media from library: ${libraryMedia.originalName} (${libraryMedia._id})`);
      } else if (mediaUrl && typeof mediaUrl === 'string' && mediaUrl.includes('/api/posts/media/')) {
        const filename = mediaUrl.split('/api/posts/media/').pop()?.split('?')[0]?.trim();
        if (filename) {
          const uploadDir = path.join(__dirname, '../../uploads/posts');
          const fullPath = path.join(uploadDir, filename);
          try {
            await fs.access(fullPath);
            postData.mediaStoragePath = fullPath;
            postData.mediaType = 'image';
          } catch {
            // File not found, ignore mediaUrl
          }
        }
      } else if (req.file) {
        const mediaType = req.file.mimetype.startsWith('image') ? 'image' : 'video';
        const fileExtension = path.extname(req.file.originalname);
        
        // Validate media against platform requirements
        const validation = validateMedia(
          platform.toLowerCase(),
          mediaType,
          req.file.size,
          fileExtension,
          postType
        );

        if (!validation.valid) {
          // Delete uploaded file
          try {
            await fs.unlink(req.file.path);
          } catch (err) {
            console.error('Error deleting invalid file:', err);
          }
          
          return res.status(400).json({
            success: false,
            message: 'Media validation failed',
            errors: validation.errors,
            warnings: validation.warnings
          });
        }

        // Log warnings if any
        if (validation.warnings.length > 0) {
          console.warn('⚠️ Media warnings:', validation.warnings);
        }

        postData.mediaStoragePath = req.file.path;
        postData.mediaType = mediaType;
      }

      const scheduledPost = await ScheduledPost.create(postData);

      res.status(201).json({
        message: 'Post scheduled successfully',
        post: scheduledPost
      });
    } catch (error) {
      console.error('Schedule post error:', error);
      res.status(500).json({ message: error.message });
    }
  });
};

/**
 * @desc    Get dashboard counts (scheduled, pending approval, AI %)
 * @route   GET /api/posts/dashboard-counts
 * @access  Private
 */
exports.getDashboardCounts = async (req, res) => {
  try {
    const organizationId = req.user.organization?._id || req.user.organization;

    const [scheduled, pendingApproval, totalPosts, aiGenerated] = await Promise.all([
      ScheduledPost.countDocuments({ organization: organizationId, status: 'scheduled' }),
      ScheduledPost.countDocuments({ organization: organizationId, status: 'pending_approval' }),
      ScheduledPost.countDocuments({ organization: organizationId, status: { $in: ['scheduled', 'published', 'draft', 'pending_approval'] } }),
      ScheduledPost.countDocuments({ organization: organizationId, generatedBy: 'ai', status: { $in: ['scheduled', 'published'] } })
    ]);

    const aiGeneratedPercent = totalPosts > 0 ? Math.round((aiGenerated / totalPosts) * 100) : 0;

    res.status(200).json({
      success: true,
      data: { scheduled, pendingApproval, aiGeneratedPercent }
    });
  } catch (error) {
    console.error('Get dashboard counts error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
};

/**
 * @desc    Get all scheduled posts
 * @route   GET /api/posts/scheduled
 * @access  Private
 */
exports.getScheduledPosts = async (req, res) => {
  try {
    const organizationId = req.user.organization?._id || req.user.organization;

    const posts = await ScheduledPost.find({
      organization: organizationId,
      status: 'scheduled'
    })
      .sort({ scheduledFor: 1 })
      .populate('platformConnection', 'platform platformPageId platformUsername')
      .lean();

    res.status(200).json({ 
      success: true,
      data: posts,
      count: posts.length
    });
  } catch (error) {
    console.error('Get scheduled posts error:', error);
    res.status(500).json({ 
      success: false,
      error: error.message 
    });
  }
};

/**
 * @desc    Get posts pending approval (Approval Queue)
 * @route   GET /api/posts/pending-approval
 * @access  Private
 */
exports.getPendingApprovalPosts = async (req, res) => {
  try {
    const organizationId = req.user.organization?._id || req.user.organization;

    const posts = await ScheduledPost.find({
      organization: organizationId,
      status: 'pending_approval'
    })
      .sort({ createdAt: -1 })
      .populate('platformConnection', 'platform platformPageId platformUsername')
      .populate('user', 'name email')
      .lean();

    res.status(200).json({
      success: true,
      data: posts,
      count: posts.length
    });
  } catch (error) {
    console.error('Get pending approval posts error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
};

/**
 * @desc    Approve a post (optionally set scheduledFor and status to scheduled)
 * @route   PATCH /api/posts/:id/approve
 * @access  Private
 */
exports.approvePost = async (req, res) => {
  try {
    const { id } = req.params;
    const { scheduledFor } = req.body;
    const organizationId = req.user.organization?._id || req.user.organization;

    const post = await ScheduledPost.findOne({
      _id: id,
      organization: organizationId,
      status: 'pending_approval'
    });

    if (!post) {
      return res.status(404).json({
        success: false,
        message: 'Post not found or not pending approval'
      });
    }

    post.status = scheduledFor ? 'scheduled' : 'draft';
    post.approvedBy = req.user._id;
    post.approvedAt = new Date();
    if (scheduledFor) post.scheduledFor = new Date(scheduledFor);
    await post.save();

    await auditLogController.log(
      organizationId,
      'post',
      post._id,
      'approved',
      req.user._id,
      { scheduledFor: post.scheduledFor, status: post.status }
    );

    res.status(200).json({
      success: true,
      data: post
    });
  } catch (error) {
    console.error('Approve post error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
};

/**
 * @desc    Reject a post
 * @route   PATCH /api/posts/:id/reject
 * @access  Private
 */
exports.rejectPost = async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;
    const organizationId = req.user.organization?._id || req.user.organization;

    const post = await ScheduledPost.findOne({
      _id: id,
      organization: organizationId,
      status: 'pending_approval'
    });

    if (!post) {
      return res.status(404).json({
        success: false,
        message: 'Post not found or not pending approval'
      });
    }

    post.status = 'rejected';
    post.rejectedBy = req.user._id;
    post.rejectedAt = new Date();
    if (reason) post.rejectedReason = reason;
    await post.save();

    await auditLogController.log(
      organizationId,
      'post',
      post._id,
      'rejected',
      req.user._id,
      { reason: post.rejectedReason }
    );

    res.status(200).json({
      success: true,
      data: post
    });
  } catch (error) {
    console.error('Reject post error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
};

/**
 * @desc    Create post as pending approval (Send to Approval from Content Studio)
 * @route   POST /api/posts/to-approval
 * @access  Private
 */
exports.sendToApproval = async (req, res) => {
  try {
    const { platform, content, postType, originalContent, riskScore, complianceFlags, generatedBy, mediaUrl } = req.body;
    const organizationId = req.user.organization?._id || req.user.organization;
    const userId = req.user._id;

    if (!platform || !content) {
      return res.status(400).json({
        success: false,
        message: 'Platform and content are required'
      });
    }

    const connection = await PlatformConnection.findOne({
      organization: organizationId,
      platform: platform.toLowerCase(),
      isActive: true
    });

    if (!connection) {
      return res.status(404).json({
        success: false,
        message: `No active ${platform} connection found`
      });
    }

    const postData = {
      organization: organizationId,
      user: userId,
      platform: platform.toLowerCase(),
      platformConnection: connection._id,
      content: content.trim(),
      status: 'pending_approval',
      postType: postType || 'post',
      originalContent: originalContent || content.trim(),
      riskScore: riskScore != null ? Number(riskScore) : undefined,
      complianceFlags: Array.isArray(complianceFlags) ? complianceFlags : [],
      generatedBy: generatedBy === 'ai' ? 'ai' : 'human'
    };

    if (mediaUrl && typeof mediaUrl === 'string' && mediaUrl.includes('/api/posts/media/')) {
      const filename = mediaUrl.split('/api/posts/media/').pop()?.split('?')[0]?.trim();
      if (filename) {
        const uploadDir = path.join(__dirname, '../../uploads/posts');
        const fullPath = path.join(uploadDir, filename);
        try {
          await fs.access(fullPath);
          postData.mediaStoragePath = fullPath;
          postData.mediaType = 'image';
        } catch {
          // File not found
        }
      }
    }

    const post = await ScheduledPost.create(postData);

    res.status(201).json({
      success: true,
      data: post
    });
  } catch (error) {
    console.error('Send to approval error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
};

/**
 * @desc    Get all published posts
 * @route   GET /api/posts/published
 * @access  Private
 */
exports.getPublishedPosts = async (req, res) => {
  try {
    const organizationId = req.user.organization?._id || req.user.organization;

    const posts = await ScheduledPost.find({
      organization: organizationId,
      status: 'published'
    })
      .sort({ publishedAt: -1 })
      .populate('platformConnection', 'platform platformPageId platformUsername')
      .lean();

    res.status(200).json({ posts });
  } catch (error) {
    console.error('Get published posts error:', error);
    res.status(500).json({ message: error.message });
  }
};

/**
 * @desc    Delete scheduled post
 * @route   DELETE /api/posts/scheduled/:id
 * @access  Private
 */
exports.reschedulePost = async (req, res) => {
  try {
    const organizationId = req.user.organization?._id || req.user.organization;
    const { scheduledFor } = req.body;
    if (!scheduledFor) {
      return res.status(400).json({ success: false, message: 'scheduledFor is required' });
    }
    const post = await ScheduledPost.findOneAndUpdate(
      { _id: req.params.id, organization: organizationId, status: 'scheduled' },
      { $set: { scheduledFor: new Date(scheduledFor) } },
      { new: true }
    );
    if (!post) {
      return res.status(404).json({ success: false, message: 'Scheduled post not found' });
    }
    res.status(200).json({ success: true, data: post });
  } catch (error) {
    console.error('Reschedule post error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
};

/**
 * @desc    Delete scheduled post
 * @route   DELETE /api/posts/scheduled/:id
 * @access  Private
 */
exports.deleteScheduledPost = async (req, res) => {
  try {
    const organizationId = req.user.organization?._id || req.user.organization;
    const post = await ScheduledPost.findOne({
      _id: req.params.id,
      organization: organizationId,
      status: 'scheduled'
    });

    if (!post) {
      return res.status(404).json({ message: 'Scheduled post not found' });
    }

    // Delete media files (carousel or single)
    if (post.mediaStoragePaths && post.mediaStoragePaths.length > 0) {
      // Carousel - delete all media files
      for (const mediaPath of post.mediaStoragePaths) {
        try {
          await fs.unlink(mediaPath);
          console.log(`🗑️  Deleted carousel media: ${mediaPath}`);
        } catch (err) {
          console.error('Error deleting carousel media:', err);
        }
      }
    } else if (post.mediaStoragePath) {
      // Single media file
      try {
        await fs.unlink(post.mediaStoragePath);
        console.log(`🗑️  Deleted media: ${post.mediaStoragePath}`);
      } catch (err) {
        console.error('Error deleting media file:', err);
      }
    }

    await ScheduledPost.findByIdAndDelete(post._id);
    res.status(200).json({ message: 'Scheduled post deleted' });
  } catch (error) {
    console.error('Delete scheduled post error:', error);
    res.status(500).json({ message: error.message });
  }
};

/**
 * @desc    Get all draft posts for the organisation
 * @route   GET /api/posts/drafts
 * @access  Private
 */
exports.getDraftPosts = async (req, res) => {
  try {
    const organizationId = req.user.organization?._id || req.user.organization;

    const posts = await ScheduledPost.find({
      organization: organizationId,
      status: 'draft'
    })
      .sort({ createdAt: -1 })
      .populate('platformConnection', 'platform platformPageId platformUsername')
      .lean();

    res.status(200).json({ success: true, data: posts, count: posts.length });
  } catch (error) {
    console.error('Get draft posts error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
};

/**
 * @desc    Update draft content / fields
 * @route   PATCH /api/posts/drafts/:id
 * @access  Private
 */
exports.updateDraft = async (req, res) => {
  try {
    const organizationId = req.user.organization?._id || req.user.organization;
    const { id } = req.params;
    const { content } = req.body;

    const draft = await ScheduledPost.findOne({
      _id: id,
      organization: organizationId,
      status: 'draft'
    });

    if (!draft) {
      return res.status(404).json({ success: false, message: 'Draft not found' });
    }

    if (content !== undefined) draft.content = content.trim();
    await draft.save();

    res.status(200).json({ success: true, data: draft });
  } catch (error) {
    console.error('Update draft error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
};

/**
 * @desc    Schedule a draft (move to scheduled status)
 * @route   PATCH /api/posts/drafts/:id/schedule
 * @access  Private
 */
exports.scheduleDraft = async (req, res) => {
  try {
    const organizationId = req.user.organization?._id || req.user.organization;
    const { id } = req.params;
    const { scheduledFor } = req.body;

    if (!scheduledFor) {
      return res.status(400).json({ success: false, message: 'scheduledFor is required' });
    }

    const draft = await ScheduledPost.findOne({
      _id: id,
      organization: organizationId,
      status: 'draft'
    });

    if (!draft) {
      return res.status(404).json({ success: false, message: 'Draft not found' });
    }

    draft.status = 'scheduled';
    draft.scheduledFor = new Date(scheduledFor);
    await draft.save();

    res.status(200).json({ success: true, data: draft });
  } catch (error) {
    console.error('Schedule draft error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
};

/**
 * @desc    Delete a draft post
 * @route   DELETE /api/posts/drafts/:id
 * @access  Private
 */
exports.deleteDraft = async (req, res) => {
  try {
    const organizationId = req.user.organization?._id || req.user.organization;
    const draft = await ScheduledPost.findOne({
      _id: req.params.id,
      organization: organizationId,
      status: 'draft'
    });

    if (!draft) {
      return res.status(404).json({ success: false, message: 'Draft not found' });
    }

    // Clean up local media files
    if (draft.mediaStoragePath) {
      try { await fs.unlink(draft.mediaStoragePath); } catch (_) {}
    }
    if (draft.mediaStoragePaths?.length) {
      for (const p of draft.mediaStoragePaths) {
        try { await fs.unlink(p); } catch (_) {}
      }
    }

    await ScheduledPost.findByIdAndDelete(draft._id);
    res.status(200).json({ success: true, message: 'Draft deleted' });
  } catch (error) {
    console.error('Delete draft error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
};

/**
 * @desc    Publish a draft immediately to the connected platform
 * @route   POST /api/posts/drafts/:id/publish
 * @access  Private
 */
exports.publishDraft = async (req, res) => {
  try {
    const organizationId = req.user.organization?._id || req.user.organization;

    const draft = await ScheduledPost.findOne({
      _id: req.params.id,
      organization: organizationId,
      status: 'draft'
    }).populate('platformConnection');

    if (!draft) {
      return res.status(404).json({ success: false, message: 'Draft not found' });
    }

    const connection = draft.platformConnection;
    if (!connection) {
      return res.status(400).json({ success: false, message: 'Platform connection not found on this draft.' });
    }

    const platform = draft.platform.toLowerCase();

    if (platform === 'youtube') {
      return res.status(501).json({
        success: false,
        code: 'PLATFORM_NOT_IMPLEMENTED',
        message: 'Direct YouTube publishing is coming soon. For now, download your video and upload it via YouTube Studio.',
        platform: 'youtube'
      });
    }

    // Transition to publishing state
    draft.status = 'publishing';
    await draft.save();

    let result;
    try {
      switch (platform) {
        case 'instagram':
          result = await publishToInstagram(connection, draft, req);
          break;
        case 'facebook':
          result = await publishToFacebook(connection, draft, req);
          break;
        case 'linkedin':
          result = await publishToLinkedIn(connection, draft);
          break;
        default:
          throw new Error(`Publishing to ${platform} is not yet supported`);
      }

      draft.status = 'published';
      draft.publishedAt = new Date();
      draft.platformPostId = result.postId;
      draft.platformPostUrl = result.postUrl;
      await draft.save();

      res.status(200).json({
        success: true,
        message: 'Draft published successfully',
        data: draft,
        platformPostUrl: result.postUrl
      });
    } catch (publishError) {
      console.error('Publish draft platform error:', publishError);
      draft.status = 'failed';
      draft.error = publishError.message;
      await draft.save();

      const errorResponse = {
        success: false,
        message: 'Failed to publish draft',
        error: publishError.message
      };
      if (publishError.platformError) errorResponse.platformError = publishError.platformError;
      res.status(500).json(errorResponse);
    }
  } catch (error) {
    console.error('Publish draft error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
};

/**
 * @desc    Get media requirements for platforms
 * @route   GET /api/posts/media-requirements
 * @access  Public
 */
exports.getMediaRequirements = (req, res) => {
  try {
    const { platform, postType } = req.query;

    if (platform) {
      const requirements = getRequirementsText(platform, postType || 'post');
      if (!requirements) {
        return res.status(404).json({
          success: false,
          message: `Requirements for platform ${platform} not found`
        });
      }
      return res.status(200).json({
        success: true,
        data: requirements
      });
    }

    // Return all platforms
    const allRequirements = {
      facebook: getRequirementsText('facebook', postType || 'post'),
      instagram: getRequirementsText('instagram', postType || 'post'),
      linkedin: getRequirementsText('linkedin', postType || 'post')
    };

    res.status(200).json({
      success: true,
      data: allRequirements
    });
  } catch (error) {
    console.error('Get media requirements error:', error);
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
};

/**
 * Helper: Get public URL for media file (must be reachable by Instagram/Facebook)
 */
function getPublicMediaUrl(filePath, req) {
  const filename = path.basename(filePath);

  let baseUrl = process.env.BASE_URL || process.env.API_URL;

  if (!baseUrl && req && req.get && req.get('host')) {
    const protocol = req.protocol || 'https';
    const host = req.get('host');
    baseUrl = `${protocol}://${host}`;
  }

  if (!baseUrl) {
    // Default to production URL if available, otherwise localhost
    baseUrl = 'https://repmeup.in';
  }

  // Ensure baseUrl doesn't have /api at the end
  baseUrl = baseUrl.replace(/\/api\/?$/, '');

  const publicUrl = `${baseUrl}/api/posts/media/${filename}`;
  console.log(`📎 [Media] Generated public URL: ${publicUrl}`);
  console.log(`📎 [Media] Base URL: ${baseUrl}, Protocol: ${req?.protocol}, Host: ${req?.get?.('host')}`);
  return publicUrl;
}

/**
 * Helper: Publish to Instagram
 */
async function publishToInstagram(connection, post, req) {
  const { content, mediaStoragePath, mediaStoragePaths, mediaType, mediaTypes, postType } = post;

  // Check if carousel (multiple media)
  const isCarousel = mediaStoragePaths && mediaStoragePaths.length > 1;

  if (!mediaStoragePath && !isCarousel) {
    throw new Error('Instagram posts require an image or video');
  }

  let result;

  // Handle carousel posts (multiple media)
  if (isCarousel) {
    console.log(`🎠 [Instagram] Publishing carousel with ${mediaStoragePaths.length} items`);
    
    // Generate public URLs for all media
    const mediaUrls = mediaStoragePaths.map((storagePath, index) => {
      return {
        url: getPublicMediaUrl(storagePath, req),
        type: mediaTypes[index]
      };
    });

    result = await instagramService.createCarouselPost(connection, {
      caption: content,
      mediaUrls: mediaUrls
    });

    return {
      postId: result.postId,
      postUrl: result.postUrl
    };
  }

  // Handle single media posts
  const mediaUrl = getPublicMediaUrl(mediaStoragePath, req);
  console.log(`📸 [Instagram] Publishing ${postType || 'post'} with media: ${mediaUrl}`);

  // Route to appropriate method based on post type
  switch (postType) {
    case 'story':
      console.log(`📖 [Instagram] Creating story`);
      result = await instagramService.createStory(connection, {
        mediaUrl: mediaUrl,
        mediaType: mediaType
      });
      break;

    case 'reel':
      if (mediaType !== 'video') {
        throw new Error('Instagram Reels require a video file');
      }
      console.log(`🎬 [Instagram] Creating reel`);
      result = await instagramService.createReel(connection, {
        caption: content,
        mediaUrl: mediaUrl
      });
      break;

    case 'post':
    default:
      console.log(`📸 [Instagram] Creating regular post`);
      result = await instagramService.createPost(connection, {
        caption: content,
        mediaUrl: mediaUrl,
        mediaType: mediaType
      });
      break;
  }

  return {
    postId: result.postId,
    postUrl: result.postUrl
  };
}

/**
 * Helper: Publish to Facebook (pages_manage_posts)
 */
async function publishToFacebook(connection, post, req) {
  const { content, mediaStoragePath, mediaType, postType } = post;
  
  console.log(`📘 [Facebook] Publishing ${postType || 'post'} with media: ${mediaStoragePath ? 'yes' : 'no'}`);

  let result;

  // Route to appropriate method based on post type
  switch (postType) {
    case 'story':
      // Facebook Stories
      if (!mediaStoragePath) {
        throw new Error('Facebook stories require an image or video');
      }
      
      console.log(`📖 [Facebook] Creating story`);
      
      if (mediaType === 'image') {
        const imageBuffer = await fs.readFile(mediaStoragePath);
        result = await facebookService.createStory(connection, {
          imageBuffer: imageBuffer
        });
      } else if (mediaType === 'video') {
        const videoUrl = getPublicMediaUrl(mediaStoragePath, req);
        result = await facebookService.createStory(connection, {
          videoUrl: videoUrl
        });
      } else {
        throw new Error('Invalid media type for story');
      }
      break;

    case 'reel':
    case 'short':
      // Facebook Reels (also called Shorts)
      if (!mediaStoragePath || mediaType !== 'video') {
        throw new Error('Facebook Reels require a video file');
      }
      
      console.log(`🎬 [Facebook] Creating reel/short`);
      const reelVideoUrl = getPublicMediaUrl(mediaStoragePath, req);
      
      result = await facebookService.createReel(connection, {
        videoUrl: reelVideoUrl,
        description: content,
        title: content ? content.substring(0, 50) : 'Reel'
      });
      break;

    case 'post':
    default:
      // Regular Facebook Post
      if (mediaStoragePath && mediaType === 'image') {
        try {
          console.log(`📸 [Facebook] Reading image file: ${mediaStoragePath}`);
          
          // Read the image file as a buffer
          const imageBuffer = await fs.readFile(mediaStoragePath);
          
          console.log(`📤 [Facebook] Uploading image directly (${imageBuffer.length} bytes)`);
          
          const payload = { 
            message: content || ' ',
            imageBuffer: imageBuffer
          };
          
          result = await facebookService.createPost(connection, payload);
        } catch (imageError) {
          console.warn(`⚠️ [Facebook] Direct image upload failed, falling back to text-only:`, imageError.message);
          
          // Fallback: Post as text-only to feed
          const textPayload = { message: content || 'Posted from RepMeUp' };
          result = await facebookService.createPost(connection, textPayload);
        }
      } else if (mediaStoragePath && mediaType === 'video') {
        // Video post
        const videoUrl = getPublicMediaUrl(mediaStoragePath, req);
        result = await facebookService.createVideoPost(connection, {
          videoUrl: videoUrl,
          description: content
        });
      } else {
        // Text-only post
        console.log(`📝 [Facebook] Publishing text-only post`);
        const payload = { message: content || 'Posted from RepMeUp' };
        result = await facebookService.createPost(connection, payload);
      }
      break;
  }

  return {
    postId: result.postId,
    postUrl: result.postUrl
  };
}

/**
 * Helper: Publish to LinkedIn (Company Page or personal profile)
 */
async function publishToLinkedIn(connection, post) {
  const { content, mediaStoragePath, mediaStoragePaths, mediaType, mediaTypes } = post;

  let storagePath = mediaStoragePath;
  let resolvedType = mediaType;
  if (!storagePath && mediaStoragePaths && mediaStoragePaths.length > 0) {
    storagePath = mediaStoragePaths[0];
    resolvedType = (mediaTypes && mediaTypes[0]) || 'image';
  }

  console.log(
    `💼 [LinkedIn] Publishing post (media: ${storagePath ? resolvedType || 'file' : 'none'})`
  );

  let media = null;
  if (storagePath) {
    if (resolvedType === 'video') {
      throw new Error(
        'LinkedIn publishing with video is not supported yet. Use an image or text-only post.'
      );
    }
    if (resolvedType === 'image') {
      const imageBuffer = await fs.readFile(storagePath);
      const ext = path.extname(storagePath).toLowerCase();
      const contentType =
        ext === '.png'
          ? 'image/png'
          : ext === '.gif'
            ? 'image/gif'
            : ext === '.webp'
              ? 'image/webp'
              : 'image/jpeg';
      media = { imageBuffer, contentType };
    }
  }

  const result = await linkedinService.createPost(connection, content || '', media);

  return {
    postId: result.postId,
    postUrl: result.postUrl
  };
}

/**
 * Execute publish for a single scheduled post (used by processScheduledPublish job).
 */
exports.executePublishForScheduledPost = async function (postId) {
  const post = await ScheduledPost.findById(postId).populate('platformConnection');
  if (!post || post.status !== 'scheduled') {
    return { success: false, error: 'Post not found or not scheduled' };
  }
  const connection = post.platformConnection;
  if (!connection) {
    post.status = 'failed';
    post.error = 'Platform connection not found';
    await post.save();
    return { success: false, error: post.error };
  }
  const req = {
    protocol: 'https',
    get: (name) => (name === 'host' ? (process.env.API_URL || process.env.BASE_URL || 'localhost:3000').replace(/^https?:\/\//, '') : null)
  };
  post.status = 'publishing';
  await post.save();
  try {
    let result;
    if (post.platform === 'instagram') {
      result = await publishToInstagram(connection, post, req);
    } else if (post.platform === 'facebook') {
      result = await publishToFacebook(connection, post, req);
    } else if (post.platform === 'linkedin') {
      result = await publishToLinkedIn(connection, post);
    } else {
      post.status = 'failed';
      post.error = 'Unsupported platform: ' + post.platform;
      await post.save();
      return { success: false, error: post.error };
    }
    post.status = 'published';
    post.publishedAt = new Date();
    post.platformPostId = result.postId;
    post.platformPostUrl = result.postUrl;
    post.error = undefined;
    await post.save();
    return { success: true };
  } catch (err) {
    post.status = 'failed';
    post.error = err.message;
    await post.save();
    return { success: false, error: err.message };
  }
};
