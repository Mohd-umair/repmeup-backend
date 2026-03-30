const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const { protect } = require('../middlewares/auth');
const { validateMediaUpdate } = require('../middlewares/validation');
const mediaLibraryController = require('../controllers/mediaLibraryController');
const multer = require('multer');
const storageService = require('../services/storageService');

/**
 * Media Library Routes
 * @route /api/media-library
 */

function createUploadStorage() {
  if (storageService.isS3Configured()) {
    return multer.memoryStorage();
  }
  const uploadPath = path.join(__dirname, '../../uploads/posts');
  return multer.diskStorage({
    destination: (req, file, cb) => {
      try {
        fs.mkdirSync(uploadPath, { recursive: true });
      } catch (_) {}
      cb(null, uploadPath);
    },
    filename: (req, file, cb) => {
      const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
      const ext = path.extname(file.originalname);
      cb(null, 'media-' + uniqueSuffix + ext);
    }
  });
}

const fileFilter = (req, file, cb) => {
  const allowedMimeTypes = [
    'image/jpeg',
    'image/jpg',
    'image/png',
    'image/gif',
    'image/webp',
    'video/mp4',
    'video/quicktime',
    'video/x-msvideo',
    'audio/mpeg',
    'audio/mp3',
    'audio/mp4',
    'audio/ogg',
    'audio/wav',
    'audio/webm',
    'audio/x-m4a',
    'audio/aac'
  ];

  if (allowedMimeTypes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error('Invalid file type. Only images, videos, and audio are allowed.'), false);
  }
};

const upload = multer({
  storage: createUploadStorage(),
  fileFilter: fileFilter,
  limits: {
    fileSize: 100 * 1024 * 1024 // 100MB max
  }
});

// @route   POST /api/media-library/upload
// @desc    Upload media to library
// @access  Private
router.post('/upload', protect, upload.single('media'), mediaLibraryController.uploadMedia);

// @route   GET /api/media-library/stats
// @desc    Get media library statistics
// @access  Private
router.get('/stats', protect, mediaLibraryController.getMediaStats);

// @route   GET /api/media-library
// @desc    Get all media from library
// @access  Private
router.get('/', protect, mediaLibraryController.getMediaLibrary);

// @route   GET /api/media-library/:id
// @desc    Get single media by ID
// @access  Private
router.get('/:id', protect, mediaLibraryController.getMediaById);

// @route   PUT /api/media-library/:id
// @desc    Update media metadata
// @access  Private
router.put('/:id', protect, validateMediaUpdate, mediaLibraryController.updateMedia);

// @route   DELETE /api/media-library/:id
// @desc    Delete media from library
// @access  Private
router.delete('/:id', protect, mediaLibraryController.deleteMedia);

module.exports = router;
