/**
 * Post Publish Service
 *
 * Encapsulates all platform publishing logic — used by:
 *  - postController.publishPost        (immediate publish via HTTP)
 *  - postController.publishDraft       (publish an existing draft)
 *  - postController.approvePost        (admin approves agent post and publishes)
 *  - processScheduledPublish worker    (scheduled publish via BullMQ)
 *
 * Orchestration primitives:
 *   resolvePlatformConnection(organizationId, platform)         → connection | throws
 *   resolveMediaForPost(req, organizationId, platform, postType) → media descriptor | throws
 *   publishExistingPost(post, connection, req)                  → { post, platformPostUrl }
 *   incrementMediaLibraryUsage(post)                            → void (best-effort)
 *
 * Platform-specific publishers (low-level):
 *   publishToInstagram(connection, post, req)   → { postId, postUrl }
 *   publishToFacebook(connection, post, req)    → { postId, postUrl }
 *   publishToLinkedIn(connection, post)         → { postId, postUrl }
 *
 * Scheduled path:
 *   executePublishForScheduledPost(postId)      → { success, error? }
 *
 * Error contract
 * ──────────────
 * Orchestrators throw `PostPublishError` with `statusCode`, `code`, `extras`.
 * Controllers translate via a single helper (`respondPostPublishError`).
 */

const path = require('path');
const fs = require('fs').promises;
const axios = require('axios');
const sharp = require('sharp');

const ScheduledPost = require('../models/ScheduledPost');
const Media = require('../models/Media');
const PlatformConnection = require('../models/PlatformConnection');
const storageService = require('./storageService');
const instagramService = require('../integrations/meta/instagramService');
const facebookService = require('../integrations/meta/facebookService');
const linkedinService = require('../integrations/linkedin/linkedinService');
const { validateMedia } = require('../config/platformMediaRequirements');
const logger = require('../config/logger');
const complianceService = require('./complianceService');

// ── Error Contract ─────────────────────────────────────────────────────────

class PostPublishError extends Error {
  /**
   * @param {string} message
   * @param {object} [opts]
   * @param {number} [opts.statusCode=500]
   * @param {string} [opts.code]
   * @param {object} [opts.extras]
   */
  constructor(message, { statusCode = 500, code = null, extras = null } = {}) {
    super(message);
    this.name = 'PostPublishError';
    this.statusCode = statusCode;
    this.code = code;
    this.extras = extras;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Read image bytes from a public CDN URL or absolute local file path */
async function readImageBufferForPublish(mediaRef) {
  if (!mediaRef) throw new Error('Missing media');
  if (/^https?:\/\//i.test(String(mediaRef))) {
    const r = await axios.get(String(mediaRef), {
      responseType: 'arraybuffer',
      timeout: 120000,
      maxContentLength: Infinity,
      maxBodyLength: Infinity
    });
    return Buffer.from(r.data);
  }
  return fs.readFile(mediaRef);
}

function contentTypeFromMediaRef(mediaRef) {
  const ext = path.extname(String(mediaRef).split('?')[0]).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.gif') return 'image/gif';
  if (ext === '.webp') return 'image/webp';
  return 'image/jpeg';
}

/**
 * Build a publicly accessible URL for a stored media path.
 * Delegates to storageService so S3/local disk variants are handled in one place.
 */
function getPublicMediaUrl(filePath, req) {
  return storageService.resolvePublicUrl(filePath, req);
}

/**
 * Verify that a media URL pointing to our own /api/posts/media/ route actually
 * has the backing file on disk. Returns a user-friendly error string when the
 * file cannot be located, or null when everything looks fine.
 *
 * Called before handing the URL to third-party platform APIs (Instagram, etc.)
 * so the user gets a clear "image not found" message rather than a cryptic
 * "Only photo or video can be accepted as media type" from Meta.
 */
async function verifyLocalMediaExists(mediaUrl) {
  if (!mediaUrl) return null;
  const urlStr = String(mediaUrl);
  // Only check URLs that route through our own media endpoint
  const match = urlStr.match(/\/api\/posts\/media\/([^?#]+)/);
  if (!match) return null;

  const filename = path.basename(match[1]);
  const uploadDir = path.join(__dirname, '../../uploads/posts');
  const fullPath = path.join(uploadDir, filename);
  try {
    await fs.access(fullPath);
    return null; // file exists — all good
  } catch {
    return (
      `The image file "${filename}" could not be found on the server. ` +
      'It may have been lost after a server restart. ' +
      'Please regenerate the image in Content Studio and publish again.'
    );
  }
}

/**
 * Convert a local PNG file to JPEG for Instagram compatibility.
 *
 * AI-generated PNGs can contain alpha channels, unusual ICC color profiles,
 * or high bit-depth data that causes Instagram's CDN to reject them with
 * error 9004 / subcode 2207052 ("Only photo or video can be accepted").
 * Converting to a flat JPEG eliminates all of these issues.
 *
 * If the media URL is not a local /api/posts/media/*.png URL, or if
 * conversion fails for any reason, the original URL is returned unchanged.
 *
 * @param {string} mediaUrl  - Public URL of the image (may end in .png)
 * @param {object} req       - Express request (for building the new public URL)
 * @returns {Promise<string>} JPEG public URL, or original URL on non-PNG / error
 */
async function convertPngToJpegForInstagram(mediaUrl, req) {
  if (!mediaUrl) return mediaUrl;
  const urlStr = String(mediaUrl);

  // Only process local media files served through our own /api/posts/media/ route
  const match = urlStr.match(/\/api\/posts\/media\/([^?#]+\.png)$/i);
  if (!match) return mediaUrl; // not a local PNG — skip

  const pngFilename = path.basename(match[1]);
  const uploadDir = path.join(__dirname, '../../uploads/posts');
  const pngPath = path.join(uploadDir, pngFilename);

  try {
    await fs.access(pngPath);
  } catch {
    return mediaUrl; // file not on disk — let the existing check handle it
  }

  const jpegFilename = pngFilename.replace(/\.png$/i, '-ig.jpg');
  const jpegPath = path.join(uploadDir, jpegFilename);

  try {
    await sharp(pngPath)
      .flatten({ background: { r: 255, g: 255, b: 255 } }) // remove alpha — white bg
      .jpeg({ quality: 92, mozjpeg: true })
      .toFile(jpegPath);

    const jpegUrl = storageService.resolvePublicUrl(jpegPath, req);
    logger.info('[Instagram] PNG → JPEG conversion', { pngFilename, jpegFilename, jpegUrl });
    return jpegUrl;
  } catch (err) {
    logger.warn('[Instagram] PNG → JPEG conversion failed, using original PNG', { err: err.message });
    return mediaUrl; // fall back gracefully
  }
}

// ── Platform Publishers ───────────────────────────────────────────────────────

/**
 * Publish a post to Instagram.
 * Supports carousel, story, reel, and regular post types.
 */
async function publishToInstagram(connection, post, req) {
  const { content, mediaStoragePath, mediaStoragePaths, mediaType, mediaTypes, postType } = post;
  const isCarousel = mediaStoragePaths && mediaStoragePaths.length > 1;

  if (!mediaStoragePath && !isCarousel) {
    throw new Error('Instagram posts require an image or video');
  }

  if (isCarousel) {
    let mediaUrls = mediaStoragePaths.map((storagePath, index) => ({
      url: getPublicMediaUrl(storagePath, req),
      type: mediaTypes[index]
    }));
    // Pre-check each carousel item and convert PNG → JPEG for image items
    for (let i = 0; i < mediaUrls.length; i++) {
      const missingErr = await verifyLocalMediaExists(mediaUrls[i].url);
      if (missingErr) throw new Error(missingErr);
      if (mediaUrls[i].type === 'image') {
        mediaUrls[i] = {
          ...mediaUrls[i],
          url: await convertPngToJpegForInstagram(mediaUrls[i].url, req)
        };
      }
    }
    const result = await instagramService.createCarouselPost(connection, {
      caption: content,
      mediaUrls
    });
    return { postId: result.postId, postUrl: result.postUrl };
  }

  let mediaUrl = getPublicMediaUrl(mediaStoragePath, req);

  // Pre-check: ensure the file is present before handing the URL to Meta.
  // If the file is missing Instagram returns "Only photo or video can be
  // accepted as media type." — a misleading error that makes the issue hard
  // to debug.  Fail early with a clear message instead.
  const missingErr = await verifyLocalMediaExists(mediaUrl);
  if (missingErr) throw new Error(missingErr);

  // AI-generated images arrive as PNG. Instagram's CDN can reject PNGs that
  // have alpha channels, unusual ICC profiles, or high bit-depth. Convert to
  // JPEG (white background, 92% quality) before publishing. This is a no-op
  // for anything that is not a local .png served through /api/posts/media/.
  if (mediaType === 'image') {
    mediaUrl = await convertPngToJpegForInstagram(mediaUrl, req);
  }

  switch (postType) {
    case 'story': {
      const result = await instagramService.createStory(connection, { mediaUrl, mediaType });
      return { postId: result.postId, postUrl: result.postUrl };
    }
    case 'reel': {
      if (mediaType !== 'video') throw new Error('Instagram Reels require a video file');
      const result = await instagramService.createReel(connection, { caption: content, mediaUrl });
      return { postId: result.postId, postUrl: result.postUrl };
    }
    case 'post':
    default: {
      const result = await instagramService.createPost(connection, { caption: content, mediaUrl, mediaType });
      return { postId: result.postId, postUrl: result.postUrl };
    }
  }
}

/**
 * Publish a post to a Facebook Page.
 * Supports story, reel/short, and regular post types (image, video, text-only).
 */
async function publishToFacebook(connection, post, req) {
  const { content, mediaStoragePath, mediaType, postType } = post;

  switch (postType) {
    case 'story': {
      if (!mediaStoragePath) throw new Error('Facebook stories require an image or video');
      if (mediaType === 'image') {
        const imageBuffer = await readImageBufferForPublish(mediaStoragePath);
        const result = await facebookService.createStory(connection, { imageBuffer });
        return { postId: result.postId, postUrl: result.postUrl };
      }
      if (mediaType === 'video') {
        const videoUrl = getPublicMediaUrl(mediaStoragePath, req);
        const result = await facebookService.createStory(connection, { videoUrl });
        return { postId: result.postId, postUrl: result.postUrl };
      }
      throw new Error('Invalid media type for story');
    }

    case 'reel':
    case 'short': {
      if (!mediaStoragePath || mediaType !== 'video') throw new Error('Facebook Reels require a video file');
      const reelVideoUrl = getPublicMediaUrl(mediaStoragePath, req);
      const result = await facebookService.createReel(connection, {
        videoUrl: reelVideoUrl,
        description: content,
        title: content ? content.substring(0, 50) : 'Reel'
      });
      return { postId: result.postId, postUrl: result.postUrl };
    }

    case 'post':
    default: {
      if (mediaStoragePath && mediaType === 'image') {
        try {
          const imageBuffer = await readImageBufferForPublish(mediaStoragePath);
          const result = await facebookService.createPost(connection, {
            message: content || ' ',
            imageBuffer
          });
          return { postId: result.postId, postUrl: result.postUrl };
        } catch (imageError) {
          // Fallback: text-only to feed when image upload fails
          const result = await facebookService.createPost(connection, {
            message: content || 'Posted from RepMeUp'
          });
          return { postId: result.postId, postUrl: result.postUrl };
        }
      }
      if (mediaStoragePath && mediaType === 'video') {
        const videoUrl = getPublicMediaUrl(mediaStoragePath, req);
        const result = await facebookService.createVideoPost(connection, {
          videoUrl,
          description: content
        });
        return { postId: result.postId, postUrl: result.postUrl };
      }
      // Text-only post
      const result = await facebookService.createPost(connection, {
        message: content || 'Posted from RepMeUp'
      });
      return { postId: result.postId, postUrl: result.postUrl };
    }
  }
}

/**
 * Publish a post to LinkedIn (Company Page or personal profile).
 * Video publishing is not yet supported.
 */
async function publishToLinkedIn(connection, post) {
  const { content, mediaStoragePath, mediaStoragePaths, mediaType, mediaTypes } = post;

  let storagePath = mediaStoragePath;
  let resolvedType = mediaType;
  if (!storagePath && mediaStoragePaths?.length > 0) {
    storagePath = mediaStoragePaths[0];
    resolvedType = (mediaTypes && mediaTypes[0]) || 'image';
  }

  let media = null;
  if (storagePath) {
    if (resolvedType === 'video') {
      throw new Error('LinkedIn publishing with video is not supported yet. Use an image or text-only post.');
    }
    if (resolvedType === 'image') {
      const imageBuffer = await readImageBufferForPublish(storagePath);
      media = { imageBuffer, contentType: contentTypeFromMediaRef(storagePath) };
    }
  }

  const result = await linkedinService.createPost(connection, content || '', media);
  return { postId: result.postId, postUrl: result.postUrl };
}

/**
 * Recompute compliance for a post's current content and persist the result
 * (riskScore + complianceFlags) on the in-memory document. This is the last
 * check before content actually reaches a platform, so it always uses fresh
 * content — never a client-supplied or stale riskScore/complianceFlags value
 * from an earlier step (draft save, approval submission, admin edit).
 *
 * @throws {PostPublishError} 422 COMPLIANCE_BLOCKED on a hard violation (e.g. banned word)
 */
async function enforceComplianceOrThrow(post) {
  const { riskScore, complianceFlags, hardViolation } = await complianceService.checkContent(
    post.organization,
    post.content
  );
  post.riskScore = riskScore;
  post.complianceFlags = complianceFlags;
  if (hardViolation) {
    // Persist the flags even though we're blocking, so the approval queue /
    // post detail view shows the reviewer exactly why it didn't go out.
    await post.save();
    throw new PostPublishError(
      `Cannot publish: ${complianceFlags.join('; ')}. Edit the post to remove banned words first.`,
      { statusCode: 422, code: 'COMPLIANCE_BLOCKED', extras: { complianceFlags, riskScore } }
    );
  }
}

// ── Scheduled Publish ─────────────────────────────────────────────────────────

/**
 * Execute publish for a single scheduled post.
 * Called by the processScheduledPublish BullMQ worker.
 *
 * @param {string} postId
 * @returns {Promise<{ success: boolean, error?: string }>}
 */
async function executePublishForScheduledPost(postId) {
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

  // Build a minimal req-like object so getPublicMediaUrl can construct absolute URLs
  const req = {
    protocol: 'https',
    get: (name) =>
      name === 'host'
        ? (process.env.API_URL || process.env.BASE_URL || 'localhost:3000').replace(/^https?:\/\//, '')
        : null
  };

  try {
    await enforceComplianceOrThrow(post);
  } catch (err) {
    post.status = 'failed';
    post.error = err.message;
    await post.save();
    return { success: false, error: err.message };
  }

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
      post.error = `Unsupported platform: ${post.platform}`;
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
}

// ── Orchestration Primitives (shared by controller entrypoints) ─────────────

/**
 * Resolve the active platform connection for an organization.
 * Handles Facebook's special case (page-level connection with `platformPageId`)
 * and the YouTube "not yet implemented" guard.
 *
 * @param {string} organizationId
 * @param {string} platform
 * @returns {Promise<object>} PlatformConnection document
 * @throws {PostPublishError} 404 when no active connection exists, 501 for YouTube
 */
async function resolvePlatformConnection(organizationId, platform) {
  const lowered = String(platform || '').toLowerCase();

  if (lowered === 'youtube') {
    throw new PostPublishError(
      'Direct YouTube publishing is coming soon. For now, download your video and upload it via YouTube Studio.',
      { statusCode: 501, code: 'PLATFORM_NOT_IMPLEMENTED', extras: { platform: 'youtube' } }
    );
  }

  const query = {
    organization: organizationId,
    platform: lowered,
    isActive: true
  };
  if (lowered === 'facebook') {
    // Page-level connection is required (not the user-level OAuth record)
    query.platformPageId = { $exists: true, $ne: null };
    query.usesAccountSlot = true;
  }

  const connection = await PlatformConnection.findOne(query);
  if (!connection) {
    if (lowered === 'facebook') {
      throw new PostPublishError(
        'No Facebook page connection found. Please connect a Facebook page from Settings.',
        { statusCode: 404, code: 'PLATFORM_NOT_CONNECTED', extras: { platform: 'facebook' } }
      );
    }
    throw new PostPublishError(`No active ${platform} connection found`, {
      statusCode: 404,
      code: 'PLATFORM_NOT_CONNECTED',
      extras: { platform: lowered }
    });
  }
  return connection;
}

/**
 * Resolve a Content Studio "carousel" request (2–10 existing Media library
 * items) into ScheduledPost media fields. Deliberately separate from
 * `resolveMediaForPost` below (which already has its own, older
 * `mediaLibraryIds` branch used by the `/publish` multipart flow) — kept
 * standalone rather than refactored into a single shared code path so this
 * new, additive `saveDraft` / `schedulePost` / `sendToApproval` carousel
 * support carries zero regression risk to the already-live single-image
 * behavior in those three handlers.
 *
 * Carousel publishing is Instagram-only today (see plan discussion) —
 * Facebook's Graph API needs a separate unpublished-photos + attached_media
 * flow, and LinkedIn's Posts API only accepts one image via this content
 * shape. Rather than silently truncating to one image on those platforms
 * (confusing — the user picked N images, got 1 posted), we reject up front
 * with an actionable message.
 *
 * @param {string[]|string} mediaLibraryIdsRaw  Array of Media _id strings (or JSON-encoded array)
 * @param {string} organizationId
 * @param {string} platform
 * @returns {Promise<object>} { mediaStoragePaths, mediaTypes, mediaLibraryIds, mediaStoragePath, mediaType }
 * @throws {PostPublishError} 400 for bad platform/count, 404 for missing/cross-org media
 */
async function resolveCarouselFromLibraryIds(mediaLibraryIdsRaw, organizationId, platform, req) {
  const libraryIds = Array.isArray(mediaLibraryIdsRaw)
    ? mediaLibraryIdsRaw
    : JSON.parse(mediaLibraryIdsRaw);

  const lowered = String(platform || '').toLowerCase();
  if (lowered !== 'instagram') {
    throw new PostPublishError(
      'Carousel posts (multiple images) are currently supported for Instagram only. Choose a single image, or select only Instagram as the platform.',
      { statusCode: 400, code: 'CAROUSEL_UNSUPPORTED_PLATFORM', extras: { platform: lowered } }
    );
  }
  if (libraryIds.length < 2 || libraryIds.length > 10) {
    throw new PostPublishError(
      'A carousel needs between 2 and 10 images.',
      { statusCode: 400, code: 'CAROUSEL_INVALID_COUNT' }
    );
  }

  const items = await Media.find({ _id: { $in: libraryIds }, organization: organizationId });
  if (items.length !== libraryIds.length) {
    throw new PostPublishError(
      'Some carousel images were not found in your library or do not belong to your organization',
      { statusCode: 404, code: 'MEDIA_NOT_FOUND' }
    );
  }
  if (items.some((m) => m.mediaType !== 'image')) {
    throw new PostPublishError('Carousel items must all be images.', {
      statusCode: 400,
      code: 'CAROUSEL_INVALID_MEDIA_TYPE'
    });
  }

  // Preserve the order the caller sent (Media.find does not guarantee input order)
  const byId = new Map(items.map((m) => [String(m._id), m]));
  const ordered = libraryIds.map((id) => byId.get(String(id)));

  const paths = ordered.map((m) => m.publicUrl || storageService.resolvePublicUrl(m.filePath, req));
  const types = ordered.map((m) => m.mediaType);

  logger.info('[Post] Content Studio carousel resolved', { count: ordered.length, platform: lowered });

  return {
    mediaStoragePaths: paths,
    mediaTypes: types,
    mediaLibraryIds: ordered.map((m) => m._id),
    mediaStoragePath: paths[0],
    mediaType: types[0]
  };
}

/**
 * Resolve media for a publish/schedule request from multer-parsed input.
 * Handles the five sources, in priority order:
 *   1. mediaLibraryIds[]  — carousel of library items
 *   2. mediaLibraryId     — single library item
 *   3. req.files[]        — carousel of uploaded files
 *   4. req.file           — single uploaded file
 *   5. body.mediaUrl      — absolute URL (AI-generated or external)
 *
 * For uploaded files, runs platform-specific validation, uploads to S3 (or
 * leaves on local disk), and cleans up temp files on validation failure.
 *
 * @returns {Promise<object>} partial postData: { mediaStoragePath?,
 *   mediaType?, mediaStoragePaths?, mediaTypes?, mediaLibraryId?,
 *   mediaLibraryIds? }
 * @throws {PostPublishError} 400 for validation failure, 404 for library miss
 */
async function resolveMediaForPost(req, organizationId, platform, postType) {
  const body = req.body || {};
  const mediaLibraryId = body.mediaLibraryId;
  const mediaLibraryIdsRaw = body.mediaLibraryIds;
  const mediaUrl = body.mediaUrl;
  const lowered = String(platform || '').toLowerCase();

  if (mediaLibraryIdsRaw && mediaLibraryIdsRaw.length > 0) {
    const libraryIds = Array.isArray(mediaLibraryIdsRaw)
      ? mediaLibraryIdsRaw
      : JSON.parse(mediaLibraryIdsRaw);
    const items = await Media.find({ _id: { $in: libraryIds }, organization: organizationId });
    if (items.length !== libraryIds.length) {
      throw new PostPublishError(
        'Some media items not found in library or do not belong to your organization',
        { statusCode: 404, code: 'MEDIA_NOT_FOUND' }
      );
    }
    const paths = items.map((m) => m.publicUrl || storageService.resolvePublicUrl(m.filePath, req));
    const types = items.map((m) => m.mediaType);
    logger.info('[Post] Using library carousel', { count: items.length });
    return {
      mediaStoragePaths: paths,
      mediaTypes: types,
      mediaLibraryIds: items.map((m) => m._id),
      mediaStoragePath: paths[0],
      mediaType: types[0]
    };
  }

  if (mediaLibraryId) {
    const item = await Media.findOne({ _id: mediaLibraryId, organization: organizationId });
    if (!item) {
      throw new PostPublishError(
        'Media not found in library or does not belong to your organization',
        { statusCode: 404, code: 'MEDIA_NOT_FOUND' }
      );
    }
    logger.info('[Post] Using library media', { name: item.originalName, id: String(item._id) });
    return {
      mediaStoragePath: item.publicUrl || storageService.resolvePublicUrl(item.filePath, req),
      mediaType: item.mediaType,
      mediaLibraryId: item._id
    };
  }

  if (req.files && req.files.length > 0) {
    // Validate every file up-front — if any fails, delete all and abort.
    for (const file of req.files) {
      const mediaType = file.mimetype.startsWith('image') ? 'image' : 'video';
      const ext = path.extname(file.originalname);
      const validation = validateMedia(lowered, mediaType, file.size, ext, postType);
      if (!validation.valid) {
        await _bestEffortCleanupFiles(req.files);
        throw new PostPublishError(`Media validation failed for ${file.originalname}`, {
          statusCode: 400,
          code: 'MEDIA_VALIDATION_FAILED',
          extras: { errors: validation.errors, warnings: validation.warnings }
        });
      }
      if (validation.warnings.length > 0) {
        logger.warn('[Upload] Media warnings', { file: file.originalname, warnings: validation.warnings });
      }
    }

    const mediaStoragePaths = [];
    const mediaTypes = [];
    for (const file of req.files) {
      const mediaType = file.mimetype.startsWith('image') ? 'image' : 'video';
      if (storageService.isS3Configured()) {
        const buf = await fs.readFile(file.path);
        const key = storageService.buildPostsKey(organizationId, path.basename(file.path));
        const { publicUrl } = await storageService.uploadBuffer(key, buf, file.mimetype);
        await _bestEffortUnlink(file.path);
        mediaStoragePaths.push(publicUrl);
      } else {
        mediaStoragePaths.push(file.path);
      }
      mediaTypes.push(mediaType);
    }

    logger.info('[Upload] Carousel media uploaded', { count: mediaStoragePaths.length });
    return {
      mediaStoragePaths,
      mediaTypes,
      mediaStoragePath: mediaStoragePaths[0],
      mediaType: mediaTypes[0]
    };
  }

  if (req.file) {
    const mediaType = req.file.mimetype.startsWith('image') ? 'image' : 'video';
    const ext = path.extname(req.file.originalname);
    const validation = validateMedia(lowered, mediaType, req.file.size, ext, postType);
    if (!validation.valid) {
      await _bestEffortUnlink(req.file.path);
      throw new PostPublishError('Media validation failed', {
        statusCode: 400,
        code: 'MEDIA_VALIDATION_FAILED',
        extras: { errors: validation.errors, warnings: validation.warnings }
      });
    }
    if (validation.warnings.length > 0) {
      logger.warn('[Upload] Media warnings', { warnings: validation.warnings });
    }

    if (storageService.isS3Configured()) {
      const buf = await fs.readFile(req.file.path);
      const key = storageService.buildPostsKey(organizationId, path.basename(req.file.path));
      const { publicUrl } = await storageService.uploadBuffer(key, buf, req.file.mimetype);
      await _bestEffortUnlink(req.file.path);
      return { mediaStoragePath: publicUrl, mediaType };
    }
    return { mediaStoragePath: req.file.path, mediaType };
  }

  if (typeof mediaUrl === 'string' && /^https?:\/\//i.test(mediaUrl.trim())) {
    // External / CDN URL
    return {
      mediaStoragePath: mediaUrl.split('?')[0].trim(),
      mediaType: /\.mp4(\?|$)/i.test(mediaUrl) ? 'video' : 'image'
    };
  }

  if (typeof mediaUrl === 'string' && mediaUrl.includes('/api/posts/media/')) {
    // AI-generated local file referenced by URL — resolve to disk path if it exists
    const filename = mediaUrl.split('/api/posts/media/').pop()?.split('?')[0]?.trim();
    if (filename) {
      const uploadDir = path.join(__dirname, '../../uploads/posts');
      const fullPath = path.join(uploadDir, filename);
      try {
        await fs.access(fullPath);
        return { mediaStoragePath: fullPath, mediaType: 'image' };
      } catch {
        logger.warn('[Publish] AI-generated media file not found, publishing without image', {
          expected: fullPath
        });
      }
    }
  }

  // No media — caller decides if this is acceptable for the platform/postType
  return {};
}

/** Best-effort filesystem cleanup — never throws. */
async function _bestEffortUnlink(filePath) {
  try {
    await fs.unlink(filePath);
  } catch (err) {
    logger.warn('[Upload] Temp file unlink failed', { path: filePath, error: err.message });
  }
}

async function _bestEffortCleanupFiles(files) {
  for (const f of files || []) {
    await _bestEffortUnlink(f.path);
  }
}

/**
 * Publish an already-persisted ScheduledPost to its target platform.
 *
 * Used by `publishPost` (immediate), `publishDraft`, `approvePost` (admin
 * immediate publish), and `executePublishForScheduledPost` (worker).
 *
 * Transitions: {*} → 'publishing' → ('published' | 'failed').
 * On failure: updates post.status='failed', post.error=message, then rethrows
 * the original error (preserving `error.platformError` if set by the platform
 * integration) so the caller can decide how to respond.
 *
 * @param {object} post        ScheduledPost document (must have platform, platformConnection)
 * @param {object} connection  PlatformConnection document
 * @param {object} [req]       Express req used to build absolute media URLs
 * @returns {Promise<{ post: object, platformPostUrl: string }>}
 * @throws {Error} original platform error on publish failure
 * @throws {PostPublishError} 422 for unsupported platform
 */
async function publishExistingPost(post, connection, req) {
  // Recompute compliance against current content right before it goes live —
  // never trust a riskScore/complianceFlags value set earlier (draft save,
  // approval submission, or a client-supplied value). Throws 422 on a hard
  // violation (banned word) so the post stays in its current status instead
  // of being marked 'publishing'.
  await enforceComplianceOrThrow(post);

  post.status = 'publishing';
  await post.save();

  try {
    const platform = String(post.platform || '').toLowerCase();
    let result;
    switch (platform) {
      case 'instagram':
        result = await publishToInstagram(connection, post, req);
        break;
      case 'facebook':
        result = await publishToFacebook(connection, post, req);
        break;
      case 'linkedin':
        result = await publishToLinkedIn(connection, post);
        break;
      case 'youtube':
        throw new PostPublishError(
          'Direct YouTube publishing is coming soon. For now, download your video and upload it via YouTube Studio.',
          { statusCode: 501, code: 'PLATFORM_NOT_IMPLEMENTED' }
        );
      default:
        throw new PostPublishError(`Publishing to ${post.platform} is not yet supported`, {
          statusCode: 422,
          code: 'PLATFORM_UNSUPPORTED'
        });
    }

    post.status = 'published';
    post.publishedAt = new Date();
    post.platformPostId = result.postId;
    post.platformPostUrl = result.postUrl;
    post.error = undefined;
    await post.save();

    // Best-effort library usage tracking — non-fatal.
    incrementMediaLibraryUsage(post).catch((err) => {
      logger.error('[Post] Media library usage tracking failed', {
        postId: String(post._id),
        error: err.message
      });
    });

    return { post, platformPostUrl: result.postUrl };
  } catch (err) {
    post.status = 'failed';
    post.error = err.message;
    await post.save();
    throw err;
  }
}

/**
 * Increment usage counters on any library media referenced by this post.
 * Never throws — failures are logged and swallowed.
 */
async function incrementMediaLibraryUsage(post) {
  if (post.mediaLibraryId) {
    try {
      const media = await Media.findById(post.mediaLibraryId);
      if (media) {
        await media.incrementUsage();
        logger.info('[Media Library] Usage incremented', { name: media.originalName });
      }
    } catch (err) {
      logger.error('[Media Library] Error incrementing usage', { error: err.message });
    }
  }
  if (post.mediaLibraryIds && post.mediaLibraryIds.length > 0) {
    try {
      for (const mediaId of post.mediaLibraryIds) {
        const media = await Media.findById(mediaId);
        if (media) await media.incrementUsage();
      }
      logger.info('[Media Library] Usage incremented for carousel', {
        count: post.mediaLibraryIds.length
      });
    } catch (err) {
      logger.error('[Media Library] Error incrementing carousel usage', { error: err.message });
    }
  }
}

module.exports = {
  // Error contract
  PostPublishError,

  // Low-level publishers (still exported for tests and callers that need direct access)
  getPublicMediaUrl,
  publishToInstagram,
  publishToFacebook,
  publishToLinkedIn,

  // Orchestration primitives (new — used by controller handlers)
  resolvePlatformConnection,
  resolveMediaForPost,
  resolveCarouselFromLibraryIds,
  publishExistingPost,
  incrementMediaLibraryUsage,

  // Scheduled path (BullMQ worker)
  executePublishForScheduledPost
};
