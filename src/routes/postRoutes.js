const express = require('express');
const router = express.Router();
const { protect } = require('../middlewares/auth');
const postController = require('../controllers/postController');
const path = require('path');

/**
 * Post Routes
 * @route /api/posts
 */

// @route   GET /api/posts/media-requirements
// @desc    Get media requirements for platforms
// @access  Public (no rate limit - static data)
router.get('/media-requirements', postController.getMediaRequirements);

// @route   GET /api/posts/media/:filename
// @desc    Serve uploaded media files (public for Instagram API)
// @access  Public (needed for Instagram to access the media)
router.get('/media/:filename', (req, res) => {
  try {
    const filename = req.params.filename;
    const filePath = path.join(__dirname, '../../uploads/posts', filename);
    
    console.log(`📁 [Media] Serving file: ${filename}`);
    
    // Send file with appropriate headers
    res.sendFile(filePath, (err) => {
      if (err) {
        console.error(`❌ [Media] File not found: ${filename}`);
        res.status(404).json({ message: 'Media file not found' });
      }
    });
  } catch (error) {
    console.error('Error serving media:', error);
    res.status(500).json({ message: 'Error serving media file' });
  }
});

// @route   POST /api/posts/publish
// @desc    Publish post immediately
// @access  Private
router.post('/publish', protect, postController.publishPost);

// @route   POST /api/posts/schedule
// @desc    Schedule post for later
// @access  Private
router.post('/schedule', protect, postController.schedulePost);

// @route   GET /api/posts/scheduled
// @desc    Get all scheduled posts
// @access  Private
router.get('/scheduled', protect, postController.getScheduledPosts);

// @route   GET /api/posts/published
// @desc    Get all published posts
// @access  Private
router.get('/published', protect, postController.getPublishedPosts);

// @route   DELETE /api/posts/scheduled/:id
// @desc    Delete scheduled post
// @access  Private
router.delete('/scheduled/:id', protect, postController.deleteScheduledPost);

module.exports = router;
