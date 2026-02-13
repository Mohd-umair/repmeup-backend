const ScheduledPost = require('../models/ScheduledPost');
const PlatformConnection = require('../models/PlatformConnection');
const instagramService = require('../integrations/meta/instagramService');
const facebookService = require('../integrations/meta/facebookService');
const aiService = require('../services/aiService');
const aiCreditService = require('../services/aiCreditService');
const multer = require('multer');
const path = require('path');
const fs = require('fs').promises;
const crypto = require('crypto');
const { validateMedia, getRequirementsText } = require('../config/platformMediaRequirements');

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
 * @desc    Generate post content with AI
 * @route   POST /api/posts/generate
 * @access  Private
 */
exports.generatePostWithAI = async (req, res) => {
  try {
    const { prompt, platforms, mode, postType } = req.body;
    const organizationId = req.user.organization?._id || req.user.organization;

    // Validation
    if (!prompt || !platforms || platforms.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Prompt and platforms are required'
      });
    }

    if (!['same', 'custom'].includes(mode)) {
      return res.status(400).json({
        success: false,
        message: 'Mode must be "same" or "custom"'
      });
    }

    // Calculate credits needed
    const creditsNeeded = mode === 'same' ? 1 : platforms.length;

    // Check credits
    const creditCheck = await aiCreditService.checkCredits(organizationId, creditsNeeded);

    if (!creditCheck.allowed) {
      return res.status(403).json({
        success: false,
        message: creditCheck.error || 'Insufficient AI credits',
        credits: {
          current: creditCheck.current,
          limit: creditCheck.limit,
          remaining: creditCheck.remaining,
          needed: creditsNeeded
        }
      });
    }

    // Generate posts
    const result = await aiService.generatePost(prompt, platforms, mode, postType);

    // Deduct credits
    await aiCreditService.deductCredits(organizationId, result.creditsUsed, {
      operation: 'post_generation',
      userId: req.user._id,
      prompt: prompt.substring(0, 100),
      platforms: platforms,
      mode: mode,
      postType: postType
    });

    // Get updated credit balance
    const updatedCredits = await aiCreditService.getUsage(organizationId);

    res.status(200).json({
      success: true,
      data: result,
      credits: {
        used: result.creditsUsed,
        current: updatedCredits.current,
        limit: updatedCredits.limit,
        remaining: updatedCredits.remaining,
        isUnlimited: updatedCredits.isUnlimited
      }
    });
  } catch (error) {
    console.error('Generate post with AI error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to generate post'
    });
  }
};

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
        const mediaType = req.file.mimetype.startsWith('image') ? 'image' : 'video';
        const fileExtension = path.extname(req.file.originalname);
        
        // Validate media against platform requirements
        const validation = validateMedia(
          platform.toLowerCase(),
          mediaType,
          req.file.size,
          fileExtension,
          postType
        );

        if (!validation.valid) {
          // Delete uploaded file
          try {
            await fs.unlink(req.file.path);
          } catch (err) {
            console.error('Error deleting invalid file:', err);
          }
          
          return res.status(400).json({
            success: false,
            message: 'Media validation failed',
            errors: validation.errors,
            warnings: validation.warnings
          });
        }

        // Log warnings if any
        if (validation.warnings.length > 0) {
          console.warn('⚠️ Media warnings:', validation.warnings);
        }

        postData.mediaStoragePath = req.file.path;
        postData.mediaType = mediaType;
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
        const mediaType = req.file.mimetype.startsWith('image') ? 'image' : 'video';
        const fileExtension = path.extname(req.file.originalname);
        
        // Validate media against platform requirements
        const validation = validateMedia(
          platform.toLowerCase(),
          mediaType,
          req.file.size,
          fileExtension,
          postType
        );

        if (!validation.valid) {
          // Delete uploaded file
          try {
            await fs.unlink(req.file.path);
          } catch (err) {
            console.error('Error deleting invalid file:', err);
          }
          
          return res.status(400).json({
            success: false,
            message: 'Media validation failed',
            errors: validation.errors,
            warnings: validation.warnings
          });
        }

        // Log warnings if any
        if (validation.warnings.length > 0) {
          console.warn('⚠️ Media warnings:', validation.warnings);
        }

        postData.mediaStoragePath = req.file.path;
        postData.mediaType = mediaType;
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

    res.status(200).json({ 
      success: true,
      data: posts,
      count: posts.length
    });
  } catch (error) {
    console.error('Get scheduled posts error:', error);
    res.status(500).json({ 
      success: false,
      error: error.message 
    });
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
 * @desc    Get media requirements for platforms
 * @route   GET /api/posts/media-requirements
 * @access  Public
 */
exports.getMediaRequirements = (req, res) => {
  try {
    const { platform, postType } = req.query;

    if (platform) {
      const requirements = getRequirementsText(platform, postType || 'post');
      if (!requirements) {
        return res.status(404).json({
          success: false,
          message: `Requirements for platform ${platform} not found`
        });
      }
      return res.status(200).json({
        success: true,
        data: requirements
      });
    }

    // Return all platforms
    const allRequirements = {
      facebook: getRequirementsText('facebook', postType || 'post'),
      instagram: getRequirementsText('instagram', postType || 'post'),
      linkedin: getRequirementsText('linkedin', postType || 'post')
    };

    res.status(200).json({
      success: true,
      data: allRequirements
    });
  } catch (error) {
    console.error('Get media requirements error:', error);
    res.status(500).json({
      success: false,
      message: error.message
    });
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
  const { content, mediaStoragePath, mediaType, postType } = post;

  if (!mediaStoragePath) {
    throw new Error('Instagram posts require an image or video');
  }

  const mediaUrl = getPublicMediaUrl(mediaStoragePath, req);
  console.log(`📸 [Instagram] Publishing ${postType || 'post'} with media: ${mediaUrl}`);

  let result;

  // Route to appropriate method based on post type
  switch (postType) {
    case 'story':
      console.log(`📖 [Instagram] Creating story`);
      result = await instagramService.createStory(connection, {
        mediaUrl: mediaUrl,
        mediaType: mediaType
      });
      break;

    case 'reel':
      if (mediaType !== 'video') {
        throw new Error('Instagram Reels require a video file');
      }
      console.log(`🎬 [Instagram] Creating reel`);
      result = await instagramService.createReel(connection, {
        caption: content,
        mediaUrl: mediaUrl
      });
      break;

    case 'post':
    default:
      console.log(`📸 [Instagram] Creating regular post`);
      result = await instagramService.createPost(connection, {
        caption: content,
        mediaUrl: mediaUrl,
        mediaType: mediaType
      });
      break;
  }

  return {
    postId: result.postId,
    postUrl: result.postUrl
  };
}

/**
 * Helper: Publish to Facebook (pages_manage_posts)
 */
async function publishToFacebook(connection, post, req) {
  const { content, mediaStoragePath, mediaType, postType } = post;
  
  console.log(`📘 [Facebook] Publishing ${postType || 'post'} with media: ${mediaStoragePath ? 'yes' : 'no'}`);

  let result;

  // Route to appropriate method based on post type
  switch (postType) {
    case 'story':
      // Facebook Stories
      if (!mediaStoragePath) {
        throw new Error('Facebook stories require an image or video');
      }
      
      console.log(`📖 [Facebook] Creating story`);
      
      if (mediaType === 'image') {
        const imageBuffer = await fs.readFile(mediaStoragePath);
        result = await facebookService.createStory(connection, {
          imageBuffer: imageBuffer
        });
      } else if (mediaType === 'video') {
        const videoUrl = getPublicMediaUrl(mediaStoragePath, req);
        result = await facebookService.createStory(connection, {
          videoUrl: videoUrl
        });
      } else {
        throw new Error('Invalid media type for story');
      }
      break;

    case 'reel':
    case 'short':
      // Facebook Reels (also called Shorts)
      if (!mediaStoragePath || mediaType !== 'video') {
        throw new Error('Facebook Reels require a video file');
      }
      
      console.log(`🎬 [Facebook] Creating reel/short`);
      const reelVideoUrl = getPublicMediaUrl(mediaStoragePath, req);
      
      result = await facebookService.createReel(connection, {
        videoUrl: reelVideoUrl,
        description: content,
        title: content ? content.substring(0, 50) : 'Reel'
      });
      break;

    case 'post':
    default:
      // Regular Facebook Post
      if (mediaStoragePath && mediaType === 'image') {
        try {
          console.log(`📸 [Facebook] Reading image file: ${mediaStoragePath}`);
          
          // Read the image file as a buffer
          const imageBuffer = await fs.readFile(mediaStoragePath);
          
          console.log(`📤 [Facebook] Uploading image directly (${imageBuffer.length} bytes)`);
          
          const payload = { 
            message: content || ' ',
            imageBuffer: imageBuffer
          };
          
          result = await facebookService.createPost(connection, payload);
        } catch (imageError) {
          console.warn(`⚠️ [Facebook] Direct image upload failed, falling back to text-only:`, imageError.message);
          
          // Fallback: Post as text-only to feed
          const textPayload = { message: content || 'Posted from RepMeUp' };
          result = await facebookService.createPost(connection, textPayload);
        }
      } else if (mediaStoragePath && mediaType === 'video') {
        // Video post
        const videoUrl = getPublicMediaUrl(mediaStoragePath, req);
        result = await facebookService.createVideoPost(connection, {
          videoUrl: videoUrl,
          description: content
        });
      } else {
        // Text-only post
        console.log(`📝 [Facebook] Publishing text-only post`);
        const payload = { message: content || 'Posted from RepMeUp' };
        result = await facebookService.createPost(connection, payload);
      }
      break;
  }

  return {
    postId: result.postId,
    postUrl: result.postUrl
  };
}
