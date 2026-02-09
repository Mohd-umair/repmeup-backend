const ScheduledPost = require('../models/ScheduledPost');
const PlatformConnection = require('../models/PlatformConnection');
const instagramService = require('../integrations/meta/instagramService');
const facebookService = require('../integrations/meta/facebookService');
const multer = require('multer');
const path = require('path');
const fs = require('fs').promises;
const crypto = require('crypto');

// Configure multer for media uploads
const storage = multer.diskStorage({
  destination: async function (req, file, cb) {
    const uploadDir = path.join(__dirname, '../../uploads/posts');
    try {
      await fs.mkdir(uploadDir, { recursive: true });
      cb(null, uploadDir);
    } catch (error) {
      cb(error);
    }
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({
  storage: storage,
  limits: {
    fileSize: 8 * 1024 * 1024 // 8MB limit
  },
  fileFilter: function (req, file, cb) {
    const allowedTypes = /jpeg|jpg|png|mp4/;
    const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = allowedTypes.test(file.mimetype);

    if (mimetype && extname) {
      return cb(null, true);
    } else {
      cb(new Error('Only JPEG, PNG, and MP4 files are allowed'));
    }
  }
}).single('media');

/**
 * @desc    Publish post immediately
 * @route   POST /api/posts/publish
 * @access  Private
 */
exports.publishPost = async (req, res) => {
  upload(req, res, async function (err) {
    if (err) {
      console.error('Upload error:', err);
      return res.status(400).json({ message: err.message });
    }

    try {
      const { platform, content, scheduledFor, postType } = req.body;
      const userId = req.user.id;
      const organizationId = req.user.organization?._id || req.user.organization;

      if (!platform || !content) {
        return res.status(400).json({ message: 'Platform and content are required' });
      }

      // Get platform connection
      // For Facebook, we need a page-level connection with platformPageId
      let query = {
        organization: organizationId,
        platform: platform.toLowerCase(),
        isActive: true
      };

      // For Facebook, specifically look for page connections (with platformPageId)
      if (platform.toLowerCase() === 'facebook') {
        query.platformPageId = { $exists: true, $ne: null };
        query.usesAccountSlot = true; // Page connections use account slots
      }

      const connection = await PlatformConnection.findOne(query);

      if (!connection) {
        if (platform.toLowerCase() === 'facebook') {
          return res.status(404).json({ 
            message: 'No Facebook page connection found. Please connect a Facebook page from Settings.' 
          });
        }
        return res.status(404).json({ message: `No active ${platform} connection found` });
      }

      // Prepare post data
      const postData = {
        organization: organizationId,
        user: userId,
        platform: platform.toLowerCase(),
        platformConnection: connection._id,
        content: content.trim(),
        postType: postType || 'post'
      };

      // Handle media if uploaded
      if (req.file) {
        postData.mediaStoragePath = req.file.path;
        postData.mediaType = req.file.mimetype.startsWith('image') ? 'image' : 'video';
      }

      // If scheduled for later, save and return
      if (scheduledFor) {
        postData.scheduledFor = new Date(scheduledFor);
        postData.status = 'scheduled';

        const scheduledPost = await ScheduledPost.create(postData);

        return res.status(201).json({
          message: 'Post scheduled successfully',
          post: scheduledPost
        });
      }

      // Publish immediately
      postData.status = 'publishing';
      const post = await ScheduledPost.create(postData);

      let result;
      try {
        // Publish to platform
        switch (platform.toLowerCase()) {
          case 'instagram':
            result = await publishToInstagram(connection, post, req);
            break;
          case 'facebook':
            result = await publishToFacebook(connection, post, req);
            break;
          default:
            throw new Error(`Publishing to ${platform} not yet implemented`);
        }

        // Update post with result
        post.status = 'published';
        post.publishedAt = new Date();
        post.platformPostId = result.postId;
        post.platformPostUrl = result.postUrl;
        await post.save();

        res.status(201).json({
          message: 'Post published successfully',
          post: post,
          platformPostUrl: result.postUrl
        });
      } catch (error) {
        console.error('Publishing error:', error);
        post.status = 'failed';
        post.error = error.message;
        await post.save();

        // Return detailed platform error if available
        const errorResponse = {
          message: 'Failed to publish post',
          error: error.message
        };

        if (error.platformError) {
          errorResponse.platformError = error.platformError;
        }

        res.status(500).json(errorResponse);
      }
    } catch (error) {
      console.error('Publish post error:', error);
      res.status(500).json({ message: error.message });
    }
  });
};

/**
 * @desc    Schedule post for later
 * @route   POST /api/posts/schedule
 * @access  Private
 */
exports.schedulePost = async (req, res) => {
  upload(req, res, async function (err) {
    if (err) {
      console.error('Upload error:', err);
      return res.status(400).json({ message: err.message });
    }

    try {
      const { platform, content, scheduledFor, postType } = req.body;
      const userId = req.user.id;
      const organizationId = req.user.organization?._id || req.user.organization;

      if (!platform || !content || !scheduledFor) {
        return res.status(400).json({ message: 'Platform, content, and scheduledFor are required' });
      }

      // Get platform connection
      // For Facebook, we need a page-level connection with platformPageId
      let query = {
        organization: organizationId,
        platform: platform.toLowerCase(),
        isActive: true
      };

      // For Facebook, specifically look for page connections (with platformPageId)
      if (platform.toLowerCase() === 'facebook') {
        query.platformPageId = { $exists: true, $ne: null };
        query.usesAccountSlot = true; // Page connections use account slots
      }

      const connection = await PlatformConnection.findOne(query);

      if (!connection) {
        if (platform.toLowerCase() === 'facebook') {
          return res.status(404).json({ 
            message: 'No Facebook page connection found. Please connect a Facebook page from Settings.' 
          });
        }
        return res.status(404).json({ message: `No active ${platform} connection found` });
      }

      const postData = {
        organization: organizationId,
        user: userId,
        platform: platform.toLowerCase(),
        platformConnection: connection._id,
        content: content.trim(),
        scheduledFor: new Date(scheduledFor),
        status: 'scheduled',
        postType: postType || 'post'
      };

      if (req.file) {
        postData.mediaStoragePath = req.file.path;
        postData.mediaType = req.file.mimetype.startsWith('image') ? 'image' : 'video';
      }

      const scheduledPost = await ScheduledPost.create(postData);

      res.status(201).json({
        message: 'Post scheduled successfully',
        post: scheduledPost
      });
    } catch (error) {
      console.error('Schedule post error:', error);
      res.status(500).json({ message: error.message });
    }
  });
};

/**
 * @desc    Get all scheduled posts
 * @route   GET /api/posts/scheduled
 * @access  Private
 */
exports.getScheduledPosts = async (req, res) => {
  try {
    const organizationId = req.user.organization?._id || req.user.organization;

    const posts = await ScheduledPost.find({
      organization: organizationId,
      status: 'scheduled'
    })
      .sort({ scheduledFor: 1 })
      .populate('platformConnection', 'platform platformPageId platformUsername')
      .lean();

    res.status(200).json({ posts });
  } catch (error) {
    console.error('Get scheduled posts error:', error);
    res.status(500).json({ message: error.message });
  }
};

/**
 * @desc    Get all published posts
 * @route   GET /api/posts/published
 * @access  Private
 */
exports.getPublishedPosts = async (req, res) => {
  try {
    const organizationId = req.user.organization?._id || req.user.organization;

    const posts = await ScheduledPost.find({
      organization: organizationId,
      status: 'published'
    })
      .sort({ publishedAt: -1 })
      .populate('platformConnection', 'platform platformPageId platformUsername')
      .lean();

    res.status(200).json({ posts });
  } catch (error) {
    console.error('Get published posts error:', error);
    res.status(500).json({ message: error.message });
  }
};

/**
 * @desc    Delete scheduled post
 * @route   DELETE /api/posts/scheduled/:id
 * @access  Private
 */
exports.deleteScheduledPost = async (req, res) => {
  try {
    const organizationId = req.user.organization?._id || req.user.organization;
    const post = await ScheduledPost.findOne({
      _id: req.params.id,
      organization: organizationId,
      status: 'scheduled'
    });

    if (!post) {
      return res.status(404).json({ message: 'Scheduled post not found' });
    }

    // Delete media file if exists
    if (post.mediaStoragePath) {
      try {
        await fs.unlink(post.mediaStoragePath);
      } catch (err) {
        console.error('Error deleting media file:', err);
      }
    }

    await ScheduledPost.findByIdAndDelete(post._id);
    res.status(200).json({ message: 'Scheduled post deleted' });
  } catch (error) {
    console.error('Delete scheduled post error:', error);
    res.status(500).json({ message: error.message });
  }
};

/**
 * Helper: Get public URL for media file (must be reachable by Instagram/Facebook)
 */
function getPublicMediaUrl(filePath, req) {
  const filename = path.basename(filePath);

  let baseUrl = process.env.BASE_URL || process.env.API_URL;

  if (!baseUrl && req && req.get && req.get('host')) {
    const protocol = req.protocol || 'https';
    const host = req.get('host');
    baseUrl = `${protocol}://${host}`;
  }

  if (!baseUrl) {
    // Default to production URL if available, otherwise localhost
    baseUrl = 'https://repmeup.in';
  }

  // Ensure baseUrl doesn't have /api at the end
  baseUrl = baseUrl.replace(/\/api\/?$/, '');

  const publicUrl = `${baseUrl}/api/posts/media/${filename}`;
  console.log(`📎 [Media] Generated public URL: ${publicUrl}`);
  console.log(`📎 [Media] Base URL: ${baseUrl}, Protocol: ${req?.protocol}, Host: ${req?.get?.('host')}`);
  return publicUrl;
}

/**
 * Helper: Publish to Instagram
 */
async function publishToInstagram(connection, post, req) {
  const { content, mediaStoragePath, mediaType } = post;

  if (!mediaStoragePath) {
    throw new Error('Instagram posts require an image or video');
  }

  const mediaUrl = getPublicMediaUrl(mediaStoragePath, req);
  console.log(`📸 [Instagram] Publishing post with media: ${mediaUrl}`);

  const result = await instagramService.createPost(connection, {
    caption: content,
    mediaUrl: mediaUrl,
    mediaType: mediaType
  });

  return {
    postId: result.postId,
    postUrl: result.postUrl
  };
}

/**
 * Helper: Publish to Facebook (pages_manage_posts)
 */
async function publishToFacebook(connection, post, req) {
  const { content, mediaStoragePath, mediaType } = post;
  
  // If there's media, try to post with image first
  if (mediaStoragePath && mediaType === 'image') {
    try {
      const mediaUrl = getPublicMediaUrl(mediaStoragePath, req);
      console.log(`📸 [Facebook] Attempting to publish with image: ${mediaUrl}`);
      
      const payload = { 
        message: content || ' ',
        url: mediaUrl 
      };
      
      const result = await facebookService.createPost(connection, payload);
      return { postId: result.postId, postUrl: result.postUrl };
    } catch (imageError) {
      console.warn(`⚠️ [Facebook] Image post failed, falling back to text-only post:`, imageError.message);
      
      // Fallback: Post as text-only to feed
      const textPayload = { message: content || 'Posted from RepMeUp' };
      const result = await facebookService.createPost(connection, textPayload);
      return { postId: result.postId, postUrl: result.postUrl };
    }
  }
  
  // Text-only post
  console.log(`📝 [Facebook] Publishing text-only post`);
  const payload = { message: content || 'Posted from RepMeUp' };
  const result = await facebookService.createPost(connection, payload);
  return { postId: result.postId, postUrl: result.postUrl };
}
