const InspirationImage = require('../models/InspirationImage');
const BrandReferenceImage = require('../models/BrandReferenceImage');
const BrandConfig = require('../models/BrandConfig');
const aiService = require('../services/aiService');
const logger = require('../config/logger');

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
 * @desc    List inspiration images by industry
 * @route   GET /api/inspirations?industry=fashion
 * @access  Private
 */
exports.list = async (req, res) => {
  try {
    const industry = req.query.industry;
    const filter = { isActive: true };
    if (industry && industry !== 'all') {
      filter.industry = industry;
    }
    const images = await InspirationImage.find(filter)
      .sort({ industry: 1, sortOrder: 1, createdAt: -1 })
      .select('_id industry imageUrl tags sortOrder')
      .lean();

    res.json({ success: true, data: images, total: images.length });
  } catch (err) {
    logger.error('inspirationController.list error', { error: err.message });
    res.status(500).json({ success: false, error: err.message });
  }
};

/**
 * @desc    Copy selected inspiration images into the org's BrandReferenceImage library
 * @route   POST /api/inspirations/add-to-references
 * @body    { imageIds: string[] }
 * @access  Private
 */
exports.addToReferences = async (req, res) => {
  try {
    const orgId = req.user.organization?._id || req.user.organization;
    const { imageIds } = req.body;

    if (!Array.isArray(imageIds) || imageIds.length === 0) {
      return res.status(400).json({ success: false, error: 'imageIds must be a non-empty array' });
    }

    const MAX_IMAGES_PER_ORG = 20;
    const existing = await BrandReferenceImage.countDocuments({ organization: orgId });
    if (existing >= MAX_IMAGES_PER_ORG) {
      return res.status(400).json({
        success: false,
        error: `You have reached the maximum of ${MAX_IMAGES_PER_ORG} reference images. Delete some before adding more.`
      });
    }

    const inspirations = await InspirationImage.find({
      _id: { $in: imageIds },
      isActive: true
    }).select('imageUrl tags').lean();

    if (!inspirations.length) {
      return res.status(404).json({ success: false, error: 'No matching inspiration images found' });
    }

    // Limit to available slots
    const slots = MAX_IMAGES_PER_ORG - existing;
    const toAdd = inspirations.slice(0, slots);

    const added = [];
    for (const insp of toAdd) {
      const doc = await BrandReferenceImage.findOneAndUpdate(
        { organization: orgId, imageUrl: insp.imageUrl },
        {
          $setOnInsert: {
            organization: orgId,
            imageUrl: insp.imageUrl,
            s3Key: null,
            category: 'general',
            tags: insp.tags || [],
            sortOrder: existing + added.length,
            analysis: null
          }
        },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );
      added.push(doc);

      // Trigger async Vision analysis (non-blocking) for newly added images
      _analyzeImageAsync(doc._id, insp.imageUrl).catch(() => {});
    }

    // Invalidate style cache so next generation re-analyses with the new images
    BrandConfig.updateOne({ organization: orgId }, { $unset: { styleCache: 1 } }).catch(() => {});

    const skipped = inspirations.length - toAdd.length;
    res.status(201).json({
      success: true,
      added: added.length,
      skipped,
      message: skipped > 0
        ? `Added ${added.length} image${added.length !== 1 ? 's' : ''}. ${skipped} skipped (library full).`
        : `Added ${added.length} image${added.length !== 1 ? 's' : ''} to your references.`
    });
  } catch (err) {
    logger.error('inspirationController.addToReferences error', { error: err.message });
    res.status(500).json({ success: false, error: err.message });
  }
};

async function _analyzeImageAsync(docId, imageUrl) {
  const axios = require('axios');
  let dataUrl;
  try {
    const resp = await axios.get(imageUrl, { responseType: 'arraybuffer', timeout: 15000 });
    const mime = resp.headers['content-type'] || 'image/jpeg';
    const b64 = Buffer.from(resp.data).toString('base64');
    dataUrl = `data:${mime};base64,${b64}`;
  } catch (dlErr) {
    logger.warn('Inspiration image analysis: could not download image', { docId, url: imageUrl?.substring(0, 120), error: dlErr.message });
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
            { type: 'image_url', image_url: { url: dataUrl, detail: 'low' } }
          ]}
        ],
        max_tokens: 400
      },
      { feature: 'inspiration.image_analysis' },
      { timeout: 60000 }
    );
    const text = response.data?.choices?.[0]?.message?.content;
    const parsed = _safeJSON(text);
    if (parsed) {
      await BrandReferenceImage.updateOne({ _id: docId }, { $set: { analysis: parsed } });
    }
  } catch (err) {
    logger.warn('Inspiration image AI analysis error', { docId, error: err.message });
  }
}

function _safeJSON(text) {
  if (!text) return null;
  let cleaned = text.trim();
  const m = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (m) cleaned = m[1].trim();
  try { return JSON.parse(cleaned); } catch { return null; }
}
