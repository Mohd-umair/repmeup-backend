const BrandReferenceImage = require('../models/BrandReferenceImage');
const BrandConfig = require('../models/BrandConfig');
const storageService = require('../services/storageService');
const aiService = require('../services/aiService');
const logger = require('../config/logger');

const MAX_IMAGES_PER_ORG = 20;

const IMAGE_ANALYSIS_PROMPT = `Analyze this brand reference image and return a JSON object:
{
  "dominantColors": ["#hex1","#hex2","#hex3"],
  "compositionType": "centered" | "rule-of-thirds" | "full-bleed-text" | "asymmetric" | "other",
  "textDensity": "none" | "minimal" | "moderate" | "heavy",
  "typographyStyle": "description of font style if text is visible",
  "logoPosition": "top-left" | "top-right" | "bottom-left" | "bottom-right" | "center" | "none",
  "mood": "single phrase describing mood",
  "layoutPattern": "single-product" | "collage" | "split-screen" | "full-photo" | "text-overlay" | "other"
}
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
        category: req.body.category || 'general',
        tags: req.body.tags ? JSON.parse(req.body.tags) : [],
        sortOrder: existing + created.length
      });
      created.push(doc);

      _analyzeImageAsync(doc._id, imageUrl).catch(err =>
        logger.warn('Reference image analysis failed (non-blocking)', { id: doc._id, err: err.message })
      );
    }

    res.status(201).json({ success: true, data: created });
  } catch (err) {
    logger.error('Reference image upload error', { error: err.message });
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
    if (req.body.category) update.category = req.body.category;
    if (req.body.tags) update.tags = req.body.tags;
    if (req.body.sortOrder != null) update.sortOrder = req.body.sortOrder;

    const doc = await BrandReferenceImage.findOneAndUpdate(
      { _id: req.params.id, organization: orgId },
      { $set: update },
      { new: true }
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

async function _analyzeImageAsync(docId, imageUrl) {
  // OpenAI Vision requires a publicly accessible HTTPS URL
  let isPublic = false;
  try { isPublic = new URL(imageUrl).protocol === 'https:'; } catch { /* invalid URL */ }
  if (!isPublic) {
    logger.warn('Reference image analysis skipped: URL is not a public HTTPS URL', { docId, imageUrl });
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
            { type: 'image_url', image_url: { url: imageUrl, detail: 'low' } }
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
    logger.warn('Reference image AI analysis error', { docId, error: err.message });
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

  const topColors = Object.entries(colorCounts).sort((a, b) => b[1] - a[1]).slice(0, 5).map(e => e[0]);
  const topComposition = Object.entries(compositions).sort((a, b) => b[1] - a[1])[0]?.[0] || '';
  const topMood = Object.entries(moods).sort((a, b) => b[1] - a[1])[0]?.[0] || '';
  const topLayout = Object.entries(layouts).sort((a, b) => b[1] - a[1])[0]?.[0] || '';
  const topTextDensity = Object.entries(textDensities).sort((a, b) => b[1] - a[1])[0]?.[0] || '';

  return { colorPalette: topColors, composition: topComposition, mood: topMood, layout: topLayout, textDensity: topTextDensity };
}
