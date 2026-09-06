/**
 * Content Studio ephemeral input images ("Product Shoot" uploads).
 *
 * These are session-specific product photos, distinct from the durable
 * Brand Hub `BrandReferenceImage` style library — see GenerationInputImage
 * model docstring for the full rationale. Default behavior is ephemeral;
 * `promote()` is the only path that turns one into a permanent Brand Hub
 * asset, and it is restricted to Brand Hub managers.
 */
const sharp = require('sharp');
const GenerationInputImage = require('../models/GenerationInputImage');
const BrandReferenceImage = require('../models/BrandReferenceImage');
const BrandConfig = require('../models/BrandConfig');
const storageService = require('../services/storageService');
const logger = require('../config/logger');
const { runIdempotent } = require('../utils/idempotency');
const { sanitizeStringArray } = require('../utils/brandConfigValidation');
const { isProductShootEnabled } = require('../utils/featureFlags');
const refImageController = require('./brandReferenceImageController');

const ALLOWED_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024; // 10MB — matches Brand Hub reference upload limit
const MAX_ACTIVE_UPLOADS_PER_ORG = 30; // guards against unbounded ephemeral-storage growth between cleanup runs
const EPHEMERAL_TTL_MS = 48 * 60 * 60 * 1000; // 48h — generous enough for a multi-day shoot session, short enough to bound storage

/**
 * @desc    Upload a one-off product photo for the current Content Studio
 *          session. Ephemeral by default (auto-expires in 48h); never
 *          touches the Brand Hub reference library unless promoted.
 * @route   POST /api/content-studio/input-images
 * @access  Private (any user with posts.create / Content Studio AI access)
 */
exports.upload = async (req, res) => {
  try {
    if (!isProductShootEnabled()) {
      return res.status(503).json({
        success: false,
        error: 'Product Shoot uploads are temporarily unavailable. Please try again shortly.',
        code: 'PRODUCT_SHOOT_UNAVAILABLE'
      });
    }

    const orgId = req.user.organization?._id || req.user.organization;
    const userId = req.user._id;

    if (!req.file) {
      return res.status(400).json({ success: false, error: 'No file uploaded' });
    }
    if (!ALLOWED_MIME_TYPES.has(req.file.mimetype)) {
      return res.status(400).json({ success: false, error: 'Only JPEG, PNG, and WebP images are allowed' });
    }
    if (req.file.size > MAX_FILE_SIZE_BYTES) {
      return res.status(400).json({ success: false, error: 'Image must be 10MB or smaller' });
    }

    const idempotencyKey = req.get('Idempotency-Key') || req.body.idempotencyKey || null;

    const result = await runIdempotent(orgId, 'content-studio.upload', idempotencyKey, async () => {
      const activeCount = await GenerationInputImage.countDocuments({
        organization: orgId,
        user: userId,
        promotedReferenceImage: null,
        expiresAt: { $gt: new Date() }
      });
      if (activeCount >= MAX_ACTIVE_UPLOADS_PER_ORG) {
        const err = new Error(`You have reached the limit of ${MAX_ACTIVE_UPLOADS_PER_ORG} active uploads. Delete unused ones or wait for them to expire.`);
        err.statusCode = 400;
        throw err;
      }

      // Decode with sharp rather than trusting the declared mimetype/extension
      // — this both rejects corrupt/mislabeled files AND re-encodes the
      // buffer, which strips EXIF/GPS/camera metadata before it is stored or
      // ever sent to a third-party (OpenAI) API.
      let metadata;
      let cleanBuffer;
      try {
        const pipeline = sharp(req.file.buffer).rotate(); // rotate() bakes in EXIF orientation, then metadata is dropped
        metadata = await pipeline.metadata();
        cleanBuffer = req.file.mimetype === 'image/png'
          ? await pipeline.png().toBuffer()
          : req.file.mimetype === 'image/webp'
            ? await pipeline.webp({ quality: 92 }).toBuffer()
            : await pipeline.jpeg({ quality: 92 }).toBuffer();
      } catch (decodeErr) {
        const err = new Error('File could not be read as a valid image');
        err.statusCode = 400;
        throw err;
      }

      const filename = `product-${Date.now()}-${Math.floor(Math.random() * 1000)}.${req.file.mimetype === 'image/png' ? 'png' : req.file.mimetype === 'image/webp' ? 'webp' : 'jpg'}`;

      let imageUrl, s3Key, storageType;
      if (storageService.isS3Configured()) {
        s3Key = storageService.buildContentStudioInputKey(orgId, filename);
        const uploaded = await storageService.uploadBuffer(s3Key, cleanBuffer, req.file.mimetype);
        imageUrl = uploaded.publicUrl;
        storageType = 's3';
      } else {
        const fs = require('fs');
        const path = require('path');
        const dir = path.join(__dirname, '../../uploads/content-studio-inputs');
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        const diskName = `${orgId}-${Date.now()}-${filename}`;
        fs.writeFileSync(path.join(dir, diskName), cleanBuffer);
        imageUrl = `${process.env.BASE_URL || 'http://localhost:5000'}/uploads/content-studio-inputs/${diskName}`;
        s3Key = null;
        storageType = 'local';
      }

      const doc = await GenerationInputImage.create({
        organization: orgId,
        user: userId,
        purpose: 'product_shoot',
        imageUrl,
        s3Key,
        storageType,
        mimeType: req.file.mimetype,
        size: cleanBuffer.length,
        width: metadata.width || null,
        height: metadata.height || null,
        status: 'ready',
        idempotencyKey,
        expiresAt: new Date(Date.now() + EPHEMERAL_TTL_MS)
      });

      logger.info('[Content Studio] Ephemeral product image uploaded', { orgId, userId, id: doc._id });

      return {
        success: true,
        data: {
          id: doc._id,
          imageUrl: doc.imageUrl,
          width: doc.width,
          height: doc.height,
          expiresAt: doc.expiresAt
        }
      };
    });

    res.status(201).json(result);
  } catch (err) {
    logger.error('[Content Studio] input image upload error', { error: err.message });
    res.status(err.statusCode || 500).json({ success: false, error: err.message });
  }
};

/**
 * @desc    Fetch one ephemeral input image (org + owner scoped)
 * @route   GET /api/content-studio/input-images/:id
 */
exports.get = async (req, res) => {
  try {
    const orgId = req.user.organization?._id || req.user.organization;
    const doc = await GenerationInputImage.findOne({ _id: req.params.id, organization: orgId }).lean();
    if (!doc) return res.status(404).json({ success: false, error: 'Upload not found or expired' });
    res.json({ success: true, data: doc });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

/**
 * @desc    List the current user's active (non-expired, non-promoted) uploads
 *          for this session — lets the chooser UI restore state on refresh.
 * @route   GET /api/content-studio/input-images
 */
exports.list = async (req, res) => {
  try {
    const orgId = req.user.organization?._id || req.user.organization;
    const docs = await GenerationInputImage.find({
      organization: orgId,
      user: req.user._id,
      expiresAt: { $gt: new Date() }
    })
      .sort({ createdAt: -1 })
      .limit(20)
      .select('imageUrl width height createdAt expiresAt promotedReferenceImage')
      .lean();
    res.json({ success: true, data: docs });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

/**
 * @desc    Delete an ephemeral input image before it expires
 * @route   DELETE /api/content-studio/input-images/:id
 */
exports.remove = async (req, res) => {
  try {
    const orgId = req.user.organization?._id || req.user.organization;
    const doc = await GenerationInputImage.findOneAndDelete({
      _id: req.params.id,
      organization: orgId,
      user: req.user._id,
      promotedReferenceImage: null
    });
    if (!doc) return res.status(404).json({ success: false, error: 'Upload not found, already expired, or already promoted' });
    if (doc.s3Key) storageService.deleteObjectByKey(doc.s3Key).catch(() => {});
    else if (doc.storageType === 'local') {
      const fs = require('fs');
      const path = require('path');
      try {
        fs.unlinkSync(path.join(__dirname, '../../uploads/content-studio-inputs', path.basename(doc.imageUrl)));
      } catch (_) { /* best-effort */ }
    }
    res.json({ success: true, message: 'Deleted' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

/**
 * @desc    Promote a one-off upload into a permanent Brand Hub reference
 *          image. Restricted to Brand Hub managers (same roles as
 *          POST /brand-config/reference-images) — an agent can generate
 *          with their own upload but cannot change the org's shared style
 *          library.
 * @route   POST /api/content-studio/input-images/:id/promote
 */
exports.promote = async (req, res) => {
  try {
    const orgId = req.user.organization?._id || req.user.organization;
    const doc = await GenerationInputImage.findOne({ _id: req.params.id, organization: orgId });
    if (!doc) return res.status(404).json({ success: false, error: 'Upload not found or expired' });
    if (doc.promotedReferenceImage) {
      return res.status(400).json({ success: false, error: 'This upload has already been saved to Brand Hub' });
    }

    const existingCount = await BrandReferenceImage.countDocuments({ organization: orgId });
    if (existingCount >= refImageController.MAX_IMAGES_PER_ORG) {
      return res.status(400).json({
        success: false,
        error: `Brand Hub already has the maximum of ${refImageController.MAX_IMAGES_PER_ORG} reference images. Remove one before saving this.`
      });
    }

    const category = req.body.category && refImageController.CATEGORY_OPTIONS.includes(req.body.category)
      ? req.body.category
      : 'product';
    const { value: sanitizedTags } = sanitizeStringArray(req.body.tags, { maxItems: 20, maxLength: 40 });
    const tags = sanitizedTags || [];

    // Reuse the same stored object rather than copying it — this is a
    // one-off upload becoming a permanent asset, not a duplicate of one.
    const referenceDoc = await BrandReferenceImage.create({
      organization: orgId,
      imageUrl: doc.imageUrl,
      s3Key: doc.s3Key,
      category,
      tags,
      sortOrder: existingCount
    });

    doc.promotedReferenceImage = referenceDoc._id;
    doc.promotedAt = new Date();
    doc.promotedBy = req.user._id;
    doc.expiresAt = null; // stop the ephemeral cleanup job from ever touching storage this doc now shares with a permanent asset
    await doc.save();

    refImageController.analyzeImageAsync(referenceDoc._id, referenceDoc.imageUrl).catch((err) =>
      logger.warn('Promoted product image analysis failed (non-blocking)', { id: referenceDoc._id, err: err.message })
    );
    BrandConfig.updateOne({ organization: orgId }, { $unset: { styleCache: 1 } }).catch(() => {});

    logger.info('[Content Studio] Promoted ephemeral upload to Brand Hub', {
      orgId, inputImageId: doc._id, referenceImageId: referenceDoc._id, promotedBy: req.user._id
    });

    res.status(201).json({ success: true, data: referenceDoc });
  } catch (err) {
    logger.error('[Content Studio] promote input image error', { error: err.message });
    res.status(500).json({ success: false, error: err.message });
  }
};

module.exports.EPHEMERAL_TTL_MS = EPHEMERAL_TTL_MS;
