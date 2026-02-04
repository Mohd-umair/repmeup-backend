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
      const { platform, content, scheduledFor } = req.body;
      const userId = req.user.id;
      const organizationId = req.user.organization;

      if (!platform || !content) {
        return res.status(400).json({ message: 'Platform and content are required' });
      }

      // Get platform connection
      const connection = await PlatformConnection.findOne({
        organization: organizationId,
        platform: platform.toLowerCase(),
        isActive: true
      });

      if (!connection) {
        return res.status(404).json({ message: `No active ${platform} connection found` });
      }

      // Prepare post data
      const postData = {
        organization: organizationId,
        user: userId,
        platform: platform.toLowerCase(),
        platformConnection: connection._id,
        content: content.trim()
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
            result = await publishToFacebook(connection, post);
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
        
        res.status(500).json({ 
          message: 'Failed to publish post',
          error: error.message 
        });
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
      const { platform, content, scheduledFor } = req.body;
      const userId = req.user.id;
      const organizationId = req.user.organization;

      if (!platform || !content || !scheduledFor) {
        return res.status(400).json({ message: 'Platform, content, and scheduledFor are required' });
      }

      // Validate scheduled time is in the future
      const scheduleDate = new Date(scheduledFor);
      if (scheduleDate <= new Date()) {
        return res.status(400).json({ message: 'Scheduled time must be in the future' });
      }

      // Get platform connection
      const connection = await PlatformConnection.findOne({
        organization: organizationId,
        platform: platform.toLowerCase(),
        isActive: true
      });

      if (!connection) {
        return res.status(404).json({ message: `No active ${platform} connection found` });
      }

      // Create scheduled post
      const postData = {
        organization: organizationId,
        user: userId,
        platform: platform.toLowerCase(),
        platformConnection: connection._id,
        content: content.trim(),
        scheduledFor: scheduleDate,
        status: 'scheduled'
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
    const organizationId = req.user.organization;

    const posts = await ScheduledPost.find({
      organization: organizationId,
      status: { $in: ['draft', 'scheduled', 'publishing'] }
    })
    .populate('platformConnection', 'platform platformUsername')
    .sort({ scheduledFor: 1 })
    .limit(50);

    // Format posts to match frontend expectations
    const formattedPosts = posts.map(post => ({
      _id: post._id,
      platforms: [post.platform],
      content: post.content,
      mediaUrls: post.mediaUrl ? [post.mediaUrl] : [],
      status: post.status,
      scheduledFor: post.scheduledFor,
      publishedAt: post.publishedAt
    }));

    res.status(200).json({ posts: formattedPosts });
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
    const organizationId = req.user.organization;

    const posts = await ScheduledPost.find({
      organization: organizationId,
      status: 'published'
    })
    .populate('platformConnection', 'platform platformUsername')
    .sort({ publishedAt: -1 })
    .limit(100);

    // Format posts to match frontend expectations
    const formattedPosts = posts.map(post => ({
      _id: post._id,
      platforms: [post.platform],
      content: post.content,
      mediaUrls: post.mediaUrl ? [post.mediaUrl] : [],
      status: post.status,
      publishedAt: post.publishedAt,
      platformPostId: post.platformPostId,
      platformPostUrl: post.platformPostUrl,
      scheduledFor: post.scheduledFor
    }));

    res.status(200).json({ posts: formattedPosts });
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
    const postId = req.params.id;
    const organizationId = req.user.organization;

    const post = await ScheduledPost.findOne({
      _id: postId,
      organization: organizationId
    });

    if (!post) {
      return res.status(404).json({ message: 'Scheduled post not found' });
    }

    // Don't allow deleting already published posts
    if (post.status === 'published') {
      return res.status(400).json({ message: 'Cannot delete published posts' });
    }

    // Delete media file if exists
    if (post.mediaStoragePath) {
      try {
        await fs.unlink(post.mediaStoragePath);
      } catch (err) {
        console.error('Error deleting media file:', err);
      }
    }

    await post.deleteOne();

    res.status(200).json({ message: 'Scheduled post deleted successfully' });
  } catch (error) {
    console.error('Delete scheduled post error:', error);
    res.status(500).json({ message: error.message });
  }
};

/**
 * Helper: Get public URL for media file (must be reachable by Instagram)
 */
function getPublicMediaUrl(filePath, req) {
  const filename = path.basename(filePath);
  
  let baseUrl = process.env.BASE_URL || process.env.API_URL;
  
  // When behind nginx/reverse proxy, derive from request so Instagram gets the real public URL
  if (!baseUrl && req && req.get && req.get('host')) {
    const protocol = req.protocol || 'https';
    const host = req.get('host');
    baseUrl = `${protocol}://${host}`;
  }
  
  if (!baseUrl) {
    baseUrl = 'http://localhost:3000';
  }
  
  const publicUrl = `${baseUrl}/api/posts/media/${filename}`;
  
  console.log(`📎 [Media] Generated public URL: ${publicUrl}`);
  
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

  // Convert local file path to publicly accessible URL (use req so behind-proxy URL is correct)
  const mediaUrl = getPublicMediaUrl(mediaStoragePath, req);
  
  console.log(`📸 [Instagram] Publishing post with media: ${mediaUrl}`);

  try {
    // Create and publish post
    const result = await instagramService.createPost(connection, {
      caption: content,
      mediaUrl: mediaUrl,
      mediaType: mediaType
    });

    return {
      postId: result.postId,
      postUrl: result.postUrl
    };
  } catch (error) {
    console.error('❌ [Instagram] Publishing error:', error.message);
    throw error;
  }
}

/**
 * Helper: Publish to Facebook
 */
async function publishToFacebook(connection, post) {
  const { content, mediaStoragePath, mediaType } = post;
  const pageId = connection.platformPageId;

  // TODO: Implement Facebook Page Post API
  // Real implementation requires adding pages_manage_posts to scope
  
  throw new Error('Facebook publishing coming soon - requires pages_manage_posts permission');
  
  // Real implementation will be:
  // const result = await facebookService.createPost(connection, { message: content, mediaUrl: ... });
  // return { postId: result.id, postUrl: `https://facebook.com/${result.id}` };
}

module.exports = exports;
