const axios = require('axios');
const Interaction = require('../../models/Interaction');
const PlatformConnection = require('../../models/PlatformConnection');

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
   * Fetch comments for a video
   */
  async fetchVideoComments(platformConnection, videoId) {
    try {
      const { accessToken } = platformConnection;

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

          // Determine sentiment (basic - can be enhanced with AI)
          let sentiment = 'neutral';
          const text = topLevelComment.textDisplay.toLowerCase();
          const positiveWords = ['great', 'awesome', 'love', 'amazing', 'excellent', 'good', 'nice', 'perfect'];
          const negativeWords = ['bad', 'terrible', 'hate', 'awful', 'worst', 'disappointed', 'poor'];

          if (positiveWords.some(word => text.includes(word))) {
            sentiment = 'positive';
          } else if (negativeWords.some(word => text.includes(word))) {
            sentiment = 'negative';
          }

          // Create interaction from comment
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
            sentiment: sentiment,
            
            // Platform timestamps
            platformCreatedAt: new Date(topLevelComment.publishedAt),
            platformUpdatedAt: new Date(topLevelComment.updatedAt),
            
            // Metadata
            metadata: {
              videoId: videoId,
              likeCount: topLevelComment.likeCount || 0,
              canReply: topLevelComment.canReply || false,
              isPublic: topLevelComment.isPublic || true
            }
          };

          interactions.push(interaction);

          // Process replies if any
          if (thread.replies && thread.replies.comments) {
            for (const reply of thread.replies.comments) {
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
                  sentiment: 'neutral',
                  
                  // Platform timestamps
                  platformCreatedAt: new Date(replySnippet.publishedAt),
                  platformUpdatedAt: new Date(replySnippet.updatedAt),
                  
                  // Metadata
                  metadata: {
                    videoId: videoId,
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

      // Bulk insert interactions
      if (interactions.length > 0) {
        await Interaction.insertMany(interactions, { ordered: false });
      }

      return {
        success: true,
        count: interactions.length,
        interactions
      };
    } catch (error) {
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
          const result = await this.fetchVideoComments(platformConnection, videoId);
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
   */
  async replyToComment(platformConnection, commentId, replyText) {
    try {
      const { accessToken } = platformConnection;

      // Get parent comment details first
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
        throw new Error('Parent comment not found');
      }

      const parentSnippet = parentComment.data.items[0].snippet;

      // Create reply
      const response = await axios.post(
        `${this.apiUrl}/commentThreads`,
        {
          snippet: {
            channelId: parentSnippet.channelId,
            videoId: parentSnippet.videoId,
            topLevelComment: {
              snippet: {
                textOriginal: replyText
              }
            }
          }
        },
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json'
          }
        }
      );

      return {
        success: true,
        comment: response.data
      };
    } catch (error) {
      throw new Error(`Failed to reply to comment: ${error.message}`);
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

