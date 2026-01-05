const axios = require('axios');
const Interaction = require('../../models/Interaction');

class InstagramService {
  constructor() {
    this.apiVersion = 'v18.0';
    this.baseUrl = `https://graph.facebook.com/${this.apiVersion}`;
  }

  /**
   * Fetch Instagram comments for a business account
   */
  async fetchComments(platformConnection) {
    try {
      const { accessToken, platformData } = platformConnection;
      const { businessAccountId } = platformData;

      // Get recent media
      const mediaResponse = await axios.get(
        `${this.baseUrl}/${businessAccountId}/media`,
        {
          params: {
            access_token: accessToken,
            fields: 'id,caption,media_type,timestamp,permalink'
          }
        }
      );

      const interactions = [];

      // For each media, get comments
      for (const media of mediaResponse.data.data) {
        try {
          const commentsResponse = await axios.get(
            `${this.baseUrl}/${media.id}/comments`,
            {
              params: {
                access_token: accessToken,
                fields: 'id,text,username,timestamp,from,like_count,replies'
              }
            }
          );

          for (const comment of commentsResponse.data.data || []) {
            const interaction = {
              organization: platformConnection.organization,
              platformConnection: platformConnection._id,
              platform: 'instagram',
              type: 'comment',
              platformId: comment.id,
              platformUrl: `${media.permalink}`,
              content: comment.text,
              author: {
                platformId: comment.from?.id,
                username: comment.username,
                name: comment.from?.username || comment.username
              },
              metadata: {
                postId: media.id,
                postUrl: media.permalink
              },
              platformCreatedAt: new Date(comment.timestamp),
              status: 'unread'
            };

            interactions.push(interaction);

            // Save or update in database
            await Interaction.findOneAndUpdate(
              { platformId: comment.id },
              interaction,
              { upsert: true, new: true }
            );
          }
        } catch (error) {
          console.error(`Error fetching comments for media ${media.id}:`, error.message);
        }
      }

      return interactions;
    } catch (error) {
      console.error('Instagram fetch comments error:', error.message);
      throw error;
    }
  }

  /**
   * Fetch Instagram DMs (messages)
   */
  async fetchMessages(platformConnection) {
    try {
      const { accessToken, platformData } = platformConnection;
      const { businessAccountId } = platformData;

      const response = await axios.get(
        `${this.baseUrl}/${businessAccountId}/conversations`,
        {
          params: {
            access_token: accessToken,
            platform: 'instagram',
            fields: 'id,participants,messages{id,from,to,message,created_time}'
          }
        }
      );

      const interactions = [];

      for (const conversation of response.data.data || []) {
        for (const message of conversation.messages?.data || []) {
          // Only save messages sent to us (not from us)
          if (message.from.id !== businessAccountId) {
            const interaction = {
              organization: platformConnection.organization,
              platformConnection: platformConnection._id,
              platform: 'instagram',
              type: 'dm',
              platformId: message.id,
              content: message.message,
              author: {
                platformId: message.from.id,
                username: message.from.username || 'Unknown',
                name: message.from.name || message.from.username
              },
              threadId: conversation.id,
              platformCreatedAt: new Date(message.created_time),
              status: 'unread'
            };

            interactions.push(interaction);

            await Interaction.findOneAndUpdate(
              { platformId: message.id },
              interaction,
              { upsert: true, new: true }
            );
          }
        }
      }

      return interactions;
    } catch (error) {
      console.error('Instagram fetch messages error:', error.message);
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
      throw error;
    }
  }

  /**
   * Send Instagram DM
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
      throw error;
    }
  }
}

module.exports = new InstagramService();

