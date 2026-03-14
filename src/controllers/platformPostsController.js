const mongoose = require('mongoose');
const PlatformConnection = require('../models/PlatformConnection');
const PlatformPost = require('../models/PlatformPost');
const Interaction = require('../models/Interaction');
const facebookService = require('../integrations/meta/facebookService');
const instagramService = require('../integrations/meta/instagramService');

/**
 * Normalize a Facebook feed post to unified shape (for DB storage).
 */
function normalizeFacebookPost(post, connection) {
  const hasPicture = !!post.full_picture;
  const attachmentType = post.attachments?.data?.[0]?.type || post.attachments?.data?.[0]?.media_type;
  const isVideo = attachmentType === 'video' || attachmentType === 'video_inline';
  const contentType = isVideo ? 'video' : 'post';
  return {
    platform: 'facebook',
    externalId: post.id,
    connectionId: connection._id.toString(),
    connectionName: connection.platformUsername || connection.platformDisplayName || connection.platformPageId || 'Facebook Page',
    text: post.message || '',
    postedAt: new Date(post.created_time),
    permalink: post.permalink_url || null,
    mediaUrl: post.full_picture || null,
    mediaType: hasPicture ? 'image' : null,
    contentType
  };
}

/**
 * Normalize an Instagram media item to unified shape (for DB storage).
 */
function normalizeInstagramMedia(media, connection) {
  let contentType = 'post';
  if (media.media_type === 'VIDEO') contentType = 'reel';
  else if (media.media_type === 'CAROUSEL_ALBUM') contentType = 'carousel';
  return {
    platform: 'instagram',
    externalId: media.id,
    connectionId: connection._id.toString(),
    connectionName: connection.platformUsername || connection.platformDisplayName || 'Instagram',
    text: media.caption || '',
    postedAt: new Date(media.timestamp),
    permalink: media.permalink || null,
    mediaUrl: media.media_url || null,
    mediaType: media.media_type === 'VIDEO' ? 'video' : media.media_type === 'CAROUSEL_ALBUM' ? 'carousel' : 'image',
    contentType
  };
}

/**
 * @desc    Get stored platform posts from database
 * @route   GET /api/platform-posts
 * @query   platform - required for data: 'facebook' | 'instagram' (returns [] when 'all' or missing)
 * @access  Private
 */
exports.getPlatformPosts = async (req, res, next) => {
  try {
    const organizationId = req.user.organization?._id || req.user.organization;
    const platformFilter = (req.query.platform || '').toLowerCase();

    if (!platformFilter || platformFilter === 'all') {
      return res.status(200).json({
        success: true,
        posts: [],
        meta: { total: 0, platformFilter: platformFilter || 'all' }
      });
    }

    if (!['facebook', 'instagram'].includes(platformFilter)) {
      return res.status(200).json({
        success: true,
        posts: [],
        meta: { total: 0, platformFilter }
      });
    }

    const posts = await PlatformPost.find({
      organization: organizationId,
      platform: platformFilter
    })
      .sort({ postedAt: -1 })
      .lean();

    const externalIds = posts.map(p => p.externalId);
    const commentCounts = externalIds.length > 0 ? await Interaction.aggregate([
      {
        $match: {
          organization: new mongoose.Types.ObjectId(organizationId),
          platform: platformFilter,
          type: 'comment',
          'metadata.postId': { $in: externalIds }
        }
      },
      { $group: { _id: '$metadata.postId', count: { $sum: 1 } } }
    ]) : [];
    const countByPostId = Object.fromEntries(commentCounts.map(c => [c._id, c.count]));

    const [lastSyncResult] = await PlatformPost.aggregate([
      { $match: { organization: new mongoose.Types.ObjectId(organizationId), platform: platformFilter } },
      { $group: { _id: null, lastSyncedAt: { $max: '$syncedAt' } } }
    ]);
    const lastSyncedAt = lastSyncResult?.lastSyncedAt || null;

    const formatted = posts.map(p => ({
      platform: p.platform,
      externalId: p.externalId,
      connectionId: p.platformConnection?.toString() || p.platformConnection,
      connectionName: p.connectionName,
      text: p.text,
      createdAt: p.postedAt ?? p.createdAt,
      permalink: p.permalink,
      mediaUrl: p.mediaUrl,
      mediaType: p.mediaType,
      contentType: p.contentType,
      commentCount: countByPostId[p.externalId] || 0
    }));

    res.status(200).json({
      success: true,
      posts: formatted,
      meta: { total: formatted.length, platformFilter, lastSyncedAt }
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Sync posts from Meta for the selected platform and store in DB
 * @route   POST /api/platform-posts/sync
 * @query   platform - required: 'facebook' | 'instagram'
 * @access  Private
 */
exports.syncPlatformPosts = async (req, res, next) => {
  try {
    const organizationId = req.user.organization?._id || req.user.organization;
    const platform = (req.query.platform || req.body?.platform || '').toLowerCase();

    if (!['facebook', 'instagram'].includes(platform)) {
      return res.status(400).json({
        success: false,
        error: 'Platform is required and must be facebook or instagram'
      });
    }

    const connections = await PlatformConnection.find({
      organization: organizationId,
      isActive: true,
      status: 'connected',
      platform
    })
      .select('_id platform platformUsername platformDisplayName platformPageId platformUserId platformData')
      .lean();

    if (connections.length === 0) {
      return res.status(400).json({
        success: false,
        error: `No connected ${platform} account found. Connect a ${platform === 'instagram' ? 'Instagram' : 'Facebook Page'} in Settings first.`
      });
    }

    const normalized = [];
    for (const conn of connections) {
      const connection = { ...conn, accessToken: null };
      const tokenDoc = await PlatformConnection.findById(conn._id).select('accessToken').lean();
      if (tokenDoc) connection.accessToken = tokenDoc.accessToken;

      try {
        if (platform === 'facebook') {
          if (!connection.platformPageId) continue;
          let rawPosts;
          // Helper: try fetching posts with a given token, returning null on #10 permission errors
          const tryFetch = async (token) => {
            try {
              return await facebookService.getPagePosts({ ...connection, accessToken: token });
            } catch (e) {
              if (e.code === 'FACEBOOK_PERMISSION_MISSING' || e.fbCode === 10) return null;
              throw e;
            }
          };

          const pageIdStr = String(connection.platformPageId || '');

          // Attempt 1: Facebook Page connection token
          rawPosts = await tryFetch(connection.accessToken);

          // Attempt 2: Instagram connection token for the same Facebook Page
          if (rawPosts === null) {
            const pageIdNum = Number(pageIdStr);
            const pageIds = [pageIdStr].concat(isNaN(pageIdNum) ? [] : [pageIdNum]);
            const igFallback = await PlatformConnection.findOne({
              organization: organizationId,
              isActive: true,
              status: 'connected',
              platform: 'instagram',
              $or: [
                { platformPageId: { $in: pageIds } },
                { 'metadata.facebookPageId': { $in: pageIds } }
              ]
            }).select('accessToken').lean();

            if (igFallback?.accessToken) {
              console.log(`[PlatformPosts] Attempt 2: using Instagram token for Page ${pageIdStr}`);
              rawPosts = await tryFetch(igFallback.accessToken);
            }
          }

          // Attempt 3: user-level Facebook token (user access token with pages_read_engagement)
          if (rawPosts === null) {
            // Try with metadata.type filter first, then without as a wider fallback
            let userConn = await PlatformConnection.findOne({
              organization: organizationId,
              isActive: true,
              status: 'connected',
              platform: 'facebook',
              platformPageId: null,
              'metadata.type': 'user_token'
            }).select('accessToken').lean();

            if (!userConn) {
              // Broader fallback: any facebook connection with no platformPageId
              userConn = await PlatformConnection.findOne({
                organization: organizationId,
                isActive: true,
                status: 'connected',
                platform: 'facebook',
                $or: [{ platformPageId: null }, { platformPageId: { $exists: false } }]
              }).select('accessToken').lean();
            }

            if (userConn?.accessToken) {
              console.log(`[PlatformPosts] Attempt 3: using user-level Facebook token for Page ${pageIdStr}`);
              rawPosts = await tryFetch(userConn.accessToken);
            }
          }

          if (rawPosts === null) {
            console.warn(`[PlatformPosts] All tokens lack pages_read_engagement for Page ${pageIdStr}. Reconnect the Facebook Page.`);
            rawPosts = [];
          }
          for (const p of rawPosts || []) {
            normalized.push(normalizeFacebookPost(p, connection));
          }
        } else if (platform === 'instagram') {
          const rawMedia = await instagramService.getMedia(connection);
          for (const m of rawMedia) {
            normalized.push(normalizeInstagramMedia(m, connection));
          }
        }
      } catch (err) {
        console.error(`[PlatformPosts] Sync error for ${platform} ${connection._id}:`, err.message);
      }
    }

    const syncedAt = new Date();
    let upserted = 0;
    for (const post of normalized) {
      await PlatformPost.findOneAndUpdate(
        {
          organization: organizationId,
          platform: post.platform,
          externalId: post.externalId
        },
        {
          $set: {
            platformConnection: new mongoose.Types.ObjectId(post.connectionId),
            connectionName: post.connectionName,
            text: post.text,
            postedAt: post.postedAt,
            permalink: post.permalink,
            mediaUrl: post.mediaUrl,
            mediaType: post.mediaType,
            contentType: post.contentType,
            syncedAt
          }
        },
        { upsert: true, new: true }
      );
      upserted++;
    }

    res.status(200).json({
      success: true,
      synced: upserted,
      platform,
      message: `Synced ${upserted} posts from ${platform}`
    });
  } catch (error) {
    next(error);
  }
};
