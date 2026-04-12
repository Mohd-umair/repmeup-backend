const InspirationImage = require('../models/InspirationImage');
const storageService = require('../services/storageService');
const logger = require('../config/logger');

/**
 * @desc    List all inspiration images (admin — all industries, all statuses)
 * @route   GET /api/super-admin/inspirations
 */
exports.list = async (req, res) => {
  try {
    const { industry, isActive, page = 1, limit = 50 } = req.query;
    const filter = {};
    if (industry && industry !== 'all') filter.industry = industry;
    if (isActive !== undefined) filter.isActive = isActive === 'true';

    const skip = (Number(page) - 1) * Number(limit);
    const [data, total] = await Promise.all([
      InspirationImage.find(filter)
        .sort({ industry: 1, sortOrder: 1, createdAt: -1 })
        .skip(skip)
        .limit(Number(limit))
        .populate('uploadedBy', 'name email')
        .lean(),
      InspirationImage.countDocuments(filter)
    ]);

    res.json({ success: true, data, total, page: Number(page), limit: Number(limit) });
  } catch (err) {
    logger.error('inspirationAdminController.list error', { error: err.message });
    res.status(500).json({ success: false, error: err.message });
  }
};

/**
 * @desc    Upload one or more inspiration images
 * @route   POST /api/super-admin/inspirations
 * @body    multipart: images[] + industry, tags (JSON string), sortOrder, isActive
 */
exports.create = async (req, res) => {
  try {
    const files = Array.isArray(req.files) ? req.files : [];
    if (!files.length) {
      return res.status(400).json({ success: false, error: 'At least one image file is required' });
    }
    const { industry, sortOrder, isActive } = req.body;
    if (!industry) {
      return res.status(400).json({ success: false, error: 'industry is required' });
    }

    const tags = req.body.tags ? _parseTags(req.body.tags) : [];
    const baseSort = sortOrder != null ? Number(sortOrder) : 0;
    const active = isActive !== undefined ? isActive !== 'false' : true;
    const created = [];

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      let imageUrl;
      let s3Key;
      if (storageService.isS3Configured()) {
        s3Key = `inspirations/${industry}/${Date.now()}-${i}-${file.originalname}`;
        const result = await storageService.uploadBuffer(s3Key, file.buffer, file.mimetype);
        imageUrl = result.publicUrl || result.url;
      } else {
        const fs = require('fs');
        const path = require('path');
        const dir = path.join(__dirname, '../../uploads/inspirations');
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        const filename = `${industry}-${Date.now()}-${i}-${file.originalname}`;
        const filepath = path.join(dir, filename);
        fs.writeFileSync(filepath, file.buffer);
        imageUrl = `${process.env.BASE_URL || 'http://localhost:5000'}/uploads/inspirations/${filename}`;
        s3Key = null;
      }

      const doc = await InspirationImage.create({
        industry,
        imageUrl,
        s3Key,
        tags,
        sortOrder: baseSort + i,
        isActive: active,
        uploadedBy: req.user._id
      });
      created.push(doc);
    }

    res.status(201).json({ success: true, data: created, count: created.length });
  } catch (err) {
    logger.error('inspirationAdminController.create error', { error: err.message });
    res.status(500).json({ success: false, error: err.message });
  }
};

/**
 * @desc    Update inspiration image metadata (tags, industry, isActive, sortOrder)
 * @route   PATCH /api/super-admin/inspirations/:id
 */
exports.update = async (req, res) => {
  try {
    const { industry, tags, isActive, sortOrder } = req.body;
    const update = {};
    if (industry !== undefined) update.industry = industry;
    if (tags !== undefined) update.tags = Array.isArray(tags) ? tags : _parseTags(tags);
    if (isActive !== undefined) update.isActive = Boolean(isActive);
    if (sortOrder !== undefined) update.sortOrder = Number(sortOrder);

    const doc = await InspirationImage.findByIdAndUpdate(
      req.params.id,
      { $set: update },
      { new: true, runValidators: true }
    );
    if (!doc) return res.status(404).json({ success: false, error: 'Inspiration image not found' });
    res.json({ success: true, data: doc });
  } catch (err) {
    logger.error('inspirationAdminController.update error', { error: err.message });
    res.status(500).json({ success: false, error: err.message });
  }
};

/**
 * @desc    Delete an inspiration image (S3 cleanup + DB delete)
 * @route   DELETE /api/super-admin/inspirations/:id
 */
exports.remove = async (req, res) => {
  try {
    const doc = await InspirationImage.findByIdAndDelete(req.params.id);
    if (!doc) return res.status(404).json({ success: false, error: 'Inspiration image not found' });

    if (doc.s3Key) {
      storageService.deleteObjectByKey(doc.s3Key).catch(err =>
        logger.warn('Failed to delete inspiration image from S3', { key: doc.s3Key, error: err.message })
      );
    }

    res.json({ success: true, message: 'Deleted' });
  } catch (err) {
    logger.error('inspirationAdminController.remove error', { error: err.message });
    res.status(500).json({ success: false, error: err.message });
  }
};

function _parseTags(val) {
  if (!val) return [];
  try {
    const parsed = JSON.parse(val);
    return Array.isArray(parsed) ? parsed : String(val).split(',').map(t => t.trim()).filter(Boolean);
  } catch {
    return String(val).split(',').map(t => t.trim()).filter(Boolean);
  }
}
