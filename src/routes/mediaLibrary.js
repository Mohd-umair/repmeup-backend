const express = require('express');
const router = express.Router();
const { protect } = require('../middlewares/auth');
const { validateMediaUpdate } = require('../middlewares/validation');
const mediaLibraryController = require('../controllers/mediaLibraryController');
const multer = require('multer');
const path = require('path');

/**
 * Media Library Routes
 * @route /api/media-library
 */

// Configure multer for media library uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, 'uploads/posts'); // Same folder as post media
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const ext = path.extname(file.originalname);
    cb(null, 'media-' + uniqueSuffix + ext);
  }
});

const fileFilter = (req, file, cb) => {
  // Accept images and videos only
  const allowedMimeTypes = [
    'image/jpeg',
    'image/jpg',
    'image/png',
    'image/gif',
    'image/webp',
    'video/mp4',
    'video/quicktime',
    'video/x-msvideo'
  ];

  if (allowedMimeTypes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error('Invalid file type. Only images and videos are allowed.'), false);
  }
};

const upload = multer({
  storage: storage,
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
