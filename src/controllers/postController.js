const ScheduledPost = require('../models/ScheduledPost');
const PlatformConnection = require('../models/PlatformConnection');
const Media = require('../models/Media');
const instagramService = require('../integrations/meta/instagramService');
const facebookService = require('../integrations/meta/facebookService');
const linkedinService = require('../integrations/linkedin/linkedinService');
const aiService = require('../services/aiService');
const aiCreditService = require('../services/aiCreditService');
const auditLogController = require('./auditLogController');
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
    fileSize: 8 * 1024 * 1024 // 8MB limit per file
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
}).array('media', 10); // Support up to 10 files for carousel posts

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
    const result = await aiService.generatePost(prompt, platforms, mode, postType, organizationId);

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
 * @desc    Generate multiple post variants (Content Studio)
 * @route   POST /api/posts/generate-variants
 * @access  Private
 */
exports.generatePostVariantsWithAI = async (req, res) => {
  try {
    const { topic, platforms, count, audience, intent, includeTrend, postType, generateImage } = req.body;
    const organizationId = req.user.organization?._id || req.user.organization;

    if (!topic || !platforms || !Array.isArray(platforms) || platforms.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Topic and platforms are required'
      });
    }

    const variantCount = Math.min(parseInt(count, 10) || 3, 5);
    const withImages = !!generateImage;
    const totalCredits = variantCount + (withImages ? variantCount : 0); // text + optional image per variant

    const creditCheck = await aiCreditService.checkCredits(organizationId, totalCredits);
    if (!creditCheck.allowed) {
      return res.status(403).json({
        success: false,
        message: creditCheck.error || 'Insufficient AI credits',
        credits: {
          current: creditCheck.current,
          limit: creditCheck.limit,
          remaining: creditCheck.remaining,
          needed: totalCredits
        }
      });
    }

    const result = await aiService.generatePostVariants(topic, platforms, {
      count: variantCount,
      organizationId,
      postType: postType || 'post',
      audience: audience || '',
      intent: intent || '',
      includeTrend: !!includeTrend
    });

    await aiCreditService.deductCredits(organizationId, variantCount, {
      operation: 'post_variants',
      userId: req.user._id,
      topic: topic.substring(0, 100),
      platforms,
      variantCount
    });

    if (withImages && result.variants && result.variants.length > 0) {
      const uploadDir = path.join(__dirname, '../../uploads/posts');
      await fs.mkdir(uploadDir, { recursive: true });

      await Promise.all(result.variants.map(async (v, i) => {
        const imagePrompt = topic + (v.content ? ` Post style: ${v.content.substring(0, 200)}` : '');
        const buffer = await aiService.generateImage(imagePrompt);
        if (buffer) {
          const filename = `ai-${Date.now()}-${i}.png`;
          const fullPath = path.join(uploadDir, filename);
          await fs.writeFile(fullPath, buffer);
          v.imageUrl = getPublicMediaUrl(fullPath, req);
        }
      }));

      await aiCreditService.deductCredits(organizationId, variantCount, {
        operation: 'post_variants_image',
        userId: req.user._id,
        topic: topic.substring(0, 100),
        variantCount
      });
    }

    const updatedCredits = await aiCreditService.getUsage(organizationId);

    res.status(200).json({
      success: true,
      data: result,
      credits: {
        used: totalCredits,
        current: updatedCredits.current,
        limit: updatedCredits.limit,
        remaining: updatedCredits.remaining,
        isUnlimited: updatedCredits.isUnlimited
      }
    });
  } catch (error) {
    console.error('Generate post variants error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to generate variants'
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
      const { platform, content, scheduledFor, postType, mediaLibraryId, mediaLibraryIds } = req.body;
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

      // Check if using media from library or uploading new media
      if (mediaLibraryIds && mediaLibraryIds.length > 0) {
        // Multiple media from library (carousel)
        const libraryIds = Array.isArray(mediaLibraryIds) ? mediaLibraryIds : JSON.parse(mediaLibraryIds);
        const libraryMediaItems = await Media.find({
          _id: { $in: libraryIds },
          organization: organizationId
        });

        if (libraryMediaItems.length !== libraryIds.length) {
          return res.status(404).json({
            success: false,
            message: 'Some media items not found in library or do not belong to your organization'
          });
        }

        postData.mediaStoragePaths = libraryMediaItems.map(m => m.filePath);
        postData.mediaTypes = libraryMediaItems.map(m => m.mediaType);
        postData.mediaLibraryIds = libraryMediaItems.map(m => m._id);
        
        // For backward compatibility
        postData.mediaStoragePath = libraryMediaItems[0].filePath;
        postData.mediaType = libraryMediaItems[0].mediaType;

        console.log(`📚 [Post] Using ${libraryMediaItems.length} items from library for carousel`);
      } else if (mediaLibraryId) {
        // Single media from library
        const libraryMedia = await Media.findOne({
          _id: mediaLibraryId,
          organization: organizationId
        });

        if (!libraryMedia) {
          return res.status(404).json({
            success: false,
            message: 'Media not found in library or does not belong to your organization'
          });
        }

        postData.mediaStoragePath = libraryMedia.filePath;
        postData.mediaType = libraryMedia.mediaType;
        postData.mediaLibraryId = libraryMedia._id;

        console.log(`📚 [Post] Using media from library: ${libraryMedia.originalName}`);
      } else if (req.files && req.files.length > 0) {
        // Multiple media files (carousel)
        const mediaStoragePaths = [];
        const mediaTypes = [];
        
        for (const file of req.files) {
          const mediaType = file.mimetype.startsWith('image') ? 'image' : 'video';
          const fileExtension = path.extname(file.originalname);
          
          // Validate each media file
          const validation = validateMedia(
            platform.toLowerCase(),
            mediaType,
            file.size,
            fileExtension,
            postType
          );

          if (!validation.valid) {
            // Delete all uploaded files on validation failure
            for (const f of req.files) {
              try {
                await fs.unlink(f.path);
              } catch (err) {
                console.error('Error deleting file:', err);
              }
            }
            
            return res.status(400).json({
              success: false,
              message: `Media validation failed for ${file.originalname}`,
              errors: validation.errors,
              warnings: validation.warnings
            });
          }

          if (validation.warnings.length > 0) {
            console.warn(`⚠️ Media warnings for ${file.originalname}:`, validation.warnings);
          }

          mediaStoragePaths.push(file.path);
          mediaTypes.push(mediaType);
        }

        postData.mediaStoragePaths = mediaStoragePaths;
        postData.mediaTypes = mediaTypes;
        
        // For backward compatibility, also set single media fields to first item
        postData.mediaStoragePath = mediaStoragePaths[0];
        postData.mediaType = mediaTypes[0];
        
        console.log(`📎 [Upload] ${mediaStoragePaths.length} media files uploaded for carousel`);
      } else if (req.file) {
        // Single media file (legacy support)
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
          case 'linkedin':
            result = await publishToLinkedIn(connection, post);
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

        // Track media usage if using library media
        if (post.mediaLibraryId) {
          try {
            const media = await Media.findById(post.mediaLibraryId);
            if (media) {
              await media.incrementUsage();
              console.log(`📈 [Media Library] Usage incremented for ${media.originalName}`);
            }
          } catch (err) {
            console.error('Error tracking media usage:', err);
            // Non-critical, don't fail the request
          }
        }

        // Track usage for carousel media
        if (post.mediaLibraryIds && post.mediaLibraryIds.length > 0) {
          try {
            for (const mediaId of post.mediaLibraryIds) {
              const media = await Media.findById(mediaId);
              if (media) {
                await media.incrementUsage();
              }
            }
            console.log(`📈 [Media Library] Usage incremented for ${post.mediaLibraryIds.length} carousel items`);
          } catch (err) {
            console.error('Error tracking carousel media usage:', err);
            // Non-critical, don't fail the request
          }
        }

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
      const { platform, content, scheduledFor, postType, mediaLibraryId, mediaUrl } = req.body;
      const userId = req.user.id;
      const organizationId = req.user.organization?._id || req.user.organization;

      if (!platform || !content || !scheduledFor) {
        return res.status(400).json({ message: 'Platform, content, and scheduledFor are required' });
      }

      let query = {
        organization: organizationId,
        platform: platform.toLowerCase(),
        isActive: true
      };
      if (platform.toLowerCase() === 'facebook') {
        query.platformPageId = { $exists: true, $ne: null };
        query.usesAccountSlot = true;
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

      // Check if using media from library, AI-generated media URL, or uploading new media
      if (mediaLibraryId) {
        // Use media from library
        const libraryMedia = await Media.findOne({
          _id: mediaLibraryId,
          organization: organizationId
        });

        if (!libraryMedia) {
          return res.status(404).json({
            success: false,
            message: 'Media not found in library or does not belong to your organization'
          });
        }

        // Use library media's file path and type
        postData.mediaStoragePath = libraryMedia.filePath;
        postData.mediaType = libraryMedia.mediaType;
        postData.mediaLibraryId = libraryMedia._id; // Track which library media is used

        console.log(`📚 [Post] Using media from library: ${libraryMedia.originalName} (${libraryMedia._id})`);
      } else if (mediaUrl && typeof mediaUrl === 'string' && mediaUrl.includes('/api/posts/media/')) {
        const filename = mediaUrl.split('/api/posts/media/').pop()?.split('?')[0]?.trim();
        if (filename) {
          const uploadDir = path.join(__dirname, '../../uploads/posts');
          const fullPath = path.join(uploadDir, filename);
          try {
            await fs.access(fullPath);
            postData.mediaStoragePath = fullPath;
            postData.mediaType = 'image';
          } catch {
            // File not found, ignore mediaUrl
          }
        }
      } else if (req.file) {
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
 * @desc    Get dashboard counts (scheduled, pending approval, AI %)
 * @route   GET /api/posts/dashboard-counts
 * @access  Private
 */
exports.getDashboardCounts = async (req, res) => {
  try {
    const organizationId = req.user.organization?._id || req.user.organization;

    const [scheduled, pendingApproval, totalPosts, aiGenerated] = await Promise.all([
      ScheduledPost.countDocuments({ organization: organizationId, status: 'scheduled' }),
      ScheduledPost.countDocuments({ organization: organizationId, status: 'pending_approval' }),
      ScheduledPost.countDocuments({ organization: organizationId, status: { $in: ['scheduled', 'published', 'draft', 'pending_approval'] } }),
      ScheduledPost.countDocuments({ organization: organizationId, generatedBy: 'ai', status: { $in: ['scheduled', 'published'] } })
    ]);

    const aiGeneratedPercent = totalPosts > 0 ? Math.round((aiGenerated / totalPosts) * 100) : 0;

    res.status(200).json({
      success: true,
      data: { scheduled, pendingApproval, aiGeneratedPercent }
    });
  } catch (error) {
    console.error('Get dashboard counts error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
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
 * @desc    Get posts pending approval (Approval Queue)
 * @route   GET /api/posts/pending-approval
 * @access  Private
 */
exports.getPendingApprovalPosts = async (req, res) => {
  try {
    const organizationId = req.user.organization?._id || req.user.organization;

    const posts = await ScheduledPost.find({
      organization: organizationId,
      status: 'pending_approval'
    })
      .sort({ createdAt: -1 })
      .populate('platformConnection', 'platform platformPageId platformUsername')
      .populate('user', 'name email')
      .lean();

    res.status(200).json({
      success: true,
      data: posts,
      count: posts.length
    });
  } catch (error) {
    console.error('Get pending approval posts error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
};

/**
 * @desc    Approve a post (optionally set scheduledFor and status to scheduled)
 * @route   PATCH /api/posts/:id/approve
 * @access  Private
 */
exports.approvePost = async (req, res) => {
  try {
    const { id } = req.params;
    const { scheduledFor } = req.body;
    const organizationId = req.user.organization?._id || req.user.organization;

    const post = await ScheduledPost.findOne({
      _id: id,
      organization: organizationId,
      status: 'pending_approval'
    });

    if (!post) {
      return res.status(404).json({
        success: false,
        message: 'Post not found or not pending approval'
      });
    }

    post.status = scheduledFor ? 'scheduled' : 'draft';
    post.approvedBy = req.user._id;
    post.approvedAt = new Date();
    if (scheduledFor) post.scheduledFor = new Date(scheduledFor);
    await post.save();

    await auditLogController.log(
      organizationId,
      'post',
      post._id,
      'approved',
      req.user._id,
      { scheduledFor: post.scheduledFor, status: post.status }
    );

    res.status(200).json({
      success: true,
      data: post
    });
  } catch (error) {
    console.error('Approve post error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
};

/**
 * @desc    Reject a post
 * @route   PATCH /api/posts/:id/reject
 * @access  Private
 */
exports.rejectPost = async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;
    const organizationId = req.user.organization?._id || req.user.organization;

    const post = await ScheduledPost.findOne({
      _id: id,
      organization: organizationId,
      status: 'pending_approval'
    });

    if (!post) {
      return res.status(404).json({
        success: false,
        message: 'Post not found or not pending approval'
      });
    }

    post.status = 'rejected';
    post.rejectedBy = req.user._id;
    post.rejectedAt = new Date();
    if (reason) post.rejectedReason = reason;
    await post.save();

    await auditLogController.log(
      organizationId,
      'post',
      post._id,
      'rejected',
      req.user._id,
      { reason: post.rejectedReason }
    );

    res.status(200).json({
      success: true,
      data: post
    });
  } catch (error) {
    console.error('Reject post error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
};

/**
 * @desc    Create post as pending approval (Send to Approval from Content Studio)
 * @route   POST /api/posts/to-approval
 * @access  Private
 */
exports.sendToApproval = async (req, res) => {
  try {
    const { platform, content, postType, originalContent, riskScore, complianceFlags, generatedBy, mediaUrl } = req.body;
    const organizationId = req.user.organization?._id || req.user.organization;
    const userId = req.user._id;

    if (!platform || !content) {
      return res.status(400).json({
        success: false,
        message: 'Platform and content are required'
      });
    }

    const connection = await PlatformConnection.findOne({
      organization: organizationId,
      platform: platform.toLowerCase(),
      isActive: true
    });

    if (!connection) {
      return res.status(404).json({
        success: false,
        message: `No active ${platform} connection found`
      });
    }

    const postData = {
      organization: organizationId,
      user: userId,
      platform: platform.toLowerCase(),
      platformConnection: connection._id,
      content: content.trim(),
      status: 'pending_approval',
      postType: postType || 'post',
      originalContent: originalContent || content.trim(),
      riskScore: riskScore != null ? Number(riskScore) : undefined,
      complianceFlags: Array.isArray(complianceFlags) ? complianceFlags : [],
      generatedBy: generatedBy === 'ai' ? 'ai' : 'human'
    };

    if (mediaUrl && typeof mediaUrl === 'string' && mediaUrl.includes('/api/posts/media/')) {
      const filename = mediaUrl.split('/api/posts/media/').pop()?.split('?')[0]?.trim();
      if (filename) {
        const uploadDir = path.join(__dirname, '../../uploads/posts');
        const fullPath = path.join(uploadDir, filename);
        try {
          await fs.access(fullPath);
          postData.mediaStoragePath = fullPath;
          postData.mediaType = 'image';
        } catch {
          // File not found
        }
      }
    }

    const post = await ScheduledPost.create(postData);

    res.status(201).json({
      success: true,
      data: post
    });
  } catch (error) {
    console.error('Send to approval error:', error);
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
exports.reschedulePost = async (req, res) => {
  try {
    const organizationId = req.user.organization?._id || req.user.organization;
    const { scheduledFor } = req.body;
    if (!scheduledFor) {
      return res.status(400).json({ success: false, message: 'scheduledFor is required' });
    }
    const post = await ScheduledPost.findOneAndUpdate(
      { _id: req.params.id, organization: organizationId, status: 'scheduled' },
      { $set: { scheduledFor: new Date(scheduledFor) } },
      { new: true }
    );
    if (!post) {
      return res.status(404).json({ success: false, message: 'Scheduled post not found' });
    }
    res.status(200).json({ success: true, data: post });
  } catch (error) {
    console.error('Reschedule post error:', error);
    res.status(500).json({ success: false, error: error.message });
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

    // Delete media files (carousel or single)
    if (post.mediaStoragePaths && post.mediaStoragePaths.length > 0) {
      // Carousel - delete all media files
      for (const mediaPath of post.mediaStoragePaths) {
        try {
          await fs.unlink(mediaPath);
          console.log(`🗑️  Deleted carousel media: ${mediaPath}`);
        } catch (err) {
          console.error('Error deleting carousel media:', err);
        }
      }
    } else if (post.mediaStoragePath) {
      // Single media file
      try {
        await fs.unlink(post.mediaStoragePath);
        console.log(`🗑️  Deleted media: ${post.mediaStoragePath}`);
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
  const { content, mediaStoragePath, mediaStoragePaths, mediaType, mediaTypes, postType } = post;

  // Check if carousel (multiple media)
  const isCarousel = mediaStoragePaths && mediaStoragePaths.length > 1;

  if (!mediaStoragePath && !isCarousel) {
    throw new Error('Instagram posts require an image or video');
  }

  let result;

  // Handle carousel posts (multiple media)
  if (isCarousel) {
    console.log(`🎠 [Instagram] Publishing carousel with ${mediaStoragePaths.length} items`);
    
    // Generate public URLs for all media
    const mediaUrls = mediaStoragePaths.map((storagePath, index) => {
      return {
        url: getPublicMediaUrl(storagePath, req),
        type: mediaTypes[index]
      };
    });

    result = await instagramService.createCarouselPost(connection, {
      caption: content,
      mediaUrls: mediaUrls
    });

    return {
      postId: result.postId,
      postUrl: result.postUrl
    };
  }

  // Handle single media posts
  const mediaUrl = getPublicMediaUrl(mediaStoragePath, req);
  console.log(`📸 [Instagram] Publishing ${postType || 'post'} with media: ${mediaUrl}`);

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

/**
 * Helper: Publish to LinkedIn (Company Page or personal profile)
 */
async function publishToLinkedIn(connection, post) {
  const { content, mediaStoragePath, mediaStoragePaths, mediaType, mediaTypes } = post;

  let storagePath = mediaStoragePath;
  let resolvedType = mediaType;
  if (!storagePath && mediaStoragePaths && mediaStoragePaths.length > 0) {
    storagePath = mediaStoragePaths[0];
    resolvedType = (mediaTypes && mediaTypes[0]) || 'image';
  }

  console.log(
    `💼 [LinkedIn] Publishing post (media: ${storagePath ? resolvedType || 'file' : 'none'})`
  );

  let media = null;
  if (storagePath) {
    if (resolvedType === 'video') {
      throw new Error(
        'LinkedIn publishing with video is not supported yet. Use an image or text-only post.'
      );
    }
    if (resolvedType === 'image') {
      const imageBuffer = await fs.readFile(storagePath);
      const ext = path.extname(storagePath).toLowerCase();
      const contentType =
        ext === '.png'
          ? 'image/png'
          : ext === '.gif'
            ? 'image/gif'
            : ext === '.webp'
              ? 'image/webp'
              : 'image/jpeg';
      media = { imageBuffer, contentType };
    }
  }

  const result = await linkedinService.createPost(connection, content || '', media);

  return {
    postId: result.postId,
    postUrl: result.postUrl
  };
}

/**
 * Execute publish for a single scheduled post (used by processScheduledPublish job).
 */
exports.executePublishForScheduledPost = async function (postId) {
  const post = await ScheduledPost.findById(postId).populate('platformConnection');
  if (!post || post.status !== 'scheduled') {
    return { success: false, error: 'Post not found or not scheduled' };
  }
  const connection = post.platformConnection;
  if (!connection) {
    post.status = 'failed';
    post.error = 'Platform connection not found';
    await post.save();
    return { success: false, error: post.error };
  }
  const req = {
    protocol: 'https',
    get: (name) => (name === 'host' ? (process.env.API_URL || process.env.BASE_URL || 'localhost:3000').replace(/^https?:\/\//, '') : null)
  };
  post.status = 'publishing';
  await post.save();
  try {
    let result;
    if (post.platform === 'instagram') {
      result = await publishToInstagram(connection, post, req);
    } else if (post.platform === 'facebook') {
      result = await publishToFacebook(connection, post, req);
    } else if (post.platform === 'linkedin') {
      result = await publishToLinkedIn(connection, post);
    } else {
      post.status = 'failed';
      post.error = 'Unsupported platform: ' + post.platform;
      await post.save();
      return { success: false, error: post.error };
    }
    post.status = 'published';
    post.publishedAt = new Date();
    post.platformPostId = result.postId;
    post.platformPostUrl = result.postUrl;
    post.error = undefined;
    await post.save();
    return { success: true };
  } catch (err) {
    post.status = 'failed';
    post.error = err.message;
    await post.save();
    return { success: false, error: err.message };
  }
};
