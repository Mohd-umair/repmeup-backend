const ScheduledPost = require('../models/ScheduledPost');
const PlatformConnection = require('../models/PlatformConnection');
const Media = require('../models/Media');
const Notification = require('../models/Notification');
const User = require('../models/User');
const storageService = require('../services/storageService');
const aiCreditService = require('../services/aiCreditService');
const entitlementsService = require('../services/entitlementsService');
const { FEATURE_KEYS } = require('../config/featureCatalog');
const postAiGenerationService = require('../services/postAiGenerationService');
const { PostAiGenerationError } = postAiGenerationService;
const postPublishService = require('../services/postPublishService');
const { PostPublishError } = postPublishService;
const { assertScheduledForMinLead } = require('../utils/scheduleMinLead');

/**
 * Translate an EntitlementError thrown by entitlementsService into the same
 * JSON envelope used by other controllers (so the FE error handling is uniform).
 */
function respondEntitlement(res, err) {
  return res.status(err.statusCode || 402).json({
    success: false,
    code: err.code,
    error: err.message,
    featureKey: err.featureKey,
    meta: err.meta
  });
}
const auditLogController = require('./auditLogController');
const logger = require('../config/logger');
const multer = require('multer');
const path = require('path');
const fs = require('fs').promises;
const { validateMedia, getRequirementsText } = require('../config/platformMediaRequirements');
const { parsePagination, paginationMeta } = require('../utils/pagination');

async function removeStoredMediaRef(ref) {
  if (!ref) return;
  const s = String(ref);
  if (/^https?:\/\//i.test(s)) {
    await storageService.deleteObjectFromPublicUrl(s);
    return;
  }
  try {
    await fs.unlink(s);
  } catch (_) {}
}


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
 * Notify all admin / manager users in an organization that a post is awaiting approval.
 * Fires-and-forgets (non-blocking); errors are logged but never bubble up to callers.
 */
async function notifyAdminsOfPendingPost(organizationId, post, agentName) {
  try {
    const admins = await User.find({
      organization: organizationId,
      role: { $in: ['admin', 'manager', 'super_admin'] },
      isActive: { $ne: false },
      isDeleted: { $ne: true }
    }).select('_id').lean();

    if (!admins.length) return;

    const platform = post.platform ? post.platform.charAt(0).toUpperCase() + post.platform.slice(1) : 'a platform';
    const preview = post.content ? post.content.substring(0, 80) + (post.content.length > 80 ? '…' : '') : '';

    const notifications = admins.map(admin => ({
      user: admin._id,
      organization: organizationId,
      type: 'post_pending_approval',
      title: 'New Post Awaiting Approval',
      message: `${agentName} submitted a ${platform} post for review: "${preview}"`,
      relatedTo: { model: 'ScheduledPost', id: post._id },
      actionUrl: '/app/approval-queue',
      deliveryMethod: ['in_app']
    }));

    await Notification.insertMany(notifications, { ordered: false });
  } catch (err) {
    logger.error('[notifyAdminsOfPendingPost] Error creating notifications', { error: err.message });
  }
}

/**
 * Notify the post creator (agent) that their post has been approved or rejected.
 * Fires-and-forgets (non-blocking).
 */
async function notifyAgentOfDecision(userId, organizationId, post, decision, rejectedReason) {
  try {
    const isApproved = decision === 'approved';
    const platform = post.platform ? post.platform.charAt(0).toUpperCase() + post.platform.slice(1) : 'a platform';
    const preview = post.content ? post.content.substring(0, 60) + (post.content.length > 60 ? '…' : '') : '';

    await Notification.create({
      user: userId,
      organization: organizationId,
      type: isApproved ? 'post_approved' : 'post_rejected',
      title: isApproved ? 'Your Post Was Approved' : 'Your Post Was Rejected',
      message: isApproved
        ? `Your ${platform} post "${preview}" has been approved and is ready to publish.`
        : `Your ${platform} post "${preview}" was rejected${rejectedReason ? `: "${rejectedReason}"` : '. You can edit and resubmit it.'}`,
      relatedTo: { model: 'ScheduledPost', id: post._id },
      actionUrl: '/app/approval-queue',
      deliveryMethod: ['in_app']
    });
  } catch (err) {
    logger.error('[notifyAgentOfDecision] Error creating notification', { error: err.message });
  }
}

/**
 * AI-generation endpoints.
 *
 * These handlers are intentionally thin: parse req → delegate to
 * `postAiGenerationService` → translate `PostAiGenerationError` into the
 * HTTP response. All prompt building, credit management, storage, and Sora
 * orchestration lives in the service.
 */
function respondPostAiError(res, err, fallbackMessage) {
  if (err instanceof PostAiGenerationError) {
    return res.status(err.statusCode).json({
      success: false,
      code: err.code || undefined,
      message: err.message,
      ...(err.extras || {})
    });
  }
  logger.error('[postController] unexpected AI error', { error: err.message, stack: err.stack });
  return res.status(500).json({ success: false, message: err.message || fallbackMessage });
}

exports.generatePostWithAI = async (req, res) => {
  try {
    const { prompt, platforms, mode, postType } = req.body;
    const organizationId = req.user.organization?._id || req.user.organization;

    // Plan gates: per-post platform cap + monthly post-creation credits.
    const platformCount = Array.isArray(platforms) ? platforms.length : 1;
    await entitlementsService.assert(
      organizationId,
      FEATURE_KEYS.POSTS_PLATFORMS_MAX,
      platformCount
    );
    await entitlementsService.assert(
      organizationId,
      FEATURE_KEYS.CREDITS_POST_CREATION,
      1
    );

    const result = await postAiGenerationService.generatePostText({
      prompt, platforms, mode, postType,
      organizationId,
      userId: req.user._id
    });

    // Bucket consumption is recorded AFTER a successful AI call so failed
    // generations don't burn the credit (mirrors how aiCreditService works).
    await entitlementsService
      .consume(organizationId, FEATURE_KEYS.CREDITS_POST_CREATION, 1)
      .catch((e) => logger.warn('[postAI] post-creation bucket consume failed', { err: e.message }));

    res.status(200).json({ success: true, data: result.data, credits: result.credits });
  } catch (err) {
    if (err?.name === 'EntitlementError') return respondEntitlement(res, err);
    respondPostAiError(res, err, 'Failed to generate post');
  }
};

exports.generatePostVariantsWithAI = async (req, res) => {
  try {
    const {
      topic, platforms, count, audience, intent, mood,
      includeTrend, postType, generationMode, eventTemplateId
    } = req.body;
    const organizationId = req.user.organization?._id || req.user.organization;

    // Plan gates:
    //   1. trends opt-in must be allowed if the request asks for it
    //   2. variant count cannot exceed the per-plan ceiling
    //   3. platform-fan-out cap applied per generation request
    //   4. burns 1 post-creation credit per variant
    if (includeTrend) {
      await entitlementsService.assert(organizationId, FEATURE_KEYS.POSTS_TRENDS);
    }
    const requestedVariants = Math.max(1, Number(count) || 1);
    await entitlementsService.assert(
      organizationId,
      FEATURE_KEYS.POSTS_AI_VARIANTS_MAX,
      requestedVariants
    );
    const platformCount = Array.isArray(platforms) ? platforms.length : 1;
    await entitlementsService.assert(
      organizationId,
      FEATURE_KEYS.POSTS_PLATFORMS_MAX,
      platformCount
    );
    await entitlementsService.assert(
      organizationId,
      FEATURE_KEYS.CREDITS_POST_CREATION,
      requestedVariants
    );

    const result = await postAiGenerationService.generatePostVariants({
      topic, platforms, count, audience, intent, mood,
      includeTrend, postType, generationMode, eventTemplateId,
      organizationId,
      userId: req.user._id
    });

    await entitlementsService
      .consume(organizationId, FEATURE_KEYS.CREDITS_POST_CREATION, requestedVariants)
      .catch((e) => logger.warn('[postAI] post-creation bucket consume failed', { err: e.message }));

    res.status(200).json({ success: true, data: result.data, credits: result.credits });
  } catch (err) {
    if (err?.name === 'EntitlementError') return respondEntitlement(res, err);
    respondPostAiError(res, err, 'Failed to generate variants');
  }
};

exports.generateVariantImage = async (req, res) => {
  try {
    const {
      topic, variantContent, imageConfig, variantIndex, contentType,
      generationMode, logoOverlay, logoPosition, logoUrl,
      eventTemplateId, includePeople, peopleNationality
    } = req.body;
    const organizationId = req.user.organization?._id || req.user.organization;
    const out = await postAiGenerationService.generateVariantImage({
      topic, variantContent, imageConfig, variantIndex, contentType,
      generationMode, logoOverlay, logoPosition, logoUrl,
      eventTemplateId, includePeople, peopleNationality,
      organizationId,
      userId: req.user._id,
      req
    });
    res.status(200).json({
      success: true,
      imageUrl: out.imageUrl,
      savedToLibrary: out.savedToLibrary,
      designDna: out.designDna,
      credits: out.credits
    });
  } catch (err) {
    respondPostAiError(res, err, 'Failed to generate image');
  }
};

exports.generateVariantVideo = async (req, res) => {
  try {
    const { topic, variantContent, videoConfig, variantIndex } = req.body;
    const organizationId = req.user.organization?._id || req.user.organization;
    const { jobId } = await postAiGenerationService.submitVariantVideoJob({
      topic, variantContent, videoConfig, variantIndex,
      organizationId,
      userId: req.user._id
    });
    res.status(202).json({ success: true, jobId });
  } catch (err) {
    respondPostAiError(res, err, 'Failed to start video generation');
  }
};

exports.getVideoJobStatus = async (req, res) => {
  try {
    const status = await postAiGenerationService.getVideoJobStatus(req.params.jobId);
    res.json({ success: true, ...status });
  } catch (err) {
    respondPostAiError(res, err, 'Failed to fetch job status');
  }
};

/**
 * @desc    Save an AI-generated variant as a draft
 * @route   POST /api/posts/save-draft
 * @access  Private
 */
exports.saveDraft = async (req, res) => {
  try {
    const {
      platform, content, postType, mediaUrl, generatedBy,
      topic, audience, intent, mood, contentType, postFormat,
      visualStyle, logoOverlay, logoPosition, designDna
    } = req.body;
    const organizationId = req.user.organization?._id || req.user.organization;
    const userId = req.user._id;

    if (!platform || !content) {
      return res.status(400).json({ success: false, message: 'platform and content are required' });
    }

    const connection = await PlatformConnection.findOne({
      organization: organizationId,
      platform: platform.toLowerCase(),
      isActive: true
    });

    if (!connection) {
      return res.status(404).json({ success: false, message: `No active ${platform} connection found. Connect the platform in Settings.` });
    }

    const draftData = {
      organization: organizationId,
      user: userId,
      platform: platform.toLowerCase(),
      platformConnection: connection._id,
      content: content.trim(),
      postType: postType || 'post',
      status: 'draft',
      generatedBy: generatedBy || 'ai',
      metadata: {
        topic: topic || '',
        audience: audience || '',
        intent: intent || '',
        mood: mood || '',
        contentType: contentType || 'text',
        postFormat: postFormat || 'post',
        visualStyle: visualStyle || '',
        logoOverlay: logoOverlay || false,
        logoPosition: logoPosition || 'bottom-right',
        // Design DNA — stored for the learning loop (Phase 3)
        generationPrompt: designDna?.generationPrompt || null,
        layoutType: designDna?.layoutType || null,
        colors: designDna?.colors || [],
        medium: designDna?.medium || null,
        style: designDna?.style || null,
        designScore: null
      }
    };

    if (mediaUrl && typeof mediaUrl === 'string') {
      if (/^https?:\/\//i.test(mediaUrl.trim())) {
        draftData.mediaStoragePath = mediaUrl.split('?')[0].trim();
        draftData.mediaType = /\.mp4(\?|$)/i.test(mediaUrl) ? 'video' : 'image';
      } else {
        const filename = mediaUrl.split('/api/posts/media/').pop()?.split('?')[0]?.trim();
        if (filename) {
          const uploadDir = path.join(__dirname, '../../uploads/posts');
          const fullPath = path.join(uploadDir, filename);
          draftData.mediaStoragePath = fullPath;
          draftData.mediaType = filename.endsWith('.mp4') ? 'video' : 'image';
        } else {
          draftData.mediaUrl = mediaUrl;
        }
      }
    }

    const draft = await ScheduledPost.create(draftData);
    logger.info(`[Content Studio] Draft saved: ${draft._id} for org ${organizationId}`);

    res.status(201).json({ success: true, draft });
  } catch (err) {
    logger.error('Save draft error', { error: err.message, stack: err.stack });
    res.status(500).json({ success: false, message: err.message || 'Failed to save draft' });
  }
};

/**
 * @desc    Publish post immediately (or schedule it / route to approval).
 * @route   POST /api/posts/publish
 * @access  Private
 */
exports.publishPost = async (req, res) => {
  upload(req, res, async function (err) {
    if (err) {
      logger.error('[postController] publishPost upload error', { error: err.message });
      return res.status(400).json({ message: err.message });
    }

    try {
      const { platform, content, scheduledFor, postType, generatedBy, designDna } = req.body;
      const userId = req.user._id;
      const organizationId = req.user.organization?._id || req.user.organization;

      if (!platform || !content) {
        return res.status(400).json({ message: 'Platform and content are required' });
      }

      const connection = await postPublishService.resolvePlatformConnection(organizationId, platform);

      const mediaFields = await postPublishService.resolveMediaForPost(
        req, organizationId, platform, postType
      );

      const postData = {
        organization: organizationId,
        user: userId,
        platform: platform.toLowerCase(),
        platformConnection: connection._id,
        content: content.trim(),
        postType: postType || 'post',
        generatedBy: generatedBy === 'ai' ? 'ai' : 'human',
        ...(designDna ? { metadata: {
          generationPrompt: designDna.generationPrompt || null,
          layoutType: designDna.layoutType || null,
          colors: designDna.colors || [],
          medium: designDna.medium || null,
          style: designDna.style || null,
          designScore: null
        } } : {}),
        ...mediaFields
      };

      if (req.user.role === 'agent') {
        if (scheduledFor) {
          const lead = assertScheduledForMinLead(scheduledFor);
          if (!lead.ok) {
            return res.status(400).json({ message: lead.message });
          }
          postData.scheduledFor = new Date(scheduledFor);
        }
        postData.status = 'pending_approval';
        const pendingPost = await ScheduledPost.create(postData);
        notifyAdminsOfPendingPost(organizationId, pendingPost, req.user.name || req.user.email || 'An agent');
        return res.status(201).json({
          message: 'Post submitted for approval',
          pendingApproval: true,
          post: pendingPost
        });
      }

      if (scheduledFor) {
        const lead = assertScheduledForMinLead(scheduledFor);
        if (!lead.ok) {
          return res.status(400).json({ message: lead.message });
        }
        postData.scheduledFor = new Date(scheduledFor);
        postData.status = 'scheduled';
        const scheduledPost = await ScheduledPost.create(postData);
        return res.status(201).json({
          message: 'Post scheduled successfully',
          post: scheduledPost
        });
      }

      const post = await ScheduledPost.create(postData);
      try {
        const result = await postPublishService.publishExistingPost(post, connection, req);
        res.status(201).json({
          message: 'Post published successfully',
          post: result.post,
          platformPostUrl: result.platformPostUrl
        });
      } catch (publishError) {
        logger.error('[postController] publishPost platform error', {
          error: publishError.message, platformError: publishError.platformError
        });
        const errorResponse = { message: 'Failed to publish post', error: publishError.message };
        if (publishError.platformError) errorResponse.platformError = publishError.platformError;
        res.status(publishError.statusCode || 500).json(errorResponse);
      }
    } catch (error) {
      if (error instanceof PostPublishError) {
        return res.status(error.statusCode).json({
          success: false,
          code: error.code || undefined,
          message: error.message,
          ...(error.extras || {})
        });
      }
      logger.error('[postController] publishPost error', { error: error.message, stack: error.stack });
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
      logger.error('Upload error', { error: err.message, stack: err.stack });
      return res.status(400).json({ message: err.message });
    }

    try {
      const { platform, content, scheduledFor, postType, mediaLibraryId, mediaUrl, generatedBy } = req.body;
      const userId = req.user._id;
      const organizationId = req.user.organization?._id || req.user.organization;

      if (!platform || !content || !scheduledFor) {
        return res.status(400).json({ message: 'Platform, content, and scheduledFor are required' });
      }

      const scheduleLeadCheck = assertScheduledForMinLead(scheduledFor);
      if (!scheduleLeadCheck.ok) {
        return res.status(400).json({ message: scheduleLeadCheck.message });
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

      const isAgent = req.user.role === 'agent';
      const postData = {
        organization: organizationId,
        user: userId,
        platform: platform.toLowerCase(),
        platformConnection: connection._id,
        content: content.trim(),
        scheduledFor: new Date(scheduledFor),
        // Agents cannot publish directly — store scheduledFor and route to approval
        status: isAgent ? 'pending_approval' : 'scheduled',
        postType: postType || 'post',
        generatedBy: generatedBy === 'ai' ? 'ai' : 'human'
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

        // Use library public URL (S3 or API) for publishers
        postData.mediaStoragePath = libraryMedia.publicUrl || storageService.resolvePublicUrl(libraryMedia.filePath, req);
        postData.mediaType = libraryMedia.mediaType;
        postData.mediaLibraryId = libraryMedia._id; // Track which library media is used

        logger.info(`📚 [Post] Using media from library: ${libraryMedia.originalName} (${libraryMedia._id})`);
      } else if (mediaUrl && typeof mediaUrl === 'string' && /^https?:\/\//i.test(mediaUrl.trim())) {
        postData.mediaStoragePath = mediaUrl.split('?')[0].trim();
        postData.mediaType = /\.mp4(\?|$)/i.test(mediaUrl) ? 'video' : 'image';
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
            logger.error('Error deleting invalid file', { error: err.message, stack: err.stack });
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
          logger.warn('⚠️ Media warnings', { arg1: validation.warnings });
        }

        if (storageService.isS3Configured()) {
          const buf = await fs.readFile(req.file.path);
          const key = storageService.buildPostsKey(organizationId, path.basename(req.file.path));
          const { publicUrl } = await storageService.uploadBuffer(key, buf, req.file.mimetype);
          try {
            await fs.unlink(req.file.path);
          } catch (err) {
            logger.warn('Temp file unlink after S3', { error: err.message });
          }
          postData.mediaStoragePath = publicUrl;
        } else {
          postData.mediaStoragePath = req.file.path;
        }
        postData.mediaType = mediaType;
      }

      const scheduledPost = await ScheduledPost.create(postData);

      if (isAgent) {
        notifyAdminsOfPendingPost(organizationId, scheduledPost, req.user.name || req.user.email || 'An agent');
        return res.status(201).json({
          message: 'Post submitted for approval',
          pendingApproval: true,
          post: scheduledPost
        });
      }

      res.status(201).json({
        message: 'Post scheduled successfully',
        post: scheduledPost
      });
    } catch (error) {
      logger.error('Schedule post error', { error: error.message, stack: error.stack });
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
    logger.error('Get dashboard counts error', { error: error.message, stack: error.stack });
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
    logger.error('Get scheduled posts error', { error: error.message, stack: error.stack });
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
    const { page, limit, skip } = parsePagination(req.query);

    const filter = { organization: organizationId, status: 'pending_approval' };
    // Agents may only view posts they created; admins/managers see all
    if (req.user.role === 'agent') {
      filter.user = req.user._id;
    }

    const [total, posts] = await Promise.all([
      ScheduledPost.countDocuments(filter),
      ScheduledPost.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate('platformConnection', 'platform platformPageId platformUsername')
        .populate('user', 'name email')
        .lean()
    ]);

    res.status(200).json({
      success: true,
      data: posts,
      pagination: paginationMeta(total, page, limit)
    });
  } catch (error) {
    logger.error('Get pending approval posts error', { error: error.message, stack: error.stack });
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
};

/**
 * @desc    Approve a post (and publish immediately or re-schedule).
 * @route   PATCH /api/posts/:id/approve
 * @access  Private
 */
exports.approvePost = async (req, res) => {
  try {
    const { id } = req.params;
    const { scheduledFor: scheduledForBody } = req.body;
    const organizationId = req.user.organization?._id || req.user.organization;

    const post = await ScheduledPost.findOne({
      _id: id,
      organization: organizationId,
      status: 'pending_approval'
    }).populate('platformConnection');

    if (!post) {
      return res.status(404).json({ success: false, message: 'Post not found or not pending approval' });
    }

    post.approvedBy = req.user._id;
    post.approvedAt = new Date();

    const effectiveScheduledFor = scheduledForBody
      ? new Date(scheduledForBody)
      : (post.scheduledFor ? new Date(post.scheduledFor) : null);

    if (effectiveScheduledFor && effectiveScheduledFor > new Date()) {
      const lead = assertScheduledForMinLead(effectiveScheduledFor);
      if (!lead.ok) {
        return res.status(400).json({ success: false, message: lead.message });
      }
      post.scheduledFor = effectiveScheduledFor;
      post.status = 'scheduled';
      await post.save();

      await auditLogController.log(organizationId, 'post', post._id, 'approved', req.user._id,
        { scheduledFor: post.scheduledFor, status: post.status });

      notifyAgentOfDecision(post.user, organizationId, post, 'approved', null);

      return res.status(200).json({ success: true, scheduled: true, data: post });
    }

    const connection = post.platformConnection;
    if (!connection) {
      return res.status(400).json({
        success: false,
        message: 'Platform connection not found for this post. Cannot publish.'
      });
    }

    try {
      const { platformPostUrl } = await postPublishService.publishExistingPost(post, connection, req);

      await auditLogController.log(organizationId, 'post', post._id, 'approved', req.user._id,
        { status: post.status, platformPostUrl });

      notifyAgentOfDecision(post.user, organizationId, post, 'approved', null);

      return res.status(200).json({
        success: true,
        published: true,
        data: post,
        platformPostUrl
      });
    } catch (publishError) {
      logger.error('[postController] approvePost platform error', {
        error: publishError.message, platformError: publishError.platformError
      });
      const errBody = { success: false, message: 'Post approved but publishing failed', error: publishError.message };
      if (publishError.platformError) errBody.platformError = publishError.platformError;
      return res.status(publishError.statusCode || 500).json(errBody);
    }
  } catch (error) {
    logger.error('[postController] approvePost error', { error: error.message, stack: error.stack });
    res.status(500).json({ success: false, error: error.message });
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

    notifyAgentOfDecision(post.user, organizationId, post, 'rejected', post.rejectedReason);

    res.status(200).json({
      success: true,
      data: post
    });
  } catch (error) {
    logger.error('Reject post error', { error: error.message, stack: error.stack });
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
};

/**
 * @desc    Get an agent's full approval history (pending, rejected, and approved posts)
 * @route   GET /api/posts/approval-history
 * @access  Private (agents see their own; admins/managers see all org posts in workflow)
 */
exports.getApprovalHistory = async (req, res) => {
  try {
    const organizationId = req.user.organization?._id || req.user.organization;
    const { page, limit, skip } = parsePagination(req.query);

    let filter;
    if (req.user.role === 'agent') {
      // Show all posts this agent sent through the approval workflow
      filter = {
        organization: organizationId,
        user: req.user._id,
        $or: [
          { status: 'pending_approval' },
          { status: 'rejected' },
          { approvedBy: { $exists: true, $ne: null } }
        ]
      };
    } else {
      // Admin / manager — full history across the org
      filter = {
        organization: organizationId,
        $or: [
          { status: 'pending_approval' },
          { status: 'rejected' },
          { approvedBy: { $exists: true, $ne: null } }
        ]
      };
    }

    const [total, posts] = await Promise.all([
      ScheduledPost.countDocuments(filter),
      ScheduledPost.find(filter)
        .sort({ updatedAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate('platformConnection', 'platform platformPageId platformUsername')
        .populate('user', 'name email')
        .populate('approvedBy', 'name')
        .populate('rejectedBy', 'name')
        .lean()
    ]);

    res.status(200).json({ success: true, data: posts, pagination: paginationMeta(total, page, limit) });
  } catch (error) {
    logger.error('Get approval history error', { error: error.message, stack: error.stack });
    res.status(500).json({ success: false, error: error.message });
  }
};

/**
 * @desc    Admin/manager updates content and/or replaces media on a post pending approval
 * @route   PATCH /api/posts/:id/update-pending
 * @access  Private — admin, manager, super_admin
 */
exports.updatePendingPostByAdmin = (req, res) => {
  upload(req, res, async function (err) {
    if (err) {
      return res.status(400).json({ success: false, message: err.message });
    }

    const cleanupUploaded = async (files) => {
      if (!files || !files.length) return;
      for (const f of files) {
        try {
          await fs.unlink(f.path);
        } catch (_) {}
      }
    };

    try {
      const { id } = req.params;
      const organizationId = req.user.organization?._id || req.user.organization;
      const content = req.body.content;
      const files = req.files || [];

      if (files.length > 1) {
        await cleanupUploaded(files);
        return res.status(400).json({
          success: false,
          message: 'Only one media file can be uploaded when replacing post media'
        });
      }

      const mediaLibraryIdRaw = req.body.mediaLibraryId;
      const hasLibraryMedia = !!(mediaLibraryIdRaw && String(mediaLibraryIdRaw).trim());

      if (files.length === 1 && hasLibraryMedia) {
        await cleanupUploaded(files);
        return res.status(400).json({
          success: false,
          message: 'Send either an uploaded file or a mediaLibraryId, not both'
        });
      }

      const hasContent = typeof content === 'string' && content.trim().length > 0;
      const hasFile = files.length === 1;

      if (!hasContent && !hasFile && !hasLibraryMedia) {
        await cleanupUploaded(files);
        return res.status(400).json({
          success: false,
          message: 'Provide updated content, a new media file, or a media library item'
        });
      }

      const post = await ScheduledPost.findOne({
        _id: id,
        organization: organizationId,
        status: 'pending_approval'
      });

      if (!post) {
        await cleanupUploaded(files);
        return res.status(404).json({
          success: false,
          message: 'Pending post not found'
        });
      }

      if (hasContent) {
        post.content = content.trim();
      }

      if (hasLibraryMedia) {
        const libraryMedia = await Media.findOne({
          _id: mediaLibraryIdRaw,
          organization: organizationId
        });

        if (!libraryMedia) {
          return res.status(404).json({
            success: false,
            message: 'Media not found in library or does not belong to your organization'
          });
        }

        if (libraryMedia.mediaType === 'audio') {
          return res.status(400).json({
            success: false,
            message: 'Select an image or video from the library'
          });
        }

        const fileExtension = path.extname(libraryMedia.originalName || libraryMedia.filename || '');
        const validation = validateMedia(
          post.platform.toLowerCase(),
          libraryMedia.mediaType,
          libraryMedia.size,
          fileExtension,
          post.postType || 'post'
        );

        if (!validation.valid) {
          return res.status(400).json({
            success: false,
            message: 'Media validation failed',
            errors: validation.errors,
            warnings: validation.warnings
          });
        }

        await removeStoredMediaRef(post.mediaStoragePath);
        if (Array.isArray(post.mediaStoragePaths) && post.mediaStoragePaths.length) {
          for (const p of post.mediaStoragePaths) {
            await removeStoredMediaRef(p);
          }
        }

        const newRef = libraryMedia.publicUrl || storageService.resolvePublicUrl(libraryMedia.filePath, req);
        const mt = libraryMedia.mediaType === 'video' ? 'video' : 'image';
        post.mediaStoragePath = newRef;
        post.mediaType = mt;
        post.mediaStoragePaths = [newRef];
        post.mediaTypes = [mt];
        post.mediaUrl = null;
        post.mediaLibraryId = libraryMedia._id;
        post.mediaLibraryIds = [];
      } else if (hasFile) {
        const file = files[0];
        const mediaType = file.mimetype.startsWith('image') ? 'image' : 'video';
        const fileExtension = path.extname(file.originalname);

        const validation = validateMedia(
          post.platform.toLowerCase(),
          mediaType,
          file.size,
          fileExtension,
          post.postType || 'post'
        );

        if (!validation.valid) {
          await cleanupUploaded(files);
          return res.status(400).json({
            success: false,
            message: 'Media validation failed',
            errors: validation.errors,
            warnings: validation.warnings
          });
        }

        await removeStoredMediaRef(post.mediaStoragePath);
        if (Array.isArray(post.mediaStoragePaths) && post.mediaStoragePaths.length) {
          for (const p of post.mediaStoragePaths) {
            await removeStoredMediaRef(p);
          }
        }

        let newRef;
        if (storageService.isS3Configured()) {
          const buf = await fs.readFile(file.path);
          const key = storageService.buildPostsKey(organizationId, path.basename(file.path));
          const { publicUrl } = await storageService.uploadBuffer(key, buf, file.mimetype);
          try {
            await fs.unlink(file.path);
          } catch (e) {
            logger.warn('Temp file unlink after S3', { error: e.message });
          }
          newRef = publicUrl;
        } else {
          newRef = file.path;
        }

        post.mediaStoragePath = newRef;
        post.mediaType = mediaType;
        post.mediaStoragePaths = [newRef];
        post.mediaTypes = [mediaType];
        post.mediaUrl = null;
        post.mediaLibraryId = null;
        post.mediaLibraryIds = [];
      }

      await post.save();
      const lean = await ScheduledPost.findById(post._id)
        .populate('platformConnection', 'platform platformPageId platformUsername')
        .populate('user', 'name email')
        .lean();

      res.status(200).json({ success: true, data: lean });
    } catch (error) {
      logger.error('Update pending post error', { error: error.message, stack: error.stack });
      await cleanupUploaded(req.files || []);
      res.status(500).json({ success: false, error: error.message });
    }
  });
};

/**
 * @desc    Agent edits a rejected post and resubmits for approval
 * @route   PATCH /api/posts/:id/resubmit
 * @access  Private (only the post creator)
 */
exports.resubmitPost = async (req, res) => {
  try {
    const { id } = req.params;
    const { content, mediaLibraryId } = req.body;
    const organizationId = req.user.organization?._id || req.user.organization;

    if (!content || !content.trim()) {
      return res.status(400).json({ success: false, message: 'Content is required' });
    }

    const post = await ScheduledPost.findOne({
      _id: id,
      organization: organizationId,
      user: req.user._id,
      status: 'rejected'
    });

    if (!post) {
      return res.status(404).json({
        success: false,
        message: 'Rejected post not found or you are not the owner'
      });
    }

    // Keep original content for diff; update content and reset approval fields
    if (!post.originalContent) post.originalContent = post.content;
    post.content = content.trim();

    // Optional media replacement from library
    if (mediaLibraryId && String(mediaLibraryId).trim()) {
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

      if (libraryMedia.mediaType === 'audio') {
        return res.status(400).json({
          success: false,
          message: 'Select an image or video from the library'
        });
      }

      await removeStoredMediaRef(post.mediaStoragePath);
      if (Array.isArray(post.mediaStoragePaths) && post.mediaStoragePaths.length) {
        for (const p of post.mediaStoragePaths) {
          await removeStoredMediaRef(p);
        }
      }

      const newRef = libraryMedia.publicUrl || storageService.resolvePublicUrl(libraryMedia.filePath, req);
      const mt = libraryMedia.mediaType === 'video' ? 'video' : 'image';
      post.mediaStoragePath = newRef;
      post.mediaType = mt;
      post.mediaStoragePaths = [newRef];
      post.mediaTypes = [mt];
      post.mediaUrl = null;
      post.mediaLibraryId = libraryMedia._id;
      post.mediaLibraryIds = [];
    }

    post.status = 'pending_approval';
    post.rejectedBy = undefined;
    post.rejectedAt = undefined;
    post.rejectedReason = undefined;
    await post.save();

    notifyAdminsOfPendingPost(organizationId, post, req.user.name || req.user.email || 'An agent');

    res.status(200).json({
      success: true,
      message: 'Post resubmitted for approval',
      pendingApproval: true,
      data: post
    });
  } catch (error) {
    logger.error('Resubmit post error', { error: error.message, stack: error.stack });
    res.status(500).json({ success: false, error: error.message });
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

    if (mediaUrl && typeof mediaUrl === 'string' && /^https?:\/\//i.test(mediaUrl.trim())) {
      postData.mediaStoragePath = mediaUrl.split('?')[0].trim();
      postData.mediaType = /\.mp4(\?|$)/i.test(mediaUrl) ? 'video' : 'image';
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
    logger.error('Send to approval error', { error: error.message, stack: error.stack });
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
    const { page, limit, skip } = parsePagination(req.query);

    const filter = { organization: organizationId, status: 'published' };

    const [total, posts] = await Promise.all([
      ScheduledPost.countDocuments(filter),
      ScheduledPost.find(filter)
        .sort({ publishedAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate('platformConnection', 'platform platformPageId platformUsername')
        .lean()
    ]);

    res.status(200).json({ success: true, data: posts, pagination: paginationMeta(total, page, limit) });
  } catch (error) {
    logger.error('Get published posts error', { error: error.message, stack: error.stack });
    res.status(500).json({ success: false, error: error.message });
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
    const lead = assertScheduledForMinLead(scheduledFor);
    if (!lead.ok) {
      return res.status(400).json({ success: false, message: lead.message });
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
    logger.error('Reschedule post error', { error: error.message, stack: error.stack });
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

    // Delete media files (carousel or single) — local disk or S3
    if (post.mediaStoragePaths && post.mediaStoragePaths.length > 0) {
      for (const mediaPath of post.mediaStoragePaths) {
        await removeStoredMediaRef(mediaPath);
        logger.info(`🗑️  Removed carousel media ref: ${mediaPath}`);
      }
    } else if (post.mediaStoragePath) {
      await removeStoredMediaRef(post.mediaStoragePath);
      logger.info(`🗑️  Removed media ref: ${post.mediaStoragePath}`);
    }

    await ScheduledPost.findByIdAndDelete(post._id);
    res.status(200).json({ message: 'Scheduled post deleted' });
  } catch (error) {
    logger.error('Delete scheduled post error', { error: error.message, stack: error.stack });
    res.status(500).json({ message: error.message });
  }
};

/**
 * @desc    Get all draft posts for the organisation
 * @route   GET /api/posts/drafts
 * @access  Private
 */
exports.getDraftPosts = async (req, res) => {
  try {
    const organizationId = req.user.organization?._id || req.user.organization;
    const { page, limit, skip } = parsePagination(req.query);

    const filter = { organization: organizationId, status: 'draft' };

    const [total, posts] = await Promise.all([
      ScheduledPost.countDocuments(filter),
      ScheduledPost.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate('platformConnection', 'platform platformPageId platformUsername')
        .lean()
    ]);

    res.status(200).json({ success: true, data: posts, pagination: paginationMeta(total, page, limit) });
  } catch (error) {
    logger.error('Get draft posts error', { error: error.message, stack: error.stack });
    res.status(500).json({ success: false, error: error.message });
  }
};

/**
 * @desc    Update draft content / fields
 * @route   PATCH /api/posts/drafts/:id
 * @access  Private
 */
exports.updateDraft = async (req, res) => {
  try {
    const organizationId = req.user.organization?._id || req.user.organization;
    const { id } = req.params;
    const { content } = req.body;

    const draft = await ScheduledPost.findOne({
      _id: id,
      organization: organizationId,
      status: 'draft'
    });

    if (!draft) {
      return res.status(404).json({ success: false, message: 'Draft not found' });
    }

    if (content !== undefined) draft.content = content.trim();
    await draft.save();

    res.status(200).json({ success: true, data: draft });
  } catch (error) {
    logger.error('Update draft error', { error: error.message, stack: error.stack });
    res.status(500).json({ success: false, error: error.message });
  }
};

/**
 * @desc    Move an existing draft to pending_approval (Send to Approval Queue)
 * @route   PATCH /api/posts/drafts/:id/send-to-approval
 * @access  Private
 */
exports.sendDraftToApproval = async (req, res) => {
  try {
    const organizationId = req.user.organization?._id || req.user.organization;
    const { id } = req.params;

    const draft = await ScheduledPost.findOne({
      _id: id,
      organization: organizationId,
      status: 'draft'
    });

    if (!draft) {
      return res.status(404).json({ success: false, message: 'Draft not found' });
    }

    draft.status = 'pending_approval';
    await draft.save();

    res.status(200).json({ success: true, data: draft, message: 'Draft sent for approval.' });
  } catch (error) {
    logger.error('Send draft to approval error', { error: error.message, stack: error.stack });
    res.status(500).json({ success: false, error: error.message });
  }
};

/**
 * @desc    Schedule a draft (move to scheduled status)
 * @route   PATCH /api/posts/drafts/:id/schedule
 * @access  Private
 */
exports.scheduleDraft = async (req, res) => {
  try {
    const organizationId = req.user.organization?._id || req.user.organization;
    const { id } = req.params;
    const { scheduledFor } = req.body;

    if (!scheduledFor) {
      return res.status(400).json({ success: false, message: 'scheduledFor is required' });
    }

    const draftLead = assertScheduledForMinLead(scheduledFor);
    if (!draftLead.ok) {
      return res.status(400).json({ success: false, message: draftLead.message });
    }

    const draft = await ScheduledPost.findOne({
      _id: id,
      organization: organizationId,
      status: 'draft'
    });

    if (!draft) {
      return res.status(404).json({ success: false, message: 'Draft not found' });
    }

    draft.status = 'scheduled';
    draft.scheduledFor = new Date(scheduledFor);
    await draft.save();

    res.status(200).json({ success: true, data: draft });
  } catch (error) {
    logger.error('Schedule draft error', { error: error.message, stack: error.stack });
    res.status(500).json({ success: false, error: error.message });
  }
};

/**
 * @desc    Delete a draft post
 * @route   DELETE /api/posts/drafts/:id
 * @access  Private
 */
exports.deleteDraft = async (req, res) => {
  try {
    const organizationId = req.user.organization?._id || req.user.organization;
    const draft = await ScheduledPost.findOne({
      _id: req.params.id,
      organization: organizationId,
      status: 'draft'
    });

    if (!draft) {
      return res.status(404).json({ success: false, message: 'Draft not found' });
    }

    if (draft.mediaStoragePath) {
      await removeStoredMediaRef(draft.mediaStoragePath);
    }
    if (draft.mediaStoragePaths?.length) {
      for (const p of draft.mediaStoragePaths) {
        await removeStoredMediaRef(p);
      }
    }

    await ScheduledPost.findByIdAndDelete(draft._id);
    res.status(200).json({ success: true, message: 'Draft deleted' });
  } catch (error) {
    logger.error('Delete draft error', { error: error.message, stack: error.stack });
    res.status(500).json({ success: false, error: error.message });
  }
};

/**
 * @desc    Publish an existing draft.
 * @route   POST /api/posts/draft/:id/publish
 * @access  Private
 */
exports.publishDraft = async (req, res) => {
  try {
    const organizationId = req.user.organization?._id || req.user.organization;

    const draft = await ScheduledPost.findOne({
      _id: req.params.id,
      organization: organizationId,
      status: 'draft'
    }).populate('platformConnection');

    if (!draft) {
      return res.status(404).json({ success: false, message: 'Draft not found' });
    }

    const connection = draft.platformConnection;
    if (!connection) {
      return res.status(400).json({ success: false, message: 'Platform connection not found on this draft.' });
    }

    if (String(draft.platform).toLowerCase() === 'youtube') {
      return res.status(501).json({
        success: false,
        code: 'PLATFORM_NOT_IMPLEMENTED',
        message: 'Direct YouTube publishing is coming soon. For now, download your video and upload it via YouTube Studio.',
        platform: 'youtube'
      });
    }

    if (req.user.role === 'agent') {
      draft.status = 'pending_approval';
      await draft.save();
      notifyAdminsOfPendingPost(organizationId, draft, req.user.name || req.user.email || 'An agent');
      return res.status(200).json({
        success: true,
        message: 'Post submitted for approval',
        pendingApproval: true,
        data: draft
      });
    }

    try {
      const { platformPostUrl } = await postPublishService.publishExistingPost(draft, connection, req);
      res.status(200).json({
        success: true,
        message: 'Draft published successfully',
        data: draft,
        platformPostUrl
      });
    } catch (publishError) {
      logger.error('[postController] publishDraft platform error', {
        error: publishError.message, platformError: publishError.platformError
      });
      const errorResponse = {
        success: false, message: 'Failed to publish draft', error: publishError.message
      };
      if (publishError.platformError) errorResponse.platformError = publishError.platformError;
      res.status(publishError.statusCode || 500).json(errorResponse);
    }
  } catch (error) {
    logger.error('[postController] publishDraft error', { error: error.message, stack: error.stack });
    res.status(500).json({ success: false, error: error.message });
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
    logger.error('Get media requirements error', { error: error.message, stack: error.stack });
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
};

/**
 * Helper: Get public URL for media file (must be reachable by Instagram/Facebook)
 */
/**
 * Execute publish for a single scheduled post (delegates to postPublishService).
 * Kept here as a named export for backward compat — worker now imports directly from the service.
 */
exports.executePublishForScheduledPost = postPublishService.executePublishForScheduledPost;
