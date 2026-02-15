const express = require('express');
const router = express.Router();
const { protect } = require('../middlewares/auth');
const postController = require('../controllers/postController');
const path = require('path');
const fs = require('fs');

/**
 * Post Routes
 * @route /api/posts
 */

// @route   GET /api/posts/media-requirements
// @desc    Get media requirements for platforms
// @access  Public (no rate limit - static data)
router.get('/media-requirements', postController.getMediaRequirements);

// @route   GET /api/posts/test-media-url
// @desc    Test if media URL is accessible (for debugging Instagram issues)
// @access  Public
router.get('/test-media-url', async (req, res) => {
  try {
    const { url } = req.query;
    if (!url) {
      return res.status(400).json({ success: false, message: 'URL parameter required' });
    }

    const axios = require('axios');
    const startTime = Date.now();
    
    const response = await axios.head(url, {
      timeout: 10000,
      maxRedirects: 5,
      validateStatus: (status) => status < 500 // Accept any non-5xx status
    });

    const duration = Date.now() - startTime;

    res.json({
      success: true,
      url,
      accessible: response.status === 200,
      status: response.status,
      contentType: response.headers['content-type'],
      contentLength: response.headers['content-length'],
      acceptRanges: response.headers['accept-ranges'],
      duration: `${duration}ms`,
      headers: response.headers
    });
  } catch (error) {
    res.status(200).json({
      success: false,
      url: req.query.url,
      accessible: false,
      error: error.message,
      code: error.code
    });
  }
});

// @route   GET /api/posts/media/:filename
// @desc    Serve uploaded media files (public for Instagram API)
// @access  Public (needed for Instagram to access the media)
router.get('/media/:filename', (req, res) => {
  try {
    const filename = req.params.filename;
    const filePath = path.join(__dirname, '../../uploads/posts', filename);
    
    console.log(`📁 [Media] Serving file: ${filename}`);
    console.log(`📍 [Media] File path: ${filePath}`);
    console.log(`📋 [Media] Request headers:`, {
      'user-agent': req.get('user-agent'),
      'range': req.get('range')
    });
    
    // Check if file exists first
    if (!fs.existsSync(filePath)) {
      console.error(`❌ [Media] File not found: ${filename}`);
      return res.status(404).json({ message: 'Media file not found' });
    }
    
    // Get file stats for Content-Length
    const stat = fs.statSync(filePath);
    const fileSize = stat.size;
    
    // Determine content type based on file extension
    const ext = path.extname(filename).toLowerCase();
    const contentTypeMap = {
      '.mp4': 'video/mp4',
      '.mov': 'video/quicktime',
      '.avi': 'video/x-msvideo',
      '.webm': 'video/webm',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.gif': 'image/gif',
      '.webp': 'image/webp'
    };
    const contentType = contentTypeMap[ext] || 'application/octet-stream';
    
    // Set headers for proper video/image serving
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Length', fileSize);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'public, max-age=31536000'); // 1 year cache
    res.setHeader('Access-Control-Allow-Origin', '*'); // Allow CORS
    
    console.log(`✅ [Media] Serving ${contentType}, size: ${fileSize} bytes`);
    
    // Handle range requests (important for video streaming)
    const range = req.headers.range;
    if (range) {
      const parts = range.replace(/bytes=/, "").split("-");
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
      const chunksize = (end - start) + 1;
      
      res.status(206); // Partial Content
      res.setHeader('Content-Range', `bytes ${start}-${end}/${fileSize}`);
      res.setHeader('Content-Length', chunksize);
      
      const stream = fs.createReadStream(filePath, { start, end });
      stream.pipe(res);
      console.log(`📹 [Media] Streaming range: ${start}-${end}/${fileSize}`);
    } else {
      // Send entire file
      const stream = fs.createReadStream(filePath);
      stream.pipe(res);
    }
  } catch (error) {
    console.error('❌ [Media] Error serving media:', error);
    res.status(500).json({ message: 'Error serving media file', error: error.message });
  }
});

// @route   POST /api/posts/generate
// @desc    Generate post content with AI
// @access  Private
router.post('/generate', protect, postController.generatePostWithAI);

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
