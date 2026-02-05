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

      // Validate platformPageId
      if (!platformPageId) {
        console.error('❌ [Facebook] platformPageId is missing! Cannot fetch comments.');
        console.error('Connection details:', {
          platform: platformConnection.platform,
          platformUsername: platformConnection.platformUsername,
          platformUserId: platformConnection.platformUserId,
          platformPageId: platformConnection.platformPageId
        });
        throw new Error('Facebook Page ID is missing. Please reconnect your Facebook account.');
      }

      console.log(`💬 [Facebook] Fetching comments for page: ${platformPageId}`);

      // Fetch posts with comments (paginated)
      let allComments = [];
      let allPosts = [];
      let nextPage = `${this.baseURL}/${platformPageId}/feed`;
      let pageCount = 0;
      const maxPages = 10;

      // Step 1: Fetch all posts
      while (nextPage && pageCount < maxPages) {
        try {
          const response = await axios.get(nextPage, {
            params: {
              fields: 'id,message,created_time',
              limit: 25,
              access_token: accessToken
            }
          });

          const posts = response.data.data || [];
          allPosts = allPosts.concat(posts);

          nextPage = response.data.paging?.next;
          pageCount++;
        } catch (error) {
          console.error(`❌ [Facebook] Error fetching posts page ${pageCount + 1}:`, error.message);
          if (error.response?.data?.error) {
            console.error('API Error Details:', error.response.data.error);
          }
          break;
        }
      }

      console.log(`💬 [Facebook] Found ${allPosts.length} posts, now fetching comments...`);

      // Step 2: Fetch comments for each post (with pagination and nested replies)
      for (const post of allPosts) {
        try {
          let commentsNextPage = `${this.baseURL}/${post.id}/comments`;
          let commentsPageCount = 0;
          const maxCommentPages = 5; // Limit per post to avoid too many API calls

          while (commentsNextPage && commentsPageCount < maxCommentPages) {
            try {
              const commentsResponse = await axios.get(commentsNextPage, {
                params: {
                  fields: 'id,message,from,created_time,attachment,parent,permalink_url,comment_count',
                  limit: 100, // Facebook allows up to 100 comments per request
                  access_token: accessToken
                }
              });

              const comments = commentsResponse.data.data || [];
              
              // Add comments with post info
              for (const comment of comments) {
                allComments.push({
                  ...comment,
                  postId: post.id,
                  postMessage: post.message || '',
                  postCreatedTime: post.created_time
                });

                // If comment has replies, fetch them
                if (comment.comment_count > 0) {
                  try {
                    const repliesResponse = await axios.get(
                      `${this.baseURL}/${comment.id}/comments`,
                      {
                        params: {
                          fields: 'id,message,from,created_time,attachment,parent,permalink_url',
                          limit: 100,
                          access_token: accessToken
                        }
                      }
                    );

                    const replies = repliesResponse.data.data || [];
                    for (const reply of replies) {
                      allComments.push({
                        ...reply,
                        postId: post.id,
                        postMessage: post.message || '',
                        postCreatedTime: post.created_time,
                        parentCommentId: comment.id
                      });
                    }
                  } catch (replyError) {
                    console.warn(`Could not fetch replies for comment ${comment.id}:`, replyError.message);
                    // Continue even if replies fail
                  }
                }
              }

              commentsNextPage = commentsResponse.data.paging?.next;
              commentsPageCount++;
            } catch (error) {
              console.error(`Error fetching comments for post ${post.id}, page ${commentsPageCount + 1}:`, error.message);
              break;
            }
          }
        } catch (error) {
          console.error(`Error processing post ${post.id}:`, error.message);
          continue; // Continue with next post
        }
      }

      console.log(`💬 [Facebook] Found ${allComments.length} total comments (including replies)`);

      // Transform to new Interaction schema
      const interactions = [];
      const interactionMap = new Map();

      for (const comment of allComments) {
        // Determine parentId: use parentCommentId if it's a reply, otherwise use parent.id
        const parentId = comment.parentCommentId || comment.parent?.id || null;

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
          parentId: parentId, // For threaded comments (replies)
          metadata: {
            postId: comment.postId,
            postMessage: comment.postMessage,
            hasAttachment: !!comment.attachment,
            isReply: !!parentId // Flag to indicate if this is a reply
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
