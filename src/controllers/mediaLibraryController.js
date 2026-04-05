const Media = require('../models/Media');
const path = require('path');
const fs = require('fs');
const storageService = require('../services/storageService');

/**
 * Media Library Controller
 * Handles media library operations (upload, list, delete, update)
 */

/**
 * @desc    Upload media to library
 * @route   POST /api/media-library/upload
 * @access  Private
 */
exports.uploadMedia = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: 'No file uploaded'
      });
    }

    const { tags, description } = req.body;
    const file = req.file;
    const organizationId = req.user.organization?._id || req.user.organization;

    // Determine media type
    let mediaType = 'video';
    if (file.mimetype.startsWith('image/')) mediaType = 'image';
    else if (file.mimetype.startsWith('audio/') || file.mimetype === 'audio/mpeg' || file.mimetype === 'audio/mp3') mediaType = 'audio';

    let filename = file.filename;
    let filePath;
    let publicUrl;
    let s3Key;
    let storageType = 'local';

    if (storageService.isS3Configured()) {
      const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
      const ext = path.extname(file.originalname) || '';
      filename = `media-${uniqueSuffix}${ext}`;
      const key = storageService.buildPostsKey(organizationId, filename);
      const body = file.buffer;
      if (!body) {
        return res.status(500).json({ success: false, message: 'Upload buffer missing (S3 mode requires memory storage)' });
      }
      const uploaded = await storageService.uploadBuffer(key, body, file.mimetype);
      publicUrl = uploaded.publicUrl;
      filePath = uploaded.publicUrl;
      s3Key = uploaded.key;
      storageType = 's3';
    } else {
      const baseUrl = (process.env.BASE_URL || 'https://repmeup.in').replace(/\/api\/?$/, '');
      publicUrl = `${baseUrl}/api/posts/media/${file.filename}`;
      filePath = file.path;
    }

    // Create media record
    const media = new Media({
      filename,
      originalName: file.originalname,
      filePath,
      publicUrl,
      s3Key: s3Key || undefined,
      storageType,
      mimeType: file.mimetype,
      mediaType: mediaType,
      size: file.size,
      user: req.user._id,
      organization: req.user.organization,
      tags: tags ? JSON.parse(tags) : [],
      description: description || ''
    });

    // TODO: Extract image/video metadata (width, height, duration)
    // This can be added later using packages like sharp (images) or ffprobe (videos)

    await media.save();

    console.log(`✅ [Media Library] Uploaded: ${file.originalname} (${media._id})`);

    res.status(201).json({
      success: true,
      message: 'Media uploaded to library successfully',
      data: media
    });
  } catch (error) {
    console.error('❌ [Media Library] Upload error:', error);
    console.error('❌ [Media Library] Error stack:', error.stack);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to upload media to library'
    });
  }
};

/**
 * @desc    Get all media from library
 * @route   GET /api/media-library
 * @access  Private
 */
exports.getMediaLibrary = async (req, res) => {
  try {
    const { mediaType, tags, page = 1, limit = 20, sortBy = '-createdAt' } = req.query;

    // Build query
    const query = {
      organization: req.user.organization
    };

    if (mediaType) {
      query.mediaType = mediaType;
    }

    if (tags) {
      query.tags = { $in: tags.split(',') };
    }

    // Pagination
    const skip = (page - 1) * limit;

    const [media, total] = await Promise.all([
      Media.find(query)
        .sort(sortBy)
        .limit(parseInt(limit))
        .skip(skip)
        .populate('user', 'name email')
        .lean(),
      Media.countDocuments(query)
    ]);

    res.json({
      success: true,
      data: media,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    console.error('Get media library error:', error);
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
};

/**
 * @desc    Get single media by ID
 * @route   GET /api/media-library/:id
 * @access  Private
 */
exports.getMediaById = async (req, res) => {
  try {
    const media = await Media.findOne({
      _id: req.params.id,
      organization: req.user.organization
    }).populate('user', 'name email');

    if (!media) {
      return res.status(404).json({
        success: false,
        message: 'Media not found'
      });
    }

    res.json({
      success: true,
      data: media
    });
  } catch (error) {
    console.error('Get media by ID error:', error);
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
};

/**
 * @desc    Update media metadata
 * @route   PUT /api/media-library/:id
 * @access  Private
 */
exports.updateMedia = async (req, res) => {
  try {
    const { tags, description } = req.body;

    const media = await Media.findOne({
      _id: req.params.id,
      organization: req.user.organization
    });

    if (!media) {
      return res.status(404).json({
        success: false,
        message: 'Media not found'
      });
    }

    // Update fields
    if (tags !== undefined) {
      media.tags = Array.isArray(tags) ? tags : tags.split(',');
    }
    if (description !== undefined) {
      media.description = description;
    }

    await media.save();

    console.log(`✅ [Media Library] Updated: ${media.originalName} (${media._id})`);

    res.json({
      success: true,
      message: 'Media updated successfully',
      data: media
    });
  } catch (error) {
    console.error('Update media error:', error);
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
};

/**
 * @desc    Delete media from library
 * @route   DELETE /api/media-library/:id
 * @access  Private
 */
exports.deleteMedia = async (req, res) => {
  try {
    const media = await Media.findOne({
      _id: req.params.id,
      organization: req.user.organization
    });

    if (!media) {
      return res.status(404).json({
        success: false,
        message: 'Media not found'
      });
    }

    // Check if media is in use
    if (media.usageCount > 0) {
      return res.status(400).json({
        success: false,
        message: `Cannot delete media that is being used in ${media.usageCount} post(s)`,
        usageCount: media.usageCount
      });
    }

    try {
      if (media.s3Key) {
        await storageService.deleteObjectByKey(media.s3Key);
        console.log(`🗑️  [Media Library] Deleted S3 object: ${media.s3Key}`);
      } else if (media.filePath && fs.existsSync(media.filePath)) {
        fs.unlinkSync(media.filePath);
        console.log(`🗑️  [Media Library] Deleted file: ${media.filePath}`);
      } else if (media.storageType === 's3' && media.publicUrl) {
        await storageService.deleteObjectFromPublicUrl(media.publicUrl);
      }
    } catch (err) {
      console.error('Error deleting stored media:', err);
    }

    // Delete from database
    await Media.findByIdAndDelete(media._id);

    console.log(`✅ [Media Library] Deleted: ${media.originalName} (${media._id})`);

    res.json({
      success: true,
      message: 'Media deleted successfully'
    });
  } catch (error) {
    console.error('Delete media error:', error);
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
};

/**
 * @desc    Get media library statistics
 * @route   GET /api/media-library/stats
 * @access  Private
 */
exports.getMediaStats = async (req, res) => {
  try {
    const stats = await Media.getStats(req.user.organization);

    // Calculate total stats
    const totalCount = Object.values(stats).reduce((sum, s) => sum + s.count, 0);
    const totalSize = Object.values(stats).reduce((sum, s) => sum + s.totalSize, 0);

    res.json({
      success: true,
      data: {
        byType: stats,
        total: {
          count: totalCount,
          size: totalSize,
          sizeFormatted: formatBytes(totalSize)
        }
      }
    });
  } catch (error) {
    console.error('Get media stats error:', error);
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
};

/**
 * Helper: Format bytes to human-readable format
 */
function formatBytes(bytes) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
}

module.exports = exports;
