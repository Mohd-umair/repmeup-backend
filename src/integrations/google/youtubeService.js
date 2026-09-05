const axios = require('axios');
const Interaction = require('../../models/Interaction');
const PlatformConnection = require('../../models/PlatformConnection');
const { generateChatRef } = require('../../utils/chatRefHelper');

class YouTubeService {
  constructor() {
    this.apiUrl = 'https://www.googleapis.com/youtube/v3';
    this.clientId = process.env.GOOGLE_CLIENT_ID;
    this.clientSecret = process.env.GOOGLE_CLIENT_SECRET;
    this.redirectUri = process.env.GOOGLE_REDIRECT_URI || 'http://localhost:3000/api/platforms/google/callback';
  }

  /**
   * Get OAuth authorization URL (uses same Google OAuth)
   */
  getAuthorizationUrl(state) {
    const scopes = [
      'https://www.googleapis.com/auth/youtube.readonly',
      'https://www.googleapis.com/auth/youtube.force-ssl',
      'https://www.googleapis.com/auth/userinfo.email',
      'https://www.googleapis.com/auth/userinfo.profile'
    ].join(' ');

    const params = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: this.redirectUri,
      response_type: 'code',
      scope: scopes,
      access_type: 'offline',
      prompt: 'consent',
      state: state
    });

    return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
  }

  /**
   * Get channel information
   */
  async getChannelInfo(accessToken) {
    try {
      const response = await axios.get(`${this.apiUrl}/channels`, {
        params: {
          part: 'snippet,contentDetails,statistics',
          mine: true
        },
        headers: {
          Authorization: `Bearer ${accessToken}`
        }
      });

      if (response.data.items && response.data.items.length > 0) {
        return response.data.items[0];
      }

      return null;
    } catch (error) {
      throw new Error(`Failed to get channel info: ${error.message}`);
    }
  }

  /**
   * Get videos for a channel
   */
  async getChannelVideos(accessToken, channelId, maxResults = 50) {
    try {
      // First, get uploads playlist ID
      const channelResponse = await axios.get(`${this.apiUrl}/channels`, {
        params: {
          part: 'contentDetails',
          id: channelId
        },
        headers: {
          Authorization: `Bearer ${accessToken}`
        }
      });

      if (!channelResponse.data.items || channelResponse.data.items.length === 0) {
        return [];
      }

      const uploadsPlaylistId = channelResponse.data.items[0].contentDetails.relatedPlaylists.uploads;

      // Get videos from uploads playlist
      const videosResponse = await axios.get(`${this.apiUrl}/playlistItems`, {
        params: {
          part: 'snippet,contentDetails',
          playlistId: uploadsPlaylistId,
          maxResults: maxResults
        },
        headers: {
          Authorization: `Bearer ${accessToken}`
        }
      });

      return videosResponse.data.items || [];
    } catch (error) {
      throw new Error(`Failed to get channel videos: ${error.message}`);
    }
  }

  /**
   * Fetch basic video info (title + thumbnail) for a single videoId.
   * Used when the caller doesn't already have this data (e.g. real-time webhooks).
   */
  async _getVideoInfo(accessToken, videoId) {
    try {
      const response = await axios.get(`${this.apiUrl}/videos`, {
        params: { part: 'snippet', id: videoId },
        headers: { Authorization: `Bearer ${accessToken}` }
      });
      const item = response.data.items?.[0];
      if (!item) return null;
      return {
        title: item.snippet.title || null,
        thumbnailUrl:
          item.snippet.thumbnails?.medium?.url ||
          item.snippet.thumbnails?.default?.url ||
          null
      };
    } catch {
      return null;
    }
  }

  /**
   * Fetch comments for a video
   * @param {Object} platformConnection
   * @param {string} videoId
   * @param {{ title: string|null, thumbnailUrl: string|null }|null} videoMeta
   *   If omitted (e.g. webhook path), the method fetches video info via the API.
   */
  async fetchVideoComments(platformConnection, videoId, videoMeta = null) {
    try {
      const { accessToken } = platformConnection;

      // Resolve video title/thumbnail if not supplied by the caller
      if (!videoMeta) {
        videoMeta = await this._getVideoInfo(accessToken, videoId);
      }

      const response = await axios.get(`${this.apiUrl}/commentThreads`, {
        params: {
          part: 'snippet,replies',
          videoId: videoId,
          maxResults: 100,
          order: 'time',
          textFormat: 'plainText'
        },
        headers: {
          Authorization: `Bearer ${accessToken}`
        }
      });

      const commentThreads = response.data.items || [];
      const interactions = [];

      for (const thread of commentThreads) {
        try {
          const topLevelComment = thread.snippet.topLevelComment.snippet;
          const commentId = thread.id;

          // Check if interaction already exists
          const existingInteraction = await Interaction.findOne({
            platformId: commentId,
            organization: platformConnection.organization
          });

          if (existingInteraction) {
            continue;
          }

          // Create interaction from comment
          // Note: Sentiment will be analyzed by AI processing job
          const interaction = {
            organization: platformConnection.organization,
            platformConnection: platformConnection._id,
            platform: 'youtube',
            type: 'comment',
            platformId: commentId,
            platformUrl: `https://www.youtube.com/watch?v=${videoId}&lc=${commentId}`,
            content: topLevelComment.textDisplay,
            contentType: 'text',
            language: topLevelComment.textDisplay ? 'en' : null,
            
            // Author information
            author: {
              platformId: topLevelComment.authorChannelId?.value || null,
              name: topLevelComment.authorDisplayName || 'Anonymous',
              username: topLevelComment.authorDisplayName || 'Anonymous',
              profileUrl: topLevelComment.authorChannelUrl || null,
              avatarUrl: topLevelComment.authorProfileImageUrl || null,
              isVerified: false
            },
            
            // Threading
            threadId: thread.id,
            hasReplies: thread.snippet.totalReplyCount > 0,
            replyCount: thread.snippet.totalReplyCount || 0,
            
            // Status
            status: 'unread',
            isRead: false,
            sentiment: null, // Will be set by AI processing
            
            // Platform timestamps
            platformCreatedAt: new Date(topLevelComment.publishedAt),
            platformUpdatedAt: new Date(topLevelComment.updatedAt),
            
            // Metadata
            metadata: {
              videoId: videoId,
              videoTitle: videoMeta?.title || null,
              videoThumbnailUrl: videoMeta?.thumbnailUrl || null,
              likeCount: topLevelComment.likeCount || 0,
              canReply: topLevelComment.canReply || false,
              isPublic: topLevelComment.isPublic || true
            }
          };

          interactions.push(interaction);

          // Process replies if any
          // Note: thread.replies.comments only contains first 5 replies
          // If totalReplyCount > 5, we need to fetch all replies separately
          const totalReplyCount = thread.snippet.totalReplyCount || 0;
          
          if (totalReplyCount > 0) {
            let allReplies = [];
            
            // If replies are included in the thread response, use them
            if (thread.replies && thread.replies.comments) {
              allReplies = thread.replies.comments;
            }
            
            // If there are more replies than what's included, fetch them all
            if (totalReplyCount > allReplies.length) {
              try {
                const repliesResponse = await axios.get(`${this.apiUrl}/comments`, {
                  params: {
                    part: 'snippet',
                    parentId: commentId, // Fetch all replies to this comment
                    maxResults: 100, // Fetch up to 100 replies
                    textFormat: 'plainText'
                  },
                  headers: {
                    Authorization: `Bearer ${accessToken}`
                  }
                });
                
                if (repliesResponse.data.items) {
                  allReplies = repliesResponse.data.items;
                }
              } catch (error) {
                console.error(`Error fetching all replies for comment ${commentId}:`, error.message);
                // Fall back to the replies we already have
              }
            }
            
            // Process all replies
            for (const reply of allReplies) {
              try {
                const replySnippet = reply.snippet;

                // Check if reply already exists
                const existingReply = await Interaction.findOne({
                  platformId: reply.id,
                  organization: platformConnection.organization
                });

                if (existingReply) {
                  continue;
                }

                const replyInteraction = {
                  organization: platformConnection.organization,
                  platformConnection: platformConnection._id,
                  platform: 'youtube',
                  type: 'comment',
                  platformId: reply.id,
                  platformUrl: `https://www.youtube.com/watch?v=${videoId}&lc=${reply.id}`,
                  content: replySnippet.textDisplay,
                  contentType: 'text',
                  language: 'en',
                  
                  // Author information
                  author: {
                    platformId: replySnippet.authorChannelId?.value || null,
                    name: replySnippet.authorDisplayName || 'Anonymous',
                    username: replySnippet.authorDisplayName || 'Anonymous',
                    profileUrl: replySnippet.authorChannelUrl || null,
                    avatarUrl: replySnippet.authorProfileImageUrl || null,
                    isVerified: false
                  },
                  
                  // Threading
                  parentId: commentId,
                  threadId: thread.id,
                  
                  // Status
                  status: 'unread',
                  isRead: false,
                  sentiment: null, // Will be set by AI processing
                  
                  // Platform timestamps
                  platformCreatedAt: new Date(replySnippet.publishedAt),
                  platformUpdatedAt: new Date(replySnippet.updatedAt),
                  
                  // Metadata
                  metadata: {
                    videoId: videoId,
                    videoTitle: videoMeta?.title || null,
                    videoThumbnailUrl: videoMeta?.thumbnailUrl || null,
                    parentCommentId: commentId,
                    likeCount: replySnippet.likeCount || 0
                  }
                };

                interactions.push(replyInteraction);
              } catch (error) {
                console.error(`Error processing reply ${reply.id}:`, error.message);
                continue;
              }
            }
          }
        } catch (error) {
          console.error(`Error processing comment ${thread.id}:`, error.message);
          continue;
        }
      }

      // Bulk upsert interactions (insert new, update existing)
      if (interactions.length > 0) {
        const ytOrgId = platformConnection.organization;
        const ytExistingIds = new Set(
          (await Interaction.find({ platformId: { $in: interactions.map(i => i.platformId) } }).select('platformId').lean())
            .map(i => i.platformId)
        );
        const ytChatRefMap = {};
        for (const interaction of interactions) {
          if (!ytExistingIds.has(interaction.platformId)) {
            ytChatRefMap[interaction.platformId] = await generateChatRef(ytOrgId).catch(() => ({ chatNumber: null, chatRef: null }));
          }
        }
        const bulkOps = interactions.map(interaction => {
          const { status, isRead, sentiment, ...platformFields } = interaction;
          const ref = ytChatRefMap[interaction.platformId] || {};
          return {
            updateOne: {
              filter: { platformId: interaction.platformId },
              update: {
                $set: platformFields,
                $setOnInsert: { status: 'unread', isRead: false, source: 'sync', sentiment: sentiment ?? null, chatNumber: ref.chatNumber ?? null, chatRef: ref.chatRef ?? null }
              },
              upsert: true
            }
          };
        });
        
        await Interaction.bulkWrite(bulkOps, { ordered: false });
      }

      return {
        success: true,
        count: interactions.length,
        interactions
      };
    } catch (error) {
      // Handle 403 errors gracefully (comments disabled or restricted video)
      if (error.response?.status === 403) {
        console.warn(`Comments disabled or restricted for video ${videoId}:`, error.response?.data?.error?.message);
        return { count: 0, interactions: [] }; // Return empty result instead of throwing error
      }
      
      // Handle 404 errors (video not found or deleted)
      if (error.response?.status === 404) {
        console.warn(`Video ${videoId} not found or deleted`);
        return { count: 0, interactions: [] }; // Return empty result instead of throwing error
      }
      
      console.error('Error fetching video comments:', error);
      throw new Error(`Failed to fetch video comments: ${error.message}`);
    }
  }

  /**
   * Fetch comments for all videos in a channel
   */
  async fetchAllChannelComments(platformConnection) {
    try {
      const { platformData } = platformConnection;
      const channelId = platformData.channelId;

      if (!channelId) {
        throw new Error('Channel ID not found in platform connection');
      }

      // Get recent videos
      const videos = await this.getChannelVideos(platformConnection.accessToken, channelId, 50);

      let totalCount = 0;
      const allInteractions = [];

      for (const video of videos) {
        try {
          const videoId = video.contentDetails.videoId;
          const videoMeta = {
            title: video.snippet?.title || null,
            thumbnailUrl:
              video.snippet?.thumbnails?.medium?.url ||
              video.snippet?.thumbnails?.default?.url ||
              null
          };
          const result = await this.fetchVideoComments(platformConnection, videoId, videoMeta);
          totalCount += result.count;
          allInteractions.push(...result.interactions);
        } catch (error) {
          console.error(`Error fetching comments for video ${video.contentDetails.videoId}:`, error.message);
          continue;
        }
      }

      // Update sync stats
      await platformConnection.updateSyncStats(totalCount, true);

      return {
        success: true,
        count: totalCount,
        interactions: allInteractions
      };
    } catch (error) {
      await platformConnection.logError(error);
      throw error;
    }
  }

  /**
   * Reply to a comment
   * @param {Object} platformConnection - The platform connection with access token
   * @param {String} commentId - The ID of the comment to reply to (can be top-level or reply)
   * @param {String} replyText - The text of the reply
   */
  async replyToComment(platformConnection, commentId, replyText) {
    try {
      // Ensure token is valid
      const accessToken = await this.ensureValidToken(platformConnection);

      // Get parent comment details to determine if it's a top-level comment or reply
      const parentComment = await axios.get(`${this.apiUrl}/comments`, {
        params: {
          part: 'snippet',
          id: commentId
        },
        headers: {
          Authorization: `Bearer ${accessToken}`
        }
      });

      if (!parentComment.data.items || parentComment.data.items.length === 0) {
        throw new Error(`Parent comment with ID ${commentId} not found`);
      }

      const parentSnippet = parentComment.data.items[0].snippet;
      
      // For YouTube API, parentId should be the ID of the comment you're replying to
      // If it's a top-level comment, use its ID. If it's a reply, you can still use its ID
      // But to maintain thread structure, if it's a reply, we should use the original comment's thread
      let parentId = commentId;
      
      // If the comment has a parentId in its snippet, it means it's a reply itself
      // In that case, we can still reply directly to it (YouTube allows nested replies)
      // Or we can reply to the top-level comment - but for better UX, let's reply directly to what was clicked
      // So we'll use the commentId as parentId

      // Insert reply using the comments.insert endpoint
      const response = await axios.post(
        `${this.apiUrl}/comments?part=snippet`,
        {
          snippet: {
            parentId: parentId, // The comment we're replying to
            textOriginal: replyText
          }
        },
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json'
          }
        }
      );

      if (!response.data || !response.data.id) {
        throw new Error('Failed to create reply - no comment ID returned from YouTube API');
      }

      return {
        success: true,
        commentId: response.data.id,
        comment: response.data,
        parentId: parentId
      };
    } catch (error) {
      console.error('Error replying to YouTube comment:', {
        commentId,
        error: error.response?.data || error.message,
        status: error.response?.status,
        statusText: error.response?.statusText
      });
      
      // Provide more helpful error messages
      if (error.response?.status === 403) {
        throw new Error('Permission denied. Make sure your YouTube account has permission to post comments and the OAuth scope includes youtube.force-ssl');
      } else if (error.response?.status === 401) {
        throw new Error('Authentication failed. Please reconnect your YouTube account.');
      } else if (error.response?.status === 404) {
        throw new Error('Comment not found. The comment may have been deleted.');
      }
      
      throw new Error(`Failed to reply to comment: ${error.response?.data?.error?.message || error.message}`);
    }
  }

  /**
   * Ensure token is valid, refresh if needed
   */
  async ensureValidToken(platformConnection) {
    if (!platformConnection.isTokenExpired()) {
      return platformConnection.accessToken;
    }

    if (!platformConnection.refreshToken) {
      throw new Error('Refresh token not available');
    }

    // Use Google service to refresh token
    const googleService = require('./googleService');
    const { accessToken, expiresIn } = await googleService.refreshAccessToken(
      platformConnection.refreshToken
    );

    // Update platform connection
    platformConnection.accessToken = accessToken;
    platformConnection.tokenExpiry = new Date(Date.now() + expiresIn * 1000);
    await platformConnection.save();

    return accessToken;
  }
}

module.exports = new YouTubeService();

