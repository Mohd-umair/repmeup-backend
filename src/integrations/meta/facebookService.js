const axios = require('axios');
const PlatformConnection = require('../../models/PlatformConnection');
const Interaction = require('../../models/Interaction');

/**
 * Facebook Service
 * Handles Facebook Page comments and posts
 */
class FacebookService {
  constructor() {
    this.apiVersion = 'v18.0';
    this.baseURL = `https://graph.facebook.com/${this.apiVersion}`;
  }

  /**
   * Fetch posts and comments from Facebook Page
   */
  async fetchPosts(platformConnection) {
    try {
      const { accessToken, platformPageId } = platformConnection;

      console.log(`Fetching posts for Facebook Page: ${platformPageId}`);

      // Fetch posts with comments
      const postsResponse = await axios.get(
        `${this.baseURL}/${platformPageId}/feed`,
        {
          params: {
            fields: 'id,message,created_time,comments{id,message,from,created_time,attachment,parent}',
            limit: 50,
            access_token: accessToken
          }
        }
      );

      const posts = postsResponse.data.data || [];
      const interactions = [];

      for (const post of posts) {
        if (post.comments && post.comments.data) {
          for (const comment of post.comments.data) {
            const interaction = {
              platform: 'facebook',
              platformConnection: platformConnection._id,
              organization: platformConnection.organization,
              type: 'comment',
              platformId: comment.id,
              content: comment.message || '',
              customerName: comment.from?.name || 'Unknown User',
              customerId: comment.from?.id || null,
              customerEmail: null,
              customerPhone: null,
              customerAvatar: comment.from?.id 
                ? `https://graph.facebook.com/${comment.from.id}/picture?type=small`
                : null,
              status: 'unread',
              timestamp: new Date(comment.created_time),
              metadata: {
                postId: post.id,
                postMessage: post.message || '',
                parentComment: comment.parent?.id || null,
                hasAttachment: !!comment.attachment
              }
            };

            interactions.push(interaction);
          }
        }
      }

      // Bulk insert with upsert to avoid duplicates
      if (interactions.length > 0) {
        const bulkOps = interactions.map(interaction => ({
          updateOne: {
            filter: { platformId: interaction.platformId },
            update: { $setOnInsert: interaction },
            upsert: true
          }
        }));

        await Interaction.bulkWrite(bulkOps, { ordered: false });
        
        // Update sync stats
        await platformConnection.updateSyncStats(interactions.length, 0);
        
        console.log(`Fetched ${interactions.length} Facebook comments`);
      }

      return {
        success: true,
        count: interactions.length
      };
    } catch (error) {
      console.error('Facebook fetch posts error:', error.response?.data || error.message);
      throw new Error(`Failed to fetch Facebook posts: ${error.message}`);
    }
  }

  /**
   * Fetch Facebook Page reviews (if available)
   */
  async fetchReviews(platformConnection) {
    try {
      const { accessToken, platformPageId } = platformConnection;

      console.log(`Fetching reviews for Facebook Page: ${platformPageId}`);

      const reviewsResponse = await axios.get(
        `${this.baseURL}/${platformPageId}/ratings`,
        {
          params: {
            fields: 'created_time,recommendation_type,review_text,reviewer,rating',
            limit: 50,
            access_token: accessToken
          }
        }
      );

      const reviews = reviewsResponse.data.data || [];
      const interactions = [];

      for (const review of reviews) {
        const interaction = {
          platform: 'facebook',
          platformConnection: platformConnection._id,
          organization: platformConnection.organization,
          type: 'review',
          platformId: review.id || `review_${Date.now()}`,
          content: review.review_text || review.recommendation_type || '',
          customerName: review.reviewer?.name || 'Unknown User',
          customerId: review.reviewer?.id || null,
          customerEmail: null,
          customerPhone: null,
          customerAvatar: review.reviewer?.id 
            ? `https://graph.facebook.com/${review.reviewer.id}/picture?type=small`
            : null,
          rating: review.rating || 0,
          status: 'unread',
          timestamp: new Date(review.created_time),
          metadata: {
            recommendationType: review.recommendation_type
          }
        };

        interactions.push(interaction);
      }

      // Bulk insert with upsert
      if (interactions.length > 0) {
        const bulkOps = interactions.map(interaction => ({
          updateOne: {
            filter: { platformId: interaction.platformId },
            update: { $setOnInsert: interaction },
            upsert: true
          }
        }));

        await Interaction.bulkWrite(bulkOps, { ordered: false });
        
        console.log(`Fetched ${interactions.length} Facebook reviews`);
      }

      return {
        success: true,
        count: interactions.length
      };
    } catch (error) {
      console.error('Facebook fetch reviews error:', error.response?.data || error.message);
      // Reviews might not be available for all pages
      return {
        success: false,
        count: 0,
        error: error.message
      };
    }
  }

  /**
   * Reply to a Facebook comment
   */
  async replyToComment(platformConnection, commentId, message) {
    try {
      const { accessToken } = platformConnection;

      console.log(`Replying to Facebook comment: ${commentId}`);

      const response = await axios.post(
        `${this.baseURL}/${commentId}/comments`,
        {
          message: message
        },
        {
          params: {
            access_token: accessToken
          }
        }
      );

      return {
        success: true,
        commentId: response.data.id
      };
    } catch (error) {
      console.error('Facebook reply error:', error.response?.data || error.message);
      return {
        success: false,
        error: error.response?.data?.error?.message || error.message
      };
    }
  }

  /**
   * Delete a Facebook comment
   */
  async deleteComment(platformConnection, commentId) {
    try {
      const { accessToken } = platformConnection;

      await axios.delete(
        `${this.baseURL}/${commentId}`,
        {
          params: {
            access_token: accessToken
          }
        }
      );

      return {
        success: true
      };
    } catch (error) {
      console.error('Facebook delete comment error:', error.response?.data || error.message);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Hide/Unhide a Facebook comment
   */
  async hideComment(platformConnection, commentId, hide = true) {
    try {
      const { accessToken } = platformConnection;

      await axios.post(
        `${this.baseURL}/${commentId}`,
        {
          is_hidden: hide
        },
        {
          params: {
            access_token: accessToken
          }
        }
      );

      return {
        success: true
      };
    } catch (error) {
      console.error('Facebook hide comment error:', error.response?.data || error.message);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Get Facebook Page info
   */
  async getPageInfo(platformConnection) {
    try {
      const { accessToken, platformPageId } = platformConnection;

      const response = await axios.get(
        `${this.baseURL}/${platformPageId}`,
        {
          params: {
            fields: 'id,name,about,category,fan_count,followers_count,picture',
            access_token: accessToken
          }
        }
      );

      return {
        success: true,
        data: response.data
      };
    } catch (error) {
      console.error('Facebook get page info error:', error.response?.data || error.message);
      throw error;
    }
  }
}

module.exports = new FacebookService();

