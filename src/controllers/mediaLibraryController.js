const Media = require('../models/Media');
const path = require('path');
const fs = require('fs');

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

    // Determine media type
    const mediaType = file.mimetype.startsWith('image/') ? 'image' : 'video';

    // Generate public URL
    const baseUrl = process.env.BASE_URL || 'https://repmeup.in';
    const publicUrl = `${baseUrl}/api/posts/media/${file.filename}`;

    // Create media record
    const media = new Media({
      filename: file.filename,
      originalName: file.originalname,
      filePath: file.path,
      publicUrl: publicUrl,
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
    console.error('Upload media error:', error);
    res.status(500).json({
      success: false,
      message: error.message
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

    // Delete physical file
    try {
      if (fs.existsSync(media.filePath)) {
        fs.unlinkSync(media.filePath);
        console.log(`🗑️  [Media Library] Deleted file: ${media.filePath}`);
      }
    } catch (err) {
      console.error('Error deleting physical file:', err);
      // Continue with database deletion even if file deletion fails
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
