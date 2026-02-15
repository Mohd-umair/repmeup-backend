const axios = require('axios');
const PlatformConnection = require('../../models/PlatformConnection');
const Interaction = require('../../models/Interaction');
const fs = require('fs');
const path = require('path');

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

  /**
   * Create a post on Facebook Page
   * @param {Object} platformConnection - Platform connection object
   * @param {Object} postData - Post data
   * @param {string} postData.message - Post caption/message
   * @param {string} [postData.url] - Image URL (for photo posts)
   * @param {Buffer} [postData.imageBuffer] - Image file buffer (for direct upload)
   * @param {string} [postData.link] - Link URL (for link posts)
   * @returns {Object} - Created post details
   */
  async createPost(platformConnection, postData) {
    try {
      const { accessToken, platformPageId } = platformConnection;
      const { message, url, link, imageBuffer } = postData;

      if (!platformPageId) {
        throw new Error('Facebook Page ID is missing. Please reconnect your Facebook account.');
      }

      console.log(`📝 [Facebook] Creating post on page: ${platformPageId}`);

      let endpoint;
      let requestData;
      let config;

      // Determine post type and endpoint
      if (imageBuffer) {
        // Photo post with direct file upload (more reliable than URL)
        const FormData = require('form-data');
        const form = new FormData();
        
        form.append('source', imageBuffer, {
          filename: 'image.jpg',
          contentType: 'image/jpeg'
        });
        if (message) {
          form.append('caption', message);
        }
        form.append('access_token', accessToken);

        endpoint = `${this.baseURL}/${platformPageId}/photos`;
        requestData = form;
        config = {
          headers: form.getHeaders(),
          maxContentLength: Infinity,
          maxBodyLength: Infinity
        };

        console.log(`📤 [Facebook] Uploading photo directly to: ${endpoint}`);
      } else if (url) {
        // Photo post with URL (fallback)
        console.log(`📷 [Facebook] Photo URL: ${url}`);
        
        // Pre-check: Verify URL is publicly accessible
        await this.verifyMediaUrlAccessible(url);
        
        endpoint = `${this.baseURL}/${platformPageId}/photos`;
        requestData = null;
        config = {
          params: {
            url: url,
            caption: message || '',
            access_token: accessToken
          }
        };
        console.log(`📤 [Facebook] Posting photo URL to: ${endpoint}`);
      } else if (link) {
        // Link post
        endpoint = `${this.baseURL}/${platformPageId}/feed`;
        requestData = null;
        config = {
          params: {
            message: message || '',
            link: link,
            access_token: accessToken
          }
        };
        console.log(`📤 [Facebook] Posting link to: ${endpoint}`);
      } else {
        // Text post
        endpoint = `${this.baseURL}/${platformPageId}/feed`;
        requestData = null;
        config = {
          params: {
            message: message || 'Posted from RepMeUp',
            access_token: accessToken
          }
        };
        console.log(`📤 [Facebook] Posting text to: ${endpoint}`);
      }

      const response = await axios.post(endpoint, requestData, config);

      console.log(`✅ [Facebook] Post created successfully:`, response.data);

      // Construct post URL
      const postId = response.data.id || response.data.post_id;
      let postUrl = `https://www.facebook.com/${postId}`;

      return {
        postId: postId,
        postUrl: postUrl,
        success: true
      };
    } catch (error) {
      console.error('❌ [Facebook] Create post error:', error.response?.data || error.message);
      
      // Enhanced error handling
      const errorMessage = error.response?.data?.error?.message || error.message;
      const errorCode = error.response?.data?.error?.code;
      
      throw {
        message: errorMessage,
        code: errorCode,
        platformError: {
          title: 'Facebook Posting Failed',
          message: errorMessage,
          code: errorCode
        }
      };
    }
  }

  /**
   * Create a Story on Facebook Page
   * Stories are 24-hour temporary content
   * @param {Object} platformConnection - Platform connection object
   * @param {Object} storyData - Story data
   * @param {string} storyData.imageUrl - Image URL (for photo stories)
   * @param {string} storyData.videoUrl - Video URL (for video stories)
   * @param {Buffer} storyData.imageBuffer - Image file buffer (for direct upload)
   * @returns {Object} - Created story details
   */
  async createStory(platformConnection, storyData) {
    try {
      const { accessToken, platformPageId } = platformConnection;
      const { imageUrl, videoUrl, imageBuffer } = storyData;

      if (!platformPageId) {
        throw new Error('Facebook Page ID is missing. Please reconnect your Facebook account.');
      }

      console.log(`📖 [Facebook] Creating story on page: ${platformPageId}`);

      let endpoint;
      let requestData;
      let config;

      // Stories require photo or video endpoint with temporary publishing
      if (imageBuffer) {
        // Photo story with direct file upload
        const FormData = require('form-data');
        const form = new FormData();
        
        form.append('source', imageBuffer, {
          filename: 'story.jpg',
          contentType: 'image/jpeg'
        });
        form.append('published', 'true');
        form.append('temporary', 'true'); // This makes it a story (24h expiry)
        form.append('access_token', accessToken);

        endpoint = `${this.baseURL}/${platformPageId}/photos`;
        requestData = form;
        config = {
          headers: form.getHeaders(),
          maxContentLength: Infinity,
          maxBodyLength: Infinity
        };

        console.log(`📤 [Facebook] Uploading photo story directly`);
      } else if (imageUrl) {
        // Photo story with URL
        endpoint = `${this.baseURL}/${platformPageId}/photos`;
        requestData = null;
        config = {
          params: {
            url: imageUrl,
            published: true,
            temporary: true, // 24h expiry
            access_token: accessToken
          }
        };
        console.log(`📤 [Facebook] Posting photo story URL`);
      } else if (videoUrl) {
        // Video story
        endpoint = `${this.baseURL}/${platformPageId}/videos`;
        requestData = null;
        config = {
          params: {
            file_url: videoUrl,
            published: true,
            temporary: true, // 24h expiry
            access_token: accessToken
          }
        };
        console.log(`📤 [Facebook] Posting video story URL`);
      } else {
        throw new Error('Story requires an image or video');
      }

      const response = await axios.post(endpoint, requestData, config);

      console.log(`✅ [Facebook] Story created successfully:`, response.data);

      const storyId = response.data.id || response.data.post_id;
      const storyUrl = `https://www.facebook.com/stories/${storyId}`;

      return {
        postId: storyId,
        postUrl: storyUrl,
        success: true
      };
    } catch (error) {
      console.error('❌ [Facebook] Create story error:', error.response?.data || error.message);
      
      const errorMessage = error.response?.data?.error?.message || error.message;
      const errorCode = error.response?.data?.error?.code;
      
      throw {
        message: errorMessage,
        code: errorCode,
        platformError: {
          title: 'Facebook Story Creation Failed',
          message: errorMessage,
          code: errorCode
        }
      };
    }
  }

  /**
   * Verify that a media URL is publicly accessible
   * This prevents Facebook error 389/1363057 (cannot fetch video/image from URL)
   */
  async verifyMediaUrlAccessible(mediaUrl) {
    try {
      console.log(`🔍 [Facebook] Verifying URL is accessible: ${mediaUrl}`);
      
      const response = await axios.head(mediaUrl, {
        timeout: 10000,
        maxRedirects: 5,
        validateStatus: (status) => status === 200
      });
      
      console.log(`✅ [Facebook] URL is accessible (${response.status})`);
      console.log(`📊 [Facebook] Content-Type: ${response.headers['content-type']}, Size: ${response.headers['content-length']} bytes`);
      
      return true;
    } catch (error) {
      console.error(`❌ [Facebook] URL is NOT accessible:`, error.message);
      
      if (error.code === 'ECONNREFUSED') {
        throw new Error(`URL is not accessible: Connection refused. Check if your server is running and accessible from the internet (not just localhost).`);
      } else if (error.code === 'ENOTFOUND') {
        throw new Error(`URL is not accessible: Domain not found. Check your BASE_URL in .env file.`);
      } else if (error.code === 'ETIMEDOUT' || error.code === 'ECONNABORTED') {
        throw new Error(`URL is not accessible: Connection timeout. Check firewall settings and ensure public access.`);
      } else if (error.response) {
        throw new Error(`URL is not accessible: Server returned ${error.response.status}. Ensure the /api/posts/media/ endpoint is public (no auth required).`);
      } else {
        throw new Error(`URL is not accessible: ${error.message}`);
      }
    }
  }

  /**
   * Create a Reel (Short) on Facebook Page
   * Reels are short-form vertical videos
   * @param {Object} platformConnection - Platform connection object
   * @param {Object} reelData - Reel data
   * @param {string} reelData.videoUrl - Video URL
   * @param {string} [reelData.description] - Video description/caption
   * @param {string} [reelData.title] - Video title
   * @returns {Object} - Created reel details
   */
  async createReel(platformConnection, reelData) {
    try {
      const { accessToken, platformPageId } = platformConnection;
      const { videoUrl, description, title } = reelData;

      if (!platformPageId) {
        throw new Error('Facebook Page ID is missing. Please reconnect your Facebook account.');
      }

      if (!videoUrl) {
        throw new Error('Video URL is required for Facebook Reels');
      }

      console.log(`🎬 [Facebook] Creating reel on page: ${platformPageId}`);
      console.log(`📹 [Facebook] Video URL: ${videoUrl}`);

      // Pre-check: Verify URL is publicly accessible
      await this.verifyMediaUrlAccessible(videoUrl);

      // Facebook Reels API requires direct file upload, not URL
      // Download/load the video file
      let videoBuffer;
      
      try {
        // Check if it's our own media URL
        const isOwnMedia = videoUrl.includes('/api/posts/media/');
        
        if (isOwnMedia) {
          const filename = videoUrl.split('/').pop();
          const videoFilePath = path.join(__dirname, '../../../uploads/posts', filename);
          
          if (fs.existsSync(videoFilePath)) {
            console.log(`📁 [Facebook] Reading local video file: ${filename}`);
            videoBuffer = fs.readFileSync(videoFilePath);
          } else {
            throw new Error(`Local file not found: ${videoFilePath}`);
          }
        } else {
          console.log(`📥 [Facebook] Downloading video from URL`);
          const response = await axios.get(videoUrl, {
            responseType: 'arraybuffer',
            timeout: 60000 // 60 seconds
          });
          videoBuffer = Buffer.from(response.data);
        }
        
        console.log(`✅ [Facebook] Video loaded, size: ${videoBuffer.length} bytes`);
      } catch (downloadError) {
        console.error(`❌ [Facebook] Failed to load video file:`, downloadError.message);
        throw new Error(`Cannot load video file for reel upload: ${downloadError.message}`);
      }

      // Facebook Reel API requires three-phase upload:
      // Phase 1: START - Initialize and get upload_url + video_id (graph-video.facebook.com)
      // Phase 2: UPLOAD - Upload file to upload_url 
      // Phase 3: FINISH - Finalize and publish (graph.facebook.com)
      
      const videoApiUrl = `https://graph-video.facebook.com/${this.apiVersion}`;
      const startEndpoint = `${videoApiUrl}/${platformPageId}/video_reels`;
      
      // Phase 1: Start upload session - get upload_url and video_id
      console.log(`📤 [Facebook] Phase 1: Starting reel upload session`);
      const startResponse = await axios.post(startEndpoint, null, {
        params: {
          upload_phase: 'start',
          access_token: accessToken,
          file_size: videoBuffer.length // Required for START phase
        }
      });
      
      const { video_id: videoId, upload_url: uploadUrl } = startResponse.data;
      console.log(`✅ [Facebook] Upload session started`);
      console.log(`   Video ID: ${videoId}`);
      console.log(`   Upload URL: ${uploadUrl ? 'received' : 'not provided'}`);

      // Phase 2: Upload video file to the upload_url
      const FormData = require('form-data');
      const form = new FormData();
      
      form.append('video_file_chunk', videoBuffer, {
        filename: 'reel.mp4',
        contentType: 'video/mp4'
      });

      console.log(`📤 [Facebook] Phase 2: Uploading video file (${videoBuffer.length} bytes)`);
      
      // Upload to the provided upload_url or back to the endpoint
      const uploadEndpoint = uploadUrl || `${videoApiUrl}/${platformPageId}/videos`;
      await axios.post(uploadEndpoint, form, {
        params: {
          access_token: accessToken,
          upload_phase: 'transfer',
          video_id: videoId
        },
        headers: {
          ...form.getHeaders(),
        },
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
        timeout: 120000 // 2 minutes
      });

      console.log(`✅ [Facebook] Video file uploaded successfully`);

      // Phase 3: Finish - Finalize and publish the reel
      const finishEndpoint = `${this.baseURL}/${platformPageId}/video_reels`;
      
      console.log(`📤 [Facebook] Phase 3: Finalizing reel`);
      const finishResponse = await axios.post(finishEndpoint, null, {
        params: {
          upload_phase: 'finish',
          video_id: videoId,
          description: description || title || '',
          access_token: accessToken
        }
      });

      const reelId = finishResponse.data.id || videoId;
      console.log(`✅ [Facebook] Reel created successfully: ${reelId}`);

      const reelUrl = `https://www.facebook.com/reel/${reelId}`;

      return {
        postId: reelId,
        postUrl: reelUrl,
        success: true
      };
    } catch (error) {
      const errorData = error.response?.data?.error;
      console.error('❌ [Facebook] Create reel error:', errorData || error.message);
      console.warn('⚠️ [Facebook] Reel creation failed, falling back to regular video post');
      
      try {
        const videoPost = await this.createVideoPost(platformConnection, {
          videoUrl: reelData.videoUrl,
          description: reelData.description || reelData.title
        });
        
        console.log('✅ [Facebook] Posted as regular video instead of reel');
        return videoPost;
      } catch (fallbackError) {
        console.error('❌ [Facebook] Video post fallback also failed:', fallbackError.response?.data || fallbackError.message);
        
        const errorMessage = error.response?.data?.error?.message || error.message;
        const errorCode = error.response?.data?.error?.code;
        
        throw {
          message: errorMessage,
          code: errorCode,
          platformError: {
            title: 'Facebook Video Post Failed',
            message: 'Both reel and video post creation failed. ' + errorMessage,
            code: errorCode
          }
        };
      }
    }
  }

  /**
   * Create a Video Post on Facebook Page (fallback for reels)
   * @param {Object} platformConnection - Platform connection object
   * @param {Object} videoData - Video data
   * @param {string} videoData.videoUrl - Video URL
   * @param {string} [videoData.description] - Video description
   * @returns {Object} - Created video post details
   */
  async createVideoPost(platformConnection, videoData) {
    try {
      const { accessToken, platformPageId } = platformConnection;
      const { videoUrl, description } = videoData;

      console.log(`🎥 [Facebook] Creating video post on page: ${platformPageId}`);
      console.log(`📹 [Facebook] Video URL: ${videoUrl}`);

      // Pre-check: Verify URL is publicly accessible
      await this.verifyMediaUrlAccessible(videoUrl);

      const endpoint = `${this.baseURL}/${platformPageId}/videos`;
      
      const response = await axios.post(endpoint, null, {
        params: {
          file_url: videoUrl,
          description: description || '',
          access_token: accessToken
        }
      });

      console.log(`✅ [Facebook] Video post created successfully:`, response.data);

      const videoId = response.data.id;
      const videoUrl_result = `https://www.facebook.com/${videoId}`;

      return {
        postId: videoId,
        postUrl: videoUrl_result,
        success: true
      };
    } catch (error) {
      console.error('❌ [Facebook] Create video post error:', error.response?.data || error.message);
      
      const errorMessage = error.response?.data?.error?.message || error.message;
      const errorCode = error.response?.data?.error?.code;
      
      throw {
        message: errorMessage,
        code: errorCode,
        platformError: {
          title: 'Facebook Video Post Failed',
          message: errorMessage,
          code: errorCode
        }
      };
    }
  }
}

module.exports = new FacebookService();
