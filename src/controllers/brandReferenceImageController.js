const BrandReferenceImage = require('../models/BrandReferenceImage');
const BrandConfig = require('../models/BrandConfig');
const storageService = require('../services/storageService');
const aiService = require('../services/aiService');
const logger = require('../config/logger');
const { sanitizeStringArray } = require('../utils/brandConfigValidation');
const { topClusteredColors } = require('../utils/colorClustering');

const MAX_IMAGES_PER_ORG = 20;
const CATEGORY_OPTIONS = ['general', 'product', 'lifestyle', 'event', 'typography', 'layout'];
const TAGS_MAX_COUNT = 20;
const TAGS_MAX_LEN = 40;

/** Parse the `tags` field which may arrive as a JSON string or an array. */
function parseTagsInput(tags) {
  let parsed = [];
  if (typeof tags === 'string') {
    try { parsed = JSON.parse(tags); } catch {
      parsed = tags.split(',').map((t) => t.trim()).filter(Boolean);
    }
  } else if (Array.isArray(tags)) {
    parsed = tags;
  }
  const { value } = sanitizeStringArray(parsed, { maxItems: TAGS_MAX_COUNT, maxLength: TAGS_MAX_LEN });
  return value;
}

const IMAGE_ANALYSIS_PROMPT = `Analyze this brand reference image and return a JSON object:
{
  "dominantColors": ["#hex1","#hex2","#hex3","#hex4","#hex5"],
  "compositionType": "centered" | "rule-of-thirds" | "full-bleed-text" | "asymmetric" | "other",
  "textDensity": "none" | "minimal" | "moderate" | "heavy",
  "typographyStyle": "description of font style if text is visible",
  "logoPosition": "top-left" | "top-right" | "bottom-left" | "bottom-right" | "center" | "none",
  "mood": "single phrase describing mood",
  "layoutPattern": "single-product" | "collage" | "split-screen" | "full-photo" | "text-overlay" | "other"
}

dominantColors rules:
- Return 5 precise hex colors sampled from DIFFERENT regions: background/base, main subject/product, accent details (buttons, borders, packaging), and shadows/highlights — not just the single largest or darkest area.
- Include subtle/secondary tones even from small areas (e.g. a muted accent color, a shadow tone, a texture color) — do not oversimplify a dark image down to just black/near-black hex values. Use accurate hex precision, not rounded to #000000/#FFFFFF unless truly pure black/white.

Return ONLY valid JSON.`;

/**
 * @desc    List reference images for current org
 * @route   GET /api/brand-config/reference-images
 */
exports.list = async (req, res) => {
  try {
    const orgId = req.user.organization?._id || req.user.organization;
    const images = await BrandReferenceImage.find({ organization: orgId })
      .sort({ sortOrder: 1, createdAt: -1 })
      .lean();
    res.json({ success: true, data: images, total: images.length, max: MAX_IMAGES_PER_ORG });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

/**
 * @desc    Upload reference images (up to 5 per request)
 * @route   POST /api/brand-config/reference-images
 */
exports.upload = async (req, res) => {
  try {
    const orgId = req.user.organization?._id || req.user.organization;
    if (!req.files?.length) {
      return res.status(400).json({ success: false, error: 'No files uploaded' });
    }

    const existing = await BrandReferenceImage.countDocuments({ organization: orgId });
    if (existing + req.files.length > MAX_IMAGES_PER_ORG) {
      return res.status(400).json({
        success: false,
        error: `Maximum ${MAX_IMAGES_PER_ORG} reference images allowed (you have ${existing}).`
      });
    }

    const category = req.body.category && CATEGORY_OPTIONS.includes(req.body.category)
      ? req.body.category
      : 'general';
    const tags = parseTagsInput(req.body.tags);

    const created = [];
    for (const file of req.files) {
      let imageUrl, s3Key;
      if (storageService.isS3Configured()) {
        s3Key = `brand-references/${orgId}/${Date.now()}-${file.originalname}`;
        const result = await storageService.uploadBuffer(s3Key, file.buffer, file.mimetype);
        imageUrl = result.publicUrl || result.url;
      } else {
        const fs = require('fs');
        const path = require('path');
        const dir = path.join(__dirname, '../../uploads/brand-references');
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        const filename = `${orgId}-${Date.now()}-${file.originalname}`;
        const filepath = path.join(dir, filename);
        fs.writeFileSync(filepath, file.buffer);
        imageUrl = `${process.env.BASE_URL || 'http://localhost:5000'}/uploads/brand-references/${filename}`;
        s3Key = null;
      }

      const doc = await BrandReferenceImage.create({
        organization: orgId,
        imageUrl,
        s3Key,
        category,
        tags,
        sortOrder: existing + created.length
      });
      created.push(doc);

      _analyzeImageAsync(doc._id, imageUrl).catch(err =>
        logger.warn('Reference image analysis failed (non-blocking)', { id: doc._id, err: err.message })
      );
    }

    // Invalidate style cache so next generation re-analyses with the new images
    BrandConfig.updateOne({ organization: orgId }, { $unset: { styleCache: 1 } }).catch(() => {});

    res.status(201).json({ success: true, data: created });
  } catch (err) {
    logger.error('Reference image upload error', { error: err.message });
    res.status(500).json({ success: false, error: err.message });
  }
};

/**
 * @desc    Re-run AI color/style analysis on ALL of the org's existing
 *          reference images (e.g. after an analysis-prompt improvement —
 *          images only get analyzed once at upload time otherwise, so
 *          previously-uploaded images would stay stuck with an older,
 *          lower-fidelity palette forever without this).
 * @route   POST /api/brand-config/reference-images/re-analyze
 */
exports.reAnalyzeAll = async (req, res) => {
  try {
    const orgId = req.user.organization?._id || req.user.organization;
    const images = await BrandReferenceImage.find({ organization: orgId })
      .select('_id imageUrl')
      .lean();

    if (!images.length) {
      return res.json({ success: true, message: 'No reference images to analyze', count: 0 });
    }

    // Fire-and-forget, but batched (not all-at-once like upload()) since this
    // can be up to MAX_IMAGES_PER_ORG (20) calls to the Vision API — batching
    // avoids bursting past OpenAI rate limits in one shot.
    const RE_ANALYZE_BATCH_SIZE = 5;
    (async () => {
      for (let i = 0; i < images.length; i += RE_ANALYZE_BATCH_SIZE) {
        const batch = images.slice(i, i + RE_ANALYZE_BATCH_SIZE);
        await Promise.all(batch.map((img) =>
          _analyzeImageAsync(img._id, img.imageUrl).catch((err) =>
            logger.warn('Reference image re-analysis failed (non-blocking)', { id: img._id, err: err.message })
          )
        ));
      }
      // Drop the reference-only vision style cache so the next AI generation
      // call picks up the refreshed colors/style too, not just the grid display.
      await BrandConfig.updateOne({ organization: orgId }, { $unset: { styleCache: 1 } }).catch(() => {});
    })().catch((err) => logger.error('Reference image bulk re-analysis failed', { orgId, err: err.message }));

    res.json({
      success: true,
      message: `Re-analysis started for ${images.length} image(s). This runs in the background — refresh in a few seconds to see updated colors.`,
      count: images.length
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

/**
 * @desc    Update category/tags for a reference image
 * @route   PUT /api/brand-config/reference-images/:id
 */
exports.update = async (req, res) => {
  try {
    const orgId = req.user.organization?._id || req.user.organization;
    const update = {};
    if (req.body.category !== undefined) {
      if (!CATEGORY_OPTIONS.includes(req.body.category)) {
        return res.status(400).json({ success: false, error: `category must be one of: ${CATEGORY_OPTIONS.join(', ')}` });
      }
      update.category = req.body.category;
    }
    if (req.body.tags !== undefined) update.tags = parseTagsInput(req.body.tags);
    if (req.body.sortOrder != null) {
      const sortOrder = Number(req.body.sortOrder);
      if (!Number.isFinite(sortOrder)) {
        return res.status(400).json({ success: false, error: 'sortOrder must be a number' });
      }
      update.sortOrder = sortOrder;
    }

    const doc = await BrandReferenceImage.findOneAndUpdate(
      { _id: req.params.id, organization: orgId },
      { $set: update },
      { new: true, runValidators: true }
    );
    if (!doc) return res.status(404).json({ success: false, error: 'Image not found' });
    res.json({ success: true, data: doc });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

/**
 * @desc    Delete a reference image
 * @route   DELETE /api/brand-config/reference-images/:id
 */
exports.remove = async (req, res) => {
  try {
    const orgId = req.user.organization?._id || req.user.organization;
    const doc = await BrandReferenceImage.findOneAndDelete({ _id: req.params.id, organization: orgId });
    if (!doc) return res.status(404).json({ success: false, error: 'Image not found' });
    if (doc.s3Key) {
      storageService.deleteObjectByKey(doc.s3Key).catch(() => {});
    }
    // Invalidate style cache so next generation re-analyses without this image
    BrandConfig.updateOne({ organization: orgId }, { $unset: { styleCache: 1 } }).catch(() => {});
    res.json({ success: true, message: 'Deleted' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

/**
 * @desc    Get aggregated visual style summary from all reference images
 * @route   GET /api/brand-config/reference-images/style-summary
 */
exports.styleSummary = async (req, res) => {
  try {
    const orgId = req.user.organization?._id || req.user.organization;
    const images = await BrandReferenceImage.find({
      organization: orgId,
      analysis: { $ne: null }
    }).lean();

    if (!images.length) {
      return res.json({ success: true, data: null, message: 'No analyzed images yet' });
    }

    const summary = _aggregateVisualStyle(images);
    res.json({ success: true, data: summary, analyzedCount: images.length });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

// Exposed so contentStudioInputController's "promote ephemeral upload to
// Brand Hub" flow reuses the exact same limit/analysis logic instead of
// duplicating it (SOLID — single source of truth for the reference-library
// contract).
exports.MAX_IMAGES_PER_ORG = MAX_IMAGES_PER_ORG;
exports.CATEGORY_OPTIONS = CATEGORY_OPTIONS;
exports.analyzeImageAsync = _analyzeImageAsync;

async function _analyzeImageAsync(docId, imageUrl) {
  const axios = require('axios');

  // Download image and convert to base64 to avoid URL accessibility issues
  let dataUrl;
  try {
    const resp = await axios.get(imageUrl, { responseType: 'arraybuffer', timeout: 15000 });
    const mime = resp.headers['content-type'] || 'image/jpeg';
    const b64 = Buffer.from(resp.data).toString('base64');
    dataUrl = `data:${mime};base64,${b64}`;
  } catch (dlErr) {
    logger.warn('Reference image analysis: could not download image', { docId, url: imageUrl?.substring(0, 120), error: dlErr.message });
    return;
  }

  try {
    const response = await aiService._postChatCompletions(
      {
        model: aiService.visionModel,
        messages: [
          { role: 'system', content: IMAGE_ANALYSIS_PROMPT },
          { role: 'user', content: [
            { type: 'text', text: 'Analyze this brand reference image.' },
            // 'high' (was 'low') — low-res downsampling was why dominantColors
            // only ever came back as the single largest/darkest block of
            // color instead of a real palette with secondary/accent tones.
            { type: 'image_url', image_url: { url: dataUrl, detail: 'high' } }
          ]}
        ],
        max_tokens: 400
      },
      { feature: 'brand_reference.image_analysis' },
      { timeout: 60000 }
    );
    const text = response.data?.choices?.[0]?.message?.content;
    const parsed = _safeJSON(text);
    if (parsed) {
      await BrandReferenceImage.updateOne({ _id: docId }, { $set: { analysis: parsed } });
    }
  } catch (err) {
    const detail = err.response?.data || err.message;
    logger.warn('Reference image AI analysis error', { docId, error: err.message, openaiError: JSON.stringify(detail) });
  }
}

function _tokenConfig(max) {
  const model = (aiService.openaiModel || '').toLowerCase();
  return /^gpt-5|^o[134]/.test(model) ? { max_completion_tokens: max } : { max_tokens: max };
}

function _safeJSON(text) {
  if (!text) return null;
  let cleaned = text.trim();
  const m = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (m) cleaned = m[1].trim();
  try { return JSON.parse(cleaned); } catch { return null; }
}

function _aggregateVisualStyle(images) {
  const colorCounts = {};
  const compositions = {};
  const moods = {};
  const layouts = {};
  const textDensities = {};

  for (const img of images) {
    const a = img.analysis;
    if (!a) continue;
    (a.dominantColors || []).forEach(c => { colorCounts[c] = (colorCounts[c] || 0) + 1; });
    if (a.compositionType) compositions[a.compositionType] = (compositions[a.compositionType] || 0) + 1;
    if (a.mood) moods[a.mood] = (moods[a.mood] || 0) + 1;
    if (a.layoutPattern) layouts[a.layoutPattern] = (layouts[a.layoutPattern] || 0) + 1;
    if (a.textDensity) textDensities[a.textDensity] = (textDensities[a.textDensity] || 0) + 1;
  }

  // Perceptual clustering (not raw exact-hex frequency) — see colorClustering.js
  // for why: exact-string counting almost never lets similar-but-not-identical
  // shades accumulate a real count across images, so it degenerates into
  // whichever few colors happened to byte-for-byte coincide (usually generic
  // studio backgrounds), losing the actual deep/accent tones entirely.
  const topColors = topClusteredColors(colorCounts, { limit: 5 });
  const topComposition = Object.entries(compositions).sort((a, b) => b[1] - a[1])[0]?.[0] || '';
  const topMood = Object.entries(moods).sort((a, b) => b[1] - a[1])[0]?.[0] || '';
  const topLayout = Object.entries(layouts).sort((a, b) => b[1] - a[1])[0]?.[0] || '';
  const topTextDensity = Object.entries(textDensities).sort((a, b) => b[1] - a[1])[0]?.[0] || '';

  return { colorPalette: topColors, composition: topComposition, mood: topMood, layout: topLayout, textDensity: topTextDensity };
}
