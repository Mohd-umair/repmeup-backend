const axios = require('axios');
const Interaction = require('../../models/Interaction');

class LinkedInService {
  constructor() {
    this.apiURL = 'https://api.linkedin.com/v2';
  }

  /**
   * Fetch all interactions (posts and comments) from LinkedIn
   */
  async fetchAllInteractions(connection) {
    try {
      console.log('🔄 [LinkedIn] Starting sync for organization:', connection.platformData?.organizationName || 'Personal');
      
      const accessToken = connection.accessToken;
      const organizationUrn = connection.platformData?.organizationUrn;
      
      if (!organizationUrn) {
        console.log('⚠️  [LinkedIn] No organization URN found, skipping sync');
        return { count: 0, interactions: [] };
      }

      const allInteractions = [];
      
      // Fetch organization posts
      const posts = await this.fetchOrganizationPosts(accessToken, organizationUrn);
      console.log(`📊 [LinkedIn] Found ${posts.length} posts`);
      
      // For each post, fetch comments
      for (const post of posts) {
        // Transform post to interaction
        const postInteraction = await this.transformPostToInteraction(post, connection);
        
        // Fetch comments for this post
        const comments = await this.fetchPostComments(accessToken, post.id);
        console.log(`💬 [LinkedIn] Found ${comments.length} comments for post ${post.id}`);
        
        // Transform comments to interactions
        for (const comment of comments) {
          const commentInteraction = await this.transformCommentToInteraction(comment, post, connection);
          allInteractions.push(commentInteraction);
        }
      }

      // Upsert interactions to database
      let savedCount = 0;
      for (const interactionData of allInteractions) {
        try {
          const { status, isRead, sentiment, ...platformFields } = interactionData;
          await Interaction.findOneAndUpdate(
            {
              platformId: interactionData.platformId,
              organization: connection.organization
            },
            {
              $set: platformFields,
              $setOnInsert: { status: 'unread', isRead: false, sentiment: sentiment ?? null }
            },
            {
              upsert: true,
              new: true,
              setDefaultsOnInsert: true
            }
          );
          savedCount++;
        } catch (error) {
          console.error(`❌ [LinkedIn] Failed to save interaction ${interactionData.platformId}:`, error.message);
        }
      }

      console.log(`✅ [LinkedIn] Sync complete: ${savedCount} interactions saved`);
      
      // Update connection stats
      await connection.updateSyncStats(savedCount, true);
      
      return {
        count: savedCount,
        interactions: allInteractions
      };
    } catch (error) {
      console.error('❌ [LinkedIn] Sync error:', error.message);
      console.error('❌ [LinkedIn] Error details:', error.response?.data || error);
      
      // Log error to connection
      if (connection && connection.logError) {
        await connection.logError(error);
      }
      
      // Return error details instead of throwing
      const errorMessage = error.response?.data?.message || 
                          error.response?.data?.error_description ||
                          error.message || 
                          'Failed to sync LinkedIn';
      
      // Check for specific LinkedIn API errors
      if (error.response?.status === 403) {
        throw new Error('LinkedIn API access denied. Please ensure "Share on LinkedIn" product is approved and r_organization_social scope is enabled.');
      } else if (error.response?.status === 401) {
        throw new Error('LinkedIn access token expired. Please reconnect your LinkedIn account.');
      } else if (error.response?.status === 404) {
        throw new Error('LinkedIn organization not found. Please verify you are an admin of the Company Page.');
      }
      
      throw new Error(`LinkedIn sync failed: ${errorMessage}`);
    }
  }

  /**
   * Fetch organization posts
   */
  async fetchOrganizationPosts(accessToken, organizationUrn, limit = 50) {
    try {
      const response = await axios.get(
        `${this.apiURL}/posts`,
        {
          params: {
            author: organizationUrn,
            q: 'author',
            count: limit,
            sortBy: 'LAST_MODIFIED'
          },
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'X-Restli-Protocol-Version': '2.0.0',
            'LinkedIn-Version': '202401'
          }
        }
      );

      return response.data.elements || [];
    } catch (error) {
      console.error('❌ [LinkedIn] Failed to fetch posts:', error.response?.data || error.message);
      return [];
    }
  }

  /**
   * Fetch comments for a post
   */
  async fetchPostComments(accessToken, postUrn) {
    try {
      const response = await axios.get(
        `${this.apiURL}/socialActions/${encodeURIComponent(postUrn)}/comments`,
        {
          params: {
            count: 100
          },
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'X-Restli-Protocol-Version': '2.0.0',
            'LinkedIn-Version': '202401'
          }
        }
      );

      return response.data.elements || [];
    } catch (error) {
      console.error('❌ [LinkedIn] Failed to fetch comments:', error.response?.data || error.message);
      return [];
    }
  }

  /**
   * Transform LinkedIn post to Interaction model
   */
  async transformPostToInteraction(post, connection) {
    const postId = post.id || post['$URN'];
    
    return {
      platformId: postId,
      platform: 'linkedin',
      type: 'post',
      content: post.commentary || post.text || '',
      author: {
        id: post.author,
        name: connection.platformData?.organizationName || 'Organization',
        username: connection.platformUsername,
        profilePicture: connection.platformProfilePicture
      },
      platformCreatedAt: new Date(post.createdAt || post.created?.time),
      platformUrl: post.permalink || `https://www.linkedin.com/feed/update/${postId}`,
      metadata: {
        likes: post.likesSummary?.totalLikes || 0,
        comments: post.commentsSummary?.totalComments || 0,
        shares: post.sharesSummary?.totalShares || 0,
        visibility: post.visibility || 'PUBLIC'
      },
      organization: connection.organization,
      platformConnection: connection._id,
      status: 'unread'
    };
  }

  /**
   * Transform LinkedIn comment to Interaction model
   */
  async transformCommentToInteraction(comment, post, connection) {
    const commentId = comment.id || comment['$URN'];
    const postId = post.id || post['$URN'];
    
    return {
      platformId: commentId,
      platform: 'linkedin',
      type: 'comment',
      content: comment.message?.text || comment.text || '',
      author: {
        id: comment.actor || comment.author,
        name: comment.actor ? 'LinkedIn User' : 'Unknown',
        username: null,
        profilePicture: null
      },
      parentId: postId,
      platformCreatedAt: new Date(comment.createdAt || comment.created?.time),
      platformUrl: `https://www.linkedin.com/feed/update/${postId}`,
      metadata: {
        likes: comment.likesSummary?.totalLikes || 0,
        postContent: post.commentary || post.text || ''
      },
      organization: connection.organization,
      platformConnection: connection._id,
      status: 'unread'
    };
  }

  /**
   * Reply to a LinkedIn comment
   */
  async replyToComment(connection, interactionId, replyText) {
    try {
      const interaction = await Interaction.findById(interactionId);
      
      if (!interaction) {
        throw new Error('Interaction not found');
      }

      const accessToken = connection.accessToken;
      const parentCommentUrn = interaction.platformId;
      const postUrn = interaction.parentId;

      console.log('💬 [LinkedIn] Replying to comment:', parentCommentUrn);

      const response = await axios.post(
        `${this.apiURL}/socialActions/${encodeURIComponent(postUrn)}/comments`,
        {
          actor: connection.platformData?.organizationUrn,
          message: {
            text: replyText
          },
          parentComment: parentCommentUrn
        },
        {
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'X-Restli-Protocol-Version': '2.0.0',
            'LinkedIn-Version': '202401',
            'Content-Type': 'application/json'
          }
        }
      );

      const replyId = response.headers['x-restli-id'] || response.data.id;

      console.log('✅ [LinkedIn] Reply posted successfully:', replyId);

      return {
        status: 'sent',
        platformResponseId: replyId,
        platformUrl: `https://www.linkedin.com/feed/update/${postUrn}`
      };
    } catch (error) {
      console.error('❌ [LinkedIn] Failed to post reply:', error.response?.data || error.message);
      return {
        status: 'failed',
        error: error.response?.data?.message || error.message
      };
    }
  }

  /**
   * Post a comment on a LinkedIn post
   */
  async postComment(connection, postUrn, commentText) {
    try {
      const accessToken = connection.accessToken;
      const organizationUrn = connection.platformData?.organizationUrn;

      console.log('💬 [LinkedIn] Posting comment on post:', postUrn);

      const response = await axios.post(
        `${this.apiURL}/socialActions/${encodeURIComponent(postUrn)}/comments`,
        {
          actor: organizationUrn,
          message: {
            text: commentText
          }
        },
        {
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'X-Restli-Protocol-Version': '2.0.0',
            'LinkedIn-Version': '202401',
            'Content-Type': 'application/json'
          }
        }
      );

      const commentId = response.headers['x-restli-id'] || response.data.id;

      console.log('✅ [LinkedIn] Comment posted successfully:', commentId);

      return {
        status: 'sent',
        platformResponseId: commentId,
        platformUrl: `https://www.linkedin.com/feed/update/${postUrn}`
      };
    } catch (error) {
      console.error('❌ [LinkedIn] Failed to post comment:', error.response?.data || error.message);
      return {
        status: 'failed',
        error: error.response?.data?.message || error.message
      };
    }
  }

  /**
   * Create a new LinkedIn post.
   * Supports both organization (Company Page) and member (personal profile) posting.
   * Falls back to personUrn when organizationUrn is not available.
   */
  async createPost(connection, postText, mediaUrls = []) {
    const accessToken = connection.accessToken;
    const organizationUrn = connection.platformData?.organizationUrn;
    const personUrn = connection.platformData?.personUrn
      ? connection.platformData.personUrn
      : `urn:li:person:${connection.platformUserId}`;

    const author = organizationUrn || personUrn;
    if (!author) {
      throw new Error('No LinkedIn author URN available. Reconnect your LinkedIn account.');
    }

    console.log(`📝 [LinkedIn] Creating post as ${author}...`);

    const postData = {
      author,
      commentary: postText,
      visibility: 'PUBLIC',
      distribution: {
        feedDistribution: 'MAIN_FEED',
        targetEntities: [],
        thirdPartyDistributionChannels: []
      },
      lifecycleState: 'PUBLISHED',
      isReshareDisabledByAuthor: false
    };

    if (mediaUrls.length > 0) {
      postData.content = {
        media: {
          title: postText.substring(0, 100),
          id: mediaUrls[0]
        }
      };
    }

    try {
      const response = await axios.post(
        `${this.apiURL}/posts`,
        postData,
        {
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'X-Restli-Protocol-Version': '2.0.0',
            'LinkedIn-Version': '202401',
            'Content-Type': 'application/json'
          }
        }
      );

      const postId = response.headers['x-restli-id'] || response.data.id;
      console.log('✅ [LinkedIn] Post created successfully:', postId);

      return {
        postId,
        postUrl: `https://www.linkedin.com/feed/update/${postId}`
      };
    } catch (error) {
      console.error('❌ [LinkedIn] Failed to create post:', error.response?.data || error.message);
      const msg = error.response?.data?.message
        || error.response?.data?.error_description
        || error.message
        || 'Failed to create LinkedIn post';
      throw new Error(msg);
    }
  }

  /**
   * Delete a comment
   */
  async deleteComment(connection, commentUrn) {
    try {
      const accessToken = connection.accessToken;

      console.log('🗑️  [LinkedIn] Deleting comment:', commentUrn);

      await axios.delete(
        `${this.apiURL}/socialActions/${encodeURIComponent(commentUrn)}`,
        {
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'X-Restli-Protocol-Version': '2.0.0',
            'LinkedIn-Version': '202401'
          }
        }
      );

      console.log('✅ [LinkedIn] Comment deleted successfully');

      return { status: 'deleted' };
    } catch (error) {
      console.error('❌ [LinkedIn] Failed to delete comment:', error.response?.data || error.message);
      return {
        status: 'failed',
        error: error.response?.data?.message || error.message
      };
    }
  }

  /**
   * Get post analytics
   */
  async getPostAnalytics(connection, postUrn) {
    try {
      const accessToken = connection.accessToken;

      const response = await axios.get(
        `${this.apiURL}/posts/${encodeURIComponent(postUrn)}`,
        {
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'X-Restli-Protocol-Version': '2.0.0',
            'LinkedIn-Version': '202401'
          }
        }
      );

      return {
        likes: response.data.likesSummary?.totalLikes || 0,
        comments: response.data.commentsSummary?.totalComments || 0,
        shares: response.data.sharesSummary?.totalShares || 0,
        impressions: response.data.impressionCount || 0
      };
    } catch (error) {
      console.error('❌ [LinkedIn] Failed to fetch analytics:', error.response?.data || error.message);
      return null;
    }
  }
}

module.exports = new LinkedInService();

