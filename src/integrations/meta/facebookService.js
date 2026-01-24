const axios = require('axios');
const PlatformConnection = require('../../models/PlatformConnection');
const Interaction = require('../../models/Interaction');

/**
 * Facebook Service
 * Handles Facebook Page comments, posts, and interactions
 */
class FacebookService {
  constructor() {
    this.apiVersion = 'v18.0';
    this.baseURL = `https://graph.facebook.com/${this.apiVersion}`;
  }

  /**
   * Fetch all posts and comments from Facebook Page
   * Updated to match new Interaction schema (similar to Instagram)
   */
  async fetchComments(platformConnection) {
    try {
      const { accessToken, platformPageId, organization } = platformConnection;

      console.log(`💬 [Facebook] Fetching comments for page: ${platformPageId}`);

      // Fetch posts with comments (paginated)
      let allComments = [];
      let nextPage = `${this.baseURL}/${platformPageId}/feed`;
      let pageCount = 0;
      const maxPages = 10;

      while (nextPage && pageCount < maxPages) {
        try {
          const response = await axios.get(nextPage, {
            params: {
              fields: 'id,message,created_time,comments{id,message,from,created_time,attachment,parent,permalink_url}',
              limit: 25,
              access_token: accessToken
            }
          });

          const posts = response.data.data || [];
          
          // Extract comments from posts
          for (const post of posts) {
            if (post.comments && post.comments.data) {
              for (const comment of post.comments.data) {
                allComments.push({
                  ...comment,
                  postId: post.id,
                  postMessage: post.message || '',
                  postCreatedTime: post.created_time
                });
              }
            }
          }

          nextPage = response.data.paging?.next;
          pageCount++;
        } catch (error) {
          console.error(`Error fetching comments page ${pageCount + 1}:`, error.message);
          break;
        }
      }

      console.log(`💬 [Facebook] Found ${allComments.length} comments`);

      // Transform to new Interaction schema
      const interactions = [];
      const interactionMap = new Map();

      for (const comment of allComments) {
        const interaction = {
          organization: organization,
          platformConnection: platformConnection._id,
          platform: 'facebook',
          type: 'comment',
          platformId: comment.id,
          platformUrl: comment.permalink_url || `https://facebook.com/${comment.id}`,
          content: comment.message || '',
          author: {
            platformId: comment.from?.id,
            username: comment.from?.name || 'Unknown User',
            name: comment.from?.name || 'Unknown User',
            profilePicture: comment.from?.id 
              ? `https://graph.facebook.com/${comment.from.id}/picture?type=small`
              : null
          },
          parentId: comment.parent?.id || null, // For threaded comments
          metadata: {
            postId: comment.postId,
            postMessage: comment.postMessage,
            hasAttachment: !!comment.attachment
          },
          platformCreatedAt: new Date(comment.created_time),
          status: 'unread',
          sentiment: null // Will be set by AI processing
        };

        interactions.push(interaction);
        interactionMap.set(comment.id, interaction);
      }

      console.log(`💬 [Facebook] Processed ${interactions.length} comments`);

      // Bulk upsert interactions
      if (interactions.length > 0) {
        const bulkOps = interactions.map(interaction => ({
          updateOne: {
            filter: { platformId: interaction.platformId },
            update: { $set: interaction },
            upsert: true
          }
        }));

        await Interaction.bulkWrite(bulkOps);
        console.log(`✅ [Facebook] Saved ${interactions.length} comments to database`);
      }

      return {
        count: interactions.length,
        interactions: interactions
      };
    } catch (error) {
      console.error('Facebook fetch comments error:', error.response?.data || error.message);
      if (error.response) {
        console.error('API Response:', error.response.data);
      }
      throw error;
    }
  }

  /**
   * Fetch Facebook Page reviews (if available)
   */
  async fetchReviews(platformConnection) {
    try {
      const { accessToken, platformPageId, organization } = platformConnection;

      console.log(`⭐ [Facebook] Fetching reviews for page: ${platformPageId}`);

      const reviewsResponse = await axios.get(
        `${this.baseURL}/${platformPageId}/ratings`,
        {
          params: {
            fields: 'created_time,recommendation_type,review_text,reviewer,rating,open_graph_story',
            limit: 50,
            access_token: accessToken
          }
        }
      );

      const reviews = reviewsResponse.data.data || [];
      const interactions = [];

      console.log(`⭐ [Facebook] Found ${reviews.length} reviews`);

      for (const review of reviews) {
        const interaction = {
          organization: organization,
          platformConnection: platformConnection._id,
          platform: 'facebook',
          type: 'review',
          platformId: review.open_graph_story?.id || `review_${review.reviewer?.id}_${Date.now()}`,
          platformUrl: `https://facebook.com/${platformPageId}`,
          content: review.review_text || review.recommendation_type || '',
          author: {
            platformId: review.reviewer?.id,
            username: review.reviewer?.name || 'Unknown User',
            name: review.reviewer?.name || 'Unknown User',
            profilePicture: review.reviewer?.id 
              ? `https://graph.facebook.com/${review.reviewer.id}/picture?type=small`
              : null
          },
          rating: review.rating || 0,
          metadata: {
            recommendationType: review.recommendation_type,
            hasRecommendation: !!review.recommendation_type
          },
          platformCreatedAt: new Date(review.created_time),
          status: 'unread',
          sentiment: review.rating >= 4 ? 'positive' : review.rating === 3 ? 'neutral' : 'negative'
        };

        interactions.push(interaction);
      }

      // Bulk upsert
      if (interactions.length > 0) {
        const bulkOps = interactions.map(interaction => ({
          updateOne: {
            filter: { platformId: interaction.platformId },
            update: { $set: interaction },
            upsert: true
          }
        }));

        await Interaction.bulkWrite(bulkOps);
        console.log(`✅ [Facebook] Saved ${interactions.length} reviews to database`);
      }

      return {
        count: interactions.length,
        interactions: interactions
      };
    } catch (error) {
      console.error('Facebook fetch reviews error:', error.response?.data || error.message);
      // Reviews might not be available for all pages
      return {
        count: 0,
        interactions: [],
        error: error.message
      };
    }
  }

  /**
   * Fetch all Facebook interactions (comments + reviews)
   */
  async fetchAllInteractions(platformConnection) {
    try {
      const commentsResult = await this.fetchComments(platformConnection);
      let reviewsResult = { count: 0, interactions: [] };

      // Try to fetch reviews (may fail if not available)
      try {
        reviewsResult = await this.fetchReviews(platformConnection);
      } catch (error) {
        console.warn(`⚠️ [Facebook] Could not fetch reviews: ${error.message}`);
        // Continue even if reviews fail
      }

      return {
        count: commentsResult.count + reviewsResult.count,
        interactions: [...commentsResult.interactions, ...reviewsResult.interactions]
      };
    } catch (error) {
      console.error('Facebook fetch all interactions error:', error.message);
      throw error;
    }
  }

  /**
   * Reply to a Facebook comment
   */
  async replyToComment(platformConnection, commentId, message) {
    try {
      const { accessToken } = platformConnection;

      console.log(`📤 [Facebook] Replying to comment: ${commentId}`);

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
