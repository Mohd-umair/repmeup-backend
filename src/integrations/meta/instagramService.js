const axios = require('axios');
const Interaction = require('../../models/Interaction');

class InstagramService {
  constructor() {
    this.apiVersion = 'v18.0';
    this.baseUrl = `https://graph.facebook.com/${this.apiVersion}`;
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
                name: comment.from?.username || comment.username || 'Unknown User'
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
          console.error(`Error fetching conversations page ${pageCount + 1}:`, error.message);
          if (error.response?.data?.error?.code === 10) {
            // Permission denied - Instagram Messaging not enabled
            throw new Error('Instagram Messaging API not enabled. Please add Instagram Messaging product to your Meta app.');
          }
          break;
        }
      }

      console.log(`💬 [Instagram] Found ${allConversations.length} conversations`);

      const interactions = [];
      const interactionMap = new Map();

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
                  name: message.from?.name || message.from?.username || 'Unknown User'
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

      console.log(`💬 [Instagram] Found ${interactions.length} incoming DMs`);

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
}

module.exports = new InstagramService();
