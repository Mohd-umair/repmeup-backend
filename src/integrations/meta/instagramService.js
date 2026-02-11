const axios = require('axios');
const Interaction = require('../../models/Interaction');

class InstagramService {
  constructor() {
    this.apiVersion = 'v18.0';
    this.baseUrl = `https://graph.facebook.com/${this.apiVersion}`;
    this.instagramGraphUrl = `https://graph.instagram.com/${this.apiVersion}`;
  }

  /**
   * Fetch Instagram user profile (name, profile_pic) for a user who messaged the business.
   * Uses Instagram User Profile API (graph.instagram.com). Returns null on error.
   */
  async _fetchInstagramUserProfile(accessToken, userId) {
    if (!userId) return null;
    try {
      const response = await axios.get(
        `${this.instagramGraphUrl}/${userId}`,
        {
          params: {
            fields: 'name,username,profile_pic',
            access_token: accessToken,
          },
          timeout: 5000,
        }
      );
      return response.data || null;
    } catch (err) {
      if (err.response?.status !== 400 && err.response?.status !== 404) {
        console.warn(`[Instagram] Could not fetch profile for user ${userId}:`, err.message);
      }
      return null;
    }
  }

  /**
   * Get business account ID from connection
   * Falls back to platformUserId if platformData.businessAccountId is not set
   */
  _getBusinessAccountId(platformConnection) {
    return platformConnection.platformData?.businessAccountId || 
           platformConnection.platformUserId;
  }

  /**
   * Fetch Instagram comments for a business account
   * Supports pagination and includes replies
   */
  async fetchComments(platformConnection) {
    try {
      const { accessToken } = platformConnection;
      const businessAccountId = this._getBusinessAccountId(platformConnection);

      if (!businessAccountId) {
        throw new Error('Instagram Business Account ID not found in connection');
      }

      console.log(`📸 [Instagram] Fetching comments for account: ${businessAccountId}`);

      // Get recent media (posts, reels, stories)
      let allMedia = [];
      let nextPage = `${this.baseUrl}/${businessAccountId}/media`;
      let pageCount = 0;
      const maxPages = 10; // Limit to prevent excessive API calls

      // Fetch all media with pagination
      while (nextPage && pageCount < maxPages) {
        try {
          const mediaResponse = await axios.get(nextPage, {
            params: {
              access_token: accessToken,
              fields: 'id,caption,media_type,timestamp,permalink,media_url',
              limit: 25
            }
          });

          allMedia = allMedia.concat(mediaResponse.data.data || []);
          nextPage = mediaResponse.data.paging?.next;
          pageCount++;

          if (pageCount >= maxPages) {
            console.log(`⚠️ [Instagram] Reached max pages (${maxPages}) for media fetch`);
          }
        } catch (error) {
          console.error(`Error fetching media page ${pageCount + 1}:`, error.message);
          break;
        }
      }

      console.log(`📸 [Instagram] Found ${allMedia.length} media items`);

      const interactions = [];
      const interactionMap = new Map(); // Track by platformId for bulk upsert

      // For each media, get comments
      for (const media of allMedia) {
        try {
          let allComments = [];
          let commentsNextPage = `${this.baseUrl}/${media.id}/comments`;
          let commentsPageCount = 0;
          const maxCommentPages = 5; // Limit comment pages per media

          // Fetch all comments with pagination
          while (commentsNextPage && commentsPageCount < maxCommentPages) {
            try {
              const commentsResponse = await axios.get(commentsNextPage, {
                params: {
                  access_token: accessToken,
                  fields: 'id,text,username,timestamp,from,like_count,replies{id,text,username,timestamp,from}',
                  limit: 100
                }
              });

              allComments = allComments.concat(commentsResponse.data.data || []);
              commentsNextPage = commentsResponse.data.paging?.next;
              commentsPageCount++;
            } catch (error) {
              console.error(`Error fetching comments page for media ${media.id}:`, error.message);
              break;
            }
          }

          // Process top-level comments
          for (const comment of allComments) {
            const interaction = {
              organization: platformConnection.organization,
              platformConnection: platformConnection._id,
              platform: 'instagram',
              type: 'comment',
              platformId: comment.id,
              platformUrl: media.permalink || `https://www.instagram.com/p/${media.id}/`,
              content: comment.text || '',
              author: {
                platformId: comment.from?.id,
                username: comment.username || comment.from?.username || 'unknown',
                name: comment.from?.username || comment.username || 'Unknown User',
                avatarUrl: comment.from?.id
                  ? `${this.baseUrl}/${comment.from.id}/picture?type=normal`
                  : undefined
              },
              metadata: {
                postId: media.id,
                postUrl: media.permalink,
                mediaType: media.media_type,
                likeCount: comment.like_count || 0
              },
              platformCreatedAt: new Date(comment.timestamp),
              status: 'unread',
              sentiment: null // Will be set by AI processing
            };

            interactions.push(interaction);
            interactionMap.set(comment.id, interaction);

            // Process replies to this comment
            if (comment.replies && comment.replies.data && comment.replies.data.length > 0) {
              for (const reply of comment.replies.data) {
                const replyInteraction = {
                  organization: platformConnection.organization,
                  platformConnection: platformConnection._id,
                  platform: 'instagram',
                  type: 'comment',
                  platformId: reply.id,
                  parentId: comment.id, // Link to parent comment
                  platformUrl: media.permalink || `https://www.instagram.com/p/${media.id}/`,
                  content: reply.text || '',
                  author: {
                    platformId: reply.from?.id,
                    username: reply.username || reply.from?.username || 'unknown',
                    name: reply.from?.username || reply.username || 'Unknown User'
                  },
                  metadata: {
                    postId: media.id,
                    postUrl: media.permalink,
                    parentCommentId: comment.id,
                    isReply: true
                  },
                  platformCreatedAt: new Date(reply.timestamp),
                  status: 'unread',
                  sentiment: null
                };

                interactions.push(replyInteraction);
                interactionMap.set(reply.id, replyInteraction);
              }
            }
          }
        } catch (error) {
          console.error(`Error processing media ${media.id}:`, error.message);
          continue;
        }
      }

      console.log(`📸 [Instagram] Found ${interactions.length} total comments (including replies)`);

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
        console.log(`✅ [Instagram] Saved ${interactions.length} comments to database`);
      }

      return {
        count: interactions.length,
        interactions: interactions
      };
    } catch (error) {
      console.error('Instagram fetch comments error:', error.message);
      if (error.response) {
        console.error('API Response:', error.response.data);
      }
      throw error;
    }
  }

  /**
   * Fetch Instagram DMs (messages) from conversations
   * Note: Instagram DMs require Instagram Messaging Product to be added to your app
   */
  async fetchMessages(platformConnection) {
    try {
      const { accessToken } = platformConnection;
      const businessAccountId = this._getBusinessAccountId(platformConnection);

      if (!businessAccountId) {
        throw new Error('Instagram Business Account ID not found in connection');
      }

      console.log(`💬 [Instagram] Fetching DMs for account: ${businessAccountId}`);

      // Get conversations
      let allConversations = [];
      let nextPage = `${this.baseUrl}/${businessAccountId}/conversations`;
      let pageCount = 0;
      const maxPages = 10;

      // Fetch conversations with pagination
      while (nextPage && pageCount < maxPages) {
        try {
          const response = await axios.get(nextPage, {
            params: {
              access_token: accessToken,
              platform: 'instagram',
              fields: 'id,participants',
              limit: 25
            }
          });

          allConversations = allConversations.concat(response.data.data || []);
          nextPage = response.data.paging?.next;
          pageCount++;
        } catch (error) {
          console.error(`❌ [Instagram] Error fetching conversations page ${pageCount + 1}:`, error.message);
          
          // Log detailed error info
          if (error.response?.data?.error) {
            const apiError = error.response.data.error;
            console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
            console.error('❌ [Instagram DM] API Error Details:');
            console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
            console.error('  Message:', apiError.message);
            console.error('  Type:', apiError.type);
            console.error('  Code:', apiError.code);
            console.error('  Subcode:', apiError.error_subcode);
            console.error('  Trace ID:', apiError.fbtrace_id);
            console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
            
            // Check for specific permission errors
            if (apiError.code === 10 || apiError.code === 200 || apiError.code === 190) {
              console.warn('');
              console.warn('⚠️  [Instagram DM] PERMISSION ERROR DETECTED');
              console.warn('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
              console.warn('📋 Instagram DMs require additional setup:');
              console.warn('');
              console.warn('   1. Add "Instagram Messaging" product to your Meta app');
              console.warn('      → https://developers.facebook.com/apps/1241029857870706/products/');
              console.warn('');
              console.warn('   2. Request "instagram_manage_messages" permission');
              console.warn('      → App Review → Permissions and Features');
              console.warn('');
              console.warn('   3. Complete Business Verification');
              console.warn('      → Settings → Basic → Business Verification');
              console.warn('');
              console.warn('   4. Switch app to Live mode (not Development)');
              console.warn('      → Settings → Basic → App Mode');
              console.warn('');
              console.warn('   5. After approval, reconnect Instagram in app settings');
              console.warn('');
              console.warn('📖 See: backend/docs/INSTAGRAM_DM_SETUP.md for full guide');
              console.warn('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
              console.warn('✅ Comments will continue to work normally');
              console.warn('');
            }
            
            if (apiError.code === 100) {
              console.error('❌ [Instagram] Invalid access token or permissions issue');
              console.error('   → Try disconnecting and reconnecting Instagram');
            }
          }
          
          // Don't throw error - just skip DMs and continue with comments
          break;
        }
      }

      if (allConversations.length > 0) {
        console.log(`✅ [Instagram] Found ${allConversations.length} conversations - DMs are working!`);
      } else if (pageCount === 0) {
        console.warn(`⚠️  [Instagram] No conversations found - DMs likely not enabled (see error above)`);
      } else {
        console.log(`📭 [Instagram] No active conversations found (DMs are enabled but no messages)`);
      }

      const interactions = [];
      const interactionMap = new Map();
      const profileCache = new Map();

      // For each conversation, get messages
      for (const conversation of allConversations) {
        try {
          // Get messages for this conversation
          let allMessages = [];
          let messagesNextPage = `${this.baseUrl}/${conversation.id}/messages`;
          let messagesPageCount = 0;
          const maxMessagePages = 10;

          while (messagesNextPage && messagesPageCount < maxMessagePages) {
            try {
              const messagesResponse = await axios.get(messagesNextPage, {
                params: {
                  access_token: accessToken,
                  fields: 'id,from,to,message,created_time,attachments',
                  limit: 100
                }
              });

              allMessages = allMessages.concat(messagesResponse.data.data || []);
              messagesNextPage = messagesResponse.data.paging?.next;
              messagesPageCount++;
            } catch (error) {
              console.error(`Error fetching messages for conversation ${conversation.id}:`, error.message);
              break;
            }
          }

          // Process messages (only incoming messages, not sent by us)
          for (const message of allMessages) {
            // Check if message is from someone else (not from our business account)
            const isFromUs = message.from?.id === businessAccountId || 
                            message.from?.id === platformConnection.platformPageId;

            if (!isFromUs && message.message) {
              let authorName = message.from?.name || message.from?.username || 'Unknown User';
              let avatarUrl = undefined;
              if (message.from?.id) {
                if (!profileCache.has(message.from.id)) {
                  const profile = await this._fetchInstagramUserProfile(accessToken, message.from.id);
                  profileCache.set(message.from.id, profile);
                }
                const profile = profileCache.get(message.from.id);
                if (profile) {
                  if (profile.profile_pic) avatarUrl = profile.profile_pic;
                  if (profile.name) authorName = profile.name;
                }
                if (!avatarUrl) {
                  avatarUrl = `${this.baseUrl}/${message.from.id}/picture?type=normal`;
                }
              }
              const interaction = {
                organization: platformConnection.organization,
                platformConnection: platformConnection._id,
                platform: 'instagram',
                type: 'dm',
                platformId: message.id,
                threadId: conversation.id,
                platformUrl: `https://www.instagram.com/direct/inbox/`,
                content: message.message,
                author: {
                  platformId: message.from?.id,
                  username: message.from?.username || 'unknown',
                  name: authorName,
                  avatarUrl
                },
                metadata: {
                  conversationId: conversation.id,
                  participants: conversation.participants?.data || [],
                  hasAttachments: !!(message.attachments && message.attachments.data && message.attachments.data.length > 0)
                },
                platformCreatedAt: new Date(message.created_time),
                status: 'unread',
                sentiment: null
              };

              interactions.push(interaction);
              interactionMap.set(message.id, interaction);
            }
          }
        } catch (error) {
          console.error(`Error processing conversation ${conversation.id}:`, error.message);
          continue;
        }
      }

      if (interactions.length > 0) {
        console.log(`💬 [Instagram] Found ${interactions.length} incoming DMs`);
      } else if (allConversations.length > 0) {
        console.log(`📭 [Instagram] No new incoming DMs (all messages from you or already synced)`);
      }

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
        console.log(`✅ [Instagram] Saved ${interactions.length} DMs to database`);
      }

      return {
        count: interactions.length,
        interactions: interactions
      };
    } catch (error) {
      console.error('Instagram fetch messages error:', error.message);
      if (error.response) {
        console.error('API Response:', error.response.data);
      }
      throw error;
    }
  }

  /**
   * Fetch all Instagram interactions (comments + DMs)
   */
  async fetchAllInteractions(platformConnection) {
    try {
      const commentsResult = await this.fetchComments(platformConnection);
      let messagesResult = { count: 0, interactions: [] };

      // Try to fetch messages (may fail if Instagram Messaging not enabled)
      try {
        messagesResult = await this.fetchMessages(platformConnection);
      } catch (error) {
        console.warn(`⚠️ [Instagram] Could not fetch DMs: ${error.message}`);
        // Continue even if DMs fail
      }

      return {
        count: commentsResult.count + messagesResult.count,
        interactions: [...commentsResult.interactions, ...messagesResult.interactions]
      };
    } catch (error) {
      console.error('Instagram fetch all interactions error:', error.message);
      throw error;
    }
  }

  /**
   * Reply to an Instagram comment
   */
  async replyToComment(commentId, message, accessToken) {
    try {
      const response = await axios.post(
        `${this.baseUrl}/${commentId}/replies`,
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
        platformResponseId: response.data.id
      };
    } catch (error) {
      console.error('Instagram reply to comment error:', error.message);
      if (error.response) {
        console.error('API Response:', error.response.data);
      }
      throw error;
    }
  }

  /**
   * Send Instagram DM
   * Note: Requires Instagram Messaging API
   */
  async sendMessage(recipientId, message, accessToken, pageId) {
    try {
      const response = await axios.post(
        `${this.baseUrl}/${pageId}/messages`,
        {
          recipient: { id: recipientId },
          message: { text: message }
        },
        {
          params: {
            access_token: accessToken
          }
        }
      );

      return {
        success: true,
        platformResponseId: response.data.message_id
      };
    } catch (error) {
      console.error('Instagram send message error:', error.message);
      if (error.response) {
        console.error('API Response:', error.response.data);
      }
      throw error;
    }
  }
  /**
   * Create Instagram Media Container
   * Step 1 of publishing process
   */
  async createMediaContainer(platformConnection, { caption, mediaUrl, mediaType }) {
    try {
      const { accessToken } = platformConnection;
      const businessAccountId = this._getBusinessAccountId(platformConnection);

      if (!businessAccountId) {
        throw new Error('Instagram Business Account ID not found');
      }

      console.log(`📸 [Instagram] Creating media container for account: ${businessAccountId}`);

      const params = {
        access_token: accessToken,
        caption: caption || ''
      };

      // Add media based on type
      if (mediaType === 'image') {
        params.image_url = mediaUrl;
      } else if (mediaType === 'video') {
        params.media_type = 'VIDEO';
        params.video_url = mediaUrl;
      } else {
        throw new Error('Invalid media type. Must be "image" or "video"');
      }

      const response = await axios.post(
        `${this.baseUrl}/${businessAccountId}/media`,
        null,
        { params }
      );

      console.log(`✅ [Instagram] Media container created:`, response.data.id);

      return {
        containerId: response.data.id,
        mediaType
      };
    } catch (error) {
      console.error('❌ [Instagram] Create container error:', error.response?.data || error.message);
      
      // Extract detailed error info from Instagram API
      const apiError = error.response?.data?.error;
      if (apiError) {
        const detailedError = new Error(apiError.message || 'Failed to create media container');
        detailedError.platformError = {
          title: apiError.error_user_title || 'Instagram Error',
          message: apiError.error_user_msg || apiError.message,
          code: apiError.code,
          subcode: apiError.error_subcode,
          type: apiError.type
        };
        throw detailedError;
      }
      
      throw new Error('Failed to create media container');
    }
  }

  /**
   * Check Media Container Status
   * Required for videos to ensure processing is complete
   */
  async checkContainerStatus(accessToken, containerId, maxAttempts = 30) {
    console.log(`⏳ [Instagram] Checking container status: ${containerId}`);

    for (let i = 0; i < maxAttempts; i++) {
      try {
        const response = await axios.get(
          `${this.baseUrl}/${containerId}`,
          {
            params: {
              access_token: accessToken,
              fields: 'status_code'
            }
          }
        );

        const statusCode = response.data.status_code;
        console.log(`📊 [Instagram] Container status (attempt ${i + 1}): ${statusCode}`);

        if (statusCode === 'FINISHED') {
          console.log(`✅ [Instagram] Container ready for publishing`);
          return true;
        } else if (statusCode === 'ERROR') {
          throw new Error('Video processing failed');
        } else if (statusCode === 'EXPIRED') {
          throw new Error('Container expired');
        }

        // Wait 2 seconds before next check
        await new Promise(resolve => setTimeout(resolve, 2000));
      } catch (error) {
        if (error.message.includes('processing') || error.message.includes('expired')) {
          throw error;
        }
        console.error(`⚠️ [Instagram] Status check error (attempt ${i + 1}):`, error.message);
      }
    }

    throw new Error('Video processing timeout - container not ready after 60 seconds');
  }

  /**
   * Publish Media Container
   * Step 2 of publishing process
   */
  async publishMediaContainer(platformConnection, containerId) {
    try {
      const { accessToken } = platformConnection;
      const businessAccountId = this._getBusinessAccountId(platformConnection);

      console.log(`📤 [Instagram] Publishing container: ${containerId}`);

      const response = await axios.post(
        `${this.baseUrl}/${businessAccountId}/media_publish`,
        null,
        {
          params: {
            access_token: accessToken,
            creation_id: containerId
          }
        }
      );

      const postId = response.data.id;
      console.log(`✅ [Instagram] Post published successfully: ${postId}`);

      // Fetch the permalink (correct URL with shortcode)
      let postUrl = `https://www.instagram.com/p/${postId}/`; // Fallback
      try {
        const mediaResponse = await axios.get(
          `${this.baseUrl}/${postId}`,
          {
            params: {
              access_token: accessToken,
              fields: 'permalink'
            }
          }
        );
        
        if (mediaResponse.data.permalink) {
          postUrl = mediaResponse.data.permalink;
          console.log(`✅ [Instagram] Fetched permalink: ${postUrl}`);
        }
      } catch (err) {
        console.warn(`⚠️ [Instagram] Could not fetch permalink, using fallback URL`);
      }

      return {
        postId,
        postUrl
      };
    } catch (error) {
      console.error('❌ [Instagram] Publish error:', error.response?.data || error.message);
      
      // Extract detailed error info from Instagram API
      const apiError = error.response?.data?.error;
      if (apiError) {
        const detailedError = new Error(apiError.message || 'Failed to publish media');
        detailedError.platformError = {
          title: apiError.error_user_title || 'Instagram Error',
          message: apiError.error_user_msg || apiError.message,
          code: apiError.code,
          subcode: apiError.error_subcode,
          type: apiError.type
        };
        throw detailedError;
      }
      
      throw new Error('Failed to publish media');
    }
  }

  /**
   * Create and Publish Instagram Post (Complete Flow)
   * Handles both images and videos
   */
  async createPost(platformConnection, { caption, mediaUrl, mediaType }) {
    try {
      if (!mediaUrl) {
        throw new Error('Media URL is required for Instagram posts');
      }

      console.log(`🚀 [Instagram] Starting post creation flow`);

      // Step 1: Create media container
      const { containerId } = await this.createMediaContainer(platformConnection, {
        caption,
        mediaUrl,
        mediaType
      });

      // Step 2: For videos, wait for processing to complete
      if (mediaType === 'video') {
        await this.checkContainerStatus(platformConnection.accessToken, containerId);
      }

      // Step 3: Publish the container
      const result = await this.publishMediaContainer(platformConnection, containerId);

      console.log(`🎉 [Instagram] Post creation complete!`);

      return result;
    } catch (error) {
      console.error('❌ [Instagram] Post creation failed:', error.message);
      // Preserve platformError if it exists
      if (error.platformError) {
        throw error;
      }
      throw new Error(error.message || 'Failed to create Instagram post');
    }
  }

  /**
   * Create and Publish Instagram Story
   * Stories are 24-hour temporary content
   */
  async createStory(platformConnection, { mediaUrl, mediaType }) {
    try {
      if (!mediaUrl) {
        throw new Error('Media URL is required for Instagram stories');
      }

      const { accessToken } = platformConnection;
      const businessAccountId = this._getBusinessAccountId(platformConnection);

      console.log(`📖 [Instagram] Starting story creation for account: ${businessAccountId}`);

      // Step 1: Create story container
      const params = {
        access_token: accessToken,
        media_type: 'STORIES' // This tells Instagram it's a story
      };

      if (mediaType === 'image') {
        params.image_url = mediaUrl;
      } else if (mediaType === 'video') {
        params.video_url = mediaUrl;
      } else {
        throw new Error('Invalid media type. Must be "image" or "video"');
      }

      console.log(`📸 [Instagram] Creating story container`);
      const containerResponse = await axios.post(
        `${this.baseUrl}/${businessAccountId}/media`,
        null,
        { params }
      );

      const containerId = containerResponse.data.id;
      console.log(`✅ [Instagram] Story container created: ${containerId}`);

      // Step 2: For videos, wait for processing
      if (mediaType === 'video') {
        await this.checkContainerStatus(accessToken, containerId);
      }

      // Step 3: Publish the story
      console.log(`📤 [Instagram] Publishing story container: ${containerId}`);
      const publishResponse = await axios.post(
        `${this.baseUrl}/${businessAccountId}/media_publish`,
        null,
        {
          params: {
            access_token: accessToken,
            creation_id: containerId
          }
        }
      );

      const storyId = publishResponse.data.id;
      console.log(`✅ [Instagram] Story published successfully: ${storyId}`);

      return {
        postId: storyId,
        postUrl: `https://www.instagram.com/stories/${businessAccountId}/${storyId}`
      };
    } catch (error) {
      console.error('❌ [Instagram] Story creation failed:', error.response?.data || error.message);
      
      const apiError = error.response?.data?.error;
      if (apiError) {
        const detailedError = new Error(apiError.message || 'Failed to create story');
        detailedError.platformError = {
          title: apiError.error_user_title || 'Instagram Story Error',
          message: apiError.error_user_msg || apiError.message,
          code: apiError.code,
          subcode: apiError.error_subcode,
          type: apiError.type
        };
        throw detailedError;
      }
      
      throw new Error(error.message || 'Failed to create Instagram story');
    }
  }

  /**
   * Create and Publish Instagram Reel
   * Reels are short-form video content optimized for discovery
   */
  async createReel(platformConnection, { caption, mediaUrl }) {
    try {
      if (!mediaUrl) {
        throw new Error('Video URL is required for Instagram reels');
      }

      const { accessToken } = platformConnection;
      const businessAccountId = this._getBusinessAccountId(platformConnection);

      console.log(`🎬 [Instagram] Starting reel creation for account: ${businessAccountId}`);

      // Step 1: Create reel container
      const params = {
        access_token: accessToken,
        media_type: 'REELS', // This tells Instagram it's a reel
        video_url: mediaUrl,
        caption: caption || '',
        share_to_feed: true // Also share to main feed
      };

      console.log(`📹 [Instagram] Creating reel container`);
      const containerResponse = await axios.post(
        `${this.baseUrl}/${businessAccountId}/media`,
        null,
        { params }
      );

      const containerId = containerResponse.data.id;
      console.log(`✅ [Instagram] Reel container created: ${containerId}`);

      // Step 2: Wait for video processing
      await this.checkContainerStatus(accessToken, containerId);

      // Step 3: Publish the reel
      console.log(`📤 [Instagram] Publishing reel container: ${containerId}`);
      const publishResponse = await axios.post(
        `${this.baseUrl}/${businessAccountId}/media_publish`,
        null,
        {
          params: {
            access_token: accessToken,
            creation_id: containerId
          }
        }
      );

      const reelId = publishResponse.data.id;
      console.log(`✅ [Instagram] Reel published successfully: ${reelId}`);

      // Try to fetch the permalink
      let reelUrl = `https://www.instagram.com/reel/${reelId}/`;
      try {
        const mediaResponse = await axios.get(
          `${this.baseUrl}/${reelId}`,
          {
            params: {
              access_token: accessToken,
              fields: 'permalink'
            }
          }
        );
        
        if (mediaResponse.data.permalink) {
          reelUrl = mediaResponse.data.permalink;
          console.log(`✅ [Instagram] Fetched reel permalink: ${reelUrl}`);
        }
      } catch (err) {
        console.warn(`⚠️ [Instagram] Could not fetch reel permalink, using fallback URL`);
      }

      return {
        postId: reelId,
        postUrl: reelUrl
      };
    } catch (error) {
      console.error('❌ [Instagram] Reel creation failed:', error.response?.data || error.message);
      
      const apiError = error.response?.data?.error;
      if (apiError) {
        const detailedError = new Error(apiError.message || 'Failed to create reel');
        detailedError.platformError = {
          title: apiError.error_user_title || 'Instagram Reel Error',
          message: apiError.error_user_msg || apiError.message,
          code: apiError.code,
          subcode: apiError.error_subcode,
          type: apiError.type
        };
        throw detailedError;
      }
      
      throw new Error(error.message || 'Failed to create Instagram reel');
    }
  }

  /**
   * Create Carousel Post (Multiple Media)
   */
  async createCarouselPost(platformConnection, { caption, mediaUrls }) {
    try {
      const { accessToken } = platformConnection;
      const businessAccountId = this._getBusinessAccountId(platformConnection);

      if (!mediaUrls || mediaUrls.length === 0) {
        throw new Error('At least one media URL is required for carousel posts');
      }

      if (mediaUrls.length > 10) {
        throw new Error('Maximum 10 media items allowed in carousel');
      }

      console.log(`📸 [Instagram] Creating carousel with ${mediaUrls.length} items`);

      // Step 1: Create containers for each media item
      const containerIds = [];
      for (const mediaItem of mediaUrls) {
        const params = {
          access_token: accessToken,
          is_carousel_item: true
        };

        if (mediaItem.type === 'image') {
          params.image_url = mediaItem.url;
        } else if (mediaItem.type === 'video') {
          params.media_type = 'VIDEO';
          params.video_url = mediaItem.url;
        }

        const response = await axios.post(
          `${this.baseUrl}/${businessAccountId}/media`,
          null,
          { params }
        );

        containerIds.push(response.data.id);
        console.log(`✅ [Instagram] Carousel item ${containerIds.length} created`);
      }

      // Step 2: Create carousel container
      const carouselResponse = await axios.post(
        `${this.baseUrl}/${businessAccountId}/media`,
        null,
        {
          params: {
            access_token: accessToken,
            media_type: 'CAROUSEL',
            caption: caption || '',
            children: containerIds.join(',')
          }
        }
      );

      const carouselContainerId = carouselResponse.data.id;
      console.log(`✅ [Instagram] Carousel container created: ${carouselContainerId}`);

      // Step 3: Publish carousel
      const result = await this.publishMediaContainer(platformConnection, carouselContainerId);

      console.log(`🎉 [Instagram] Carousel post published!`);

      return result;
    } catch (error) {
      console.error('❌ [Instagram] Carousel creation failed:', error.response?.data || error.message);
      
      // Extract detailed error info from Instagram API
      const apiError = error.response?.data?.error;
      if (apiError) {
        const detailedError = new Error(apiError.message || 'Failed to create carousel post');
        detailedError.platformError = {
          title: apiError.error_user_title || 'Instagram Error',
          message: apiError.error_user_msg || apiError.message,
          code: apiError.code,
          subcode: apiError.error_subcode,
          type: apiError.type
        };
        throw detailedError;
      }
      
      throw new Error('Failed to create carousel post');
    }
  }
}

module.exports = new InstagramService();
