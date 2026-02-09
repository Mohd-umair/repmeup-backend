const axios = require('axios');
const Interaction = require('../../models/Interaction');

/**
 * WhatsApp Business Cloud API Service
 * Handles WhatsApp message sending, receiving, and media
 * 
 * Documentation: https://developers.facebook.com/docs/whatsapp/cloud-api
 */

class WhatsAppService {
  constructor() {
    this.apiURL = 'https://graph.facebook.com/v18.0';
    this.phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
    this.accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
    this.businessAccountId = process.env.WHATSAPP_BUSINESS_ACCOUNT_ID;
  }

  /**
   * Verify WhatsApp connection
   */
  async verifyConnection() {
    try {
      if (!this.phoneNumberId || !this.accessToken) {
        throw new Error('WhatsApp credentials not configured');
      }

      // Get phone number details
      const response = await axios.get(
        `${this.apiURL}/${this.phoneNumberId}`,
        {
          headers: {
            'Authorization': `Bearer ${this.accessToken}`
          }
        }
      );

      return {
        success: true,
        phoneNumber: response.data.display_phone_number,
        verifiedName: response.data.verified_name,
        codeVerificationStatus: response.data.code_verification_status,
        qualityRating: response.data.quality_rating
      };
    } catch (error) {
      console.error('❌ [WhatsApp] Connection verification failed:', error.response?.data || error.message);
      throw new Error(error.response?.data?.error?.message || 'Failed to verify WhatsApp connection');
    }
  }

  /**
   * Send text message
   */
  async sendTextMessage(to, message) {
    try {
      const response = await axios.post(
        `${this.apiURL}/${this.phoneNumberId}/messages`,
        {
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: to,
          type: 'text',
          text: {
            preview_url: true,
            body: message
          }
        },
        {
          headers: {
            'Authorization': `Bearer ${this.accessToken}`,
            'Content-Type': 'application/json'
          }
        }
      );

      console.log('✅ [WhatsApp] Message sent:', response.data);

      return {
        success: true,
        messageId: response.data.messages[0].id,
        status: 'sent'
      };
    } catch (error) {
      console.error('❌ [WhatsApp] Failed to send message:', error.response?.data || error.message);
      throw new Error(error.response?.data?.error?.message || 'Failed to send WhatsApp message');
    }
  }

  /**
   * Send template message
   */
  async sendTemplateMessage(to, templateName, languageCode = 'en', components = []) {
    try {
      const response = await axios.post(
        `${this.apiURL}/${this.phoneNumberId}/messages`,
        {
          messaging_product: 'whatsapp',
          to: to,
          type: 'template',
          template: {
            name: templateName,
            language: {
              code: languageCode
            },
            components: components
          }
        },
        {
          headers: {
            'Authorization': `Bearer ${this.accessToken}`,
            'Content-Type': 'application/json'
          }
        }
      );

      return {
        success: true,
        messageId: response.data.messages[0].id
      };
    } catch (error) {
      console.error('❌ [WhatsApp] Failed to send template:', error.response?.data || error.message);
      throw new Error(error.response?.data?.error?.message || 'Failed to send WhatsApp template');
    }
  }

  /**
   * Send media message (image, video, document, audio)
   */
  async sendMediaMessage(to, mediaType, mediaId, caption = '') {
    try {
      const messageData = {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: to,
        type: mediaType
      };

      messageData[mediaType] = {
        id: mediaId
      };

      if (caption && (mediaType === 'image' || mediaType === 'video' || mediaType === 'document')) {
        messageData[mediaType].caption = caption;
      }

      const response = await axios.post(
        `${this.apiURL}/${this.phoneNumberId}/messages`,
        messageData,
        {
          headers: {
            'Authorization': `Bearer ${this.accessToken}`,
            'Content-Type': 'application/json'
          }
        }
      );

      return {
        success: true,
        messageId: response.data.messages[0].id
      };
    } catch (error) {
      console.error('❌ [WhatsApp] Failed to send media:', error.response?.data || error.message);
      throw new Error(error.response?.data?.error?.message || 'Failed to send WhatsApp media');
    }
  }

  /**
   * Mark message as read
   */
  async markAsRead(messageId) {
    try {
      await axios.post(
        `${this.apiURL}/${this.phoneNumberId}/messages`,
        {
          messaging_product: 'whatsapp',
          status: 'read',
          message_id: messageId
        },
        {
          headers: {
            'Authorization': `Bearer ${this.accessToken}`,
            'Content-Type': 'application/json'
          }
        }
      );

      return { success: true };
    } catch (error) {
      console.error('❌ [WhatsApp] Failed to mark as read:', error.response?.data || error.message);
      return { success: false };
    }
  }

  /**
   * Get media URL
   */
  async getMediaUrl(mediaId) {
    try {
      const response = await axios.get(
        `${this.apiURL}/${mediaId}`,
        {
          headers: {
            'Authorization': `Bearer ${this.accessToken}`
          }
        }
      );

      return {
        success: true,
        url: response.data.url,
        mimeType: response.data.mime_type,
        sha256: response.data.sha256,
        fileSize: response.data.file_size
      };
    } catch (error) {
      console.error('❌ [WhatsApp] Failed to get media URL:', error.response?.data || error.message);
      throw new Error('Failed to get media URL');
    }
  }

  /**
   * Download media
   */
  async downloadMedia(mediaUrl) {
    try {
      const response = await axios.get(mediaUrl, {
        headers: {
          'Authorization': `Bearer ${this.accessToken}`
        },
        responseType: 'arraybuffer'
      });

      return {
        success: true,
        data: response.data,
        contentType: response.headers['content-type']
      };
    } catch (error) {
      console.error('❌ [WhatsApp] Failed to download media:', error.message);
      throw new Error('Failed to download media');
    }
  }

  /**
   * Process incoming webhook message
   */
  async processWebhookMessage(webhookData) {
    try {
      console.log('📱 [WhatsApp] Processing webhook message');

      const entry = webhookData.entry[0];
      const changes = entry.changes[0];
      const value = changes.value;

      // Check if it's a message event
      if (!value.messages || value.messages.length === 0) {
        console.log('⏭️  [WhatsApp] No messages in webhook');
        return { success: true, skipped: true };
      }

      const message = value.messages[0];
      const contact = value.contacts[0];

      // Extract message details
      const messageData = {
        platformId: message.id,
        from: message.from,
        timestamp: new Date(parseInt(message.timestamp) * 1000),
        type: message.type,
        contact: {
          name: contact.profile.name,
          wa_id: contact.wa_id
        }
      };

      // Extract message content based on type
      switch (message.type) {
        case 'text':
          messageData.content = message.text.body;
          break;
        
        case 'image':
          messageData.content = message.image.caption || '[Image]';
          messageData.mediaId = message.image.id;
          messageData.mediaType = 'image';
          break;
        
        case 'video':
          messageData.content = message.video.caption || '[Video]';
          messageData.mediaId = message.video.id;
          messageData.mediaType = 'video';
          break;
        
        case 'audio':
          messageData.content = '[Audio Message]';
          messageData.mediaId = message.audio.id;
          messageData.mediaType = 'audio';
          break;
        
        case 'document':
          messageData.content = message.document.caption || message.document.filename || '[Document]';
          messageData.mediaId = message.document.id;
          messageData.mediaType = 'document';
          break;
        
        case 'location':
          messageData.content = `[Location: ${message.location.latitude}, ${message.location.longitude}]`;
          messageData.location = message.location;
          break;
        
        case 'contacts':
          messageData.content = `[Contact: ${message.contacts[0].name.formatted_name}]`;
          messageData.contacts = message.contacts;
          break;
        
        default:
          messageData.content = `[Unsupported message type: ${message.type}]`;
      }

      console.log('✅ [WhatsApp] Message processed:', messageData);

      return {
        success: true,
        messageData: messageData
      };

    } catch (error) {
      console.error('❌ [WhatsApp] Error processing webhook:', error);
      throw error;
    }
  }

  /**
   * Transform WhatsApp message to Interaction model
   */
  async transformToInteraction(messageData, platformConnection, organization) {
    try {
      const interaction = {
        organization: organization._id,
        platform: 'whatsapp',
        platformConnection: platformConnection._id,
        type: 'dm',
        platformId: messageData.platformId,
        content: messageData.content,
        contentType: messageData.mediaType || 'text',
        author: {
          platformId: messageData.from,
          name: messageData.contact.name,
          username: messageData.contact.wa_id
        },
        platformCreatedAt: messageData.timestamp,
        status: 'unread',
        isRead: false
      };

      // Add media metadata if present
      if (messageData.mediaId) {
        interaction.metadata = {
          mediaId: messageData.mediaId,
          mediaType: messageData.mediaType,
          hasMedia: true
        };
      }

      // Add location metadata if present
      if (messageData.location) {
        interaction.metadata = {
          ...interaction.metadata,
          location: messageData.location
        };
      }

      return interaction;
    } catch (error) {
      console.error('❌ [WhatsApp] Error transforming to interaction:', error);
      throw error;
    }
  }

  /**
   * Get business profile
   */
  async getBusinessProfile() {
    try {
      const response = await axios.get(
        `${this.apiURL}/${this.phoneNumberId}/whatsapp_business_profile`,
        {
          params: {
            fields: 'about,address,description,email,profile_picture_url,websites,vertical'
          },
          headers: {
            'Authorization': `Bearer ${this.accessToken}`
          }
        }
      );

      return {
        success: true,
        profile: response.data.data[0]
      };
    } catch (error) {
      console.error('❌ [WhatsApp] Failed to get business profile:', error.response?.data || error.message);
      throw new Error('Failed to get business profile');
    }
  }

  /**
   * Update business profile
   */
  async updateBusinessProfile(profileData) {
    try {
      const response = await axios.post(
        `${this.apiURL}/${this.phoneNumberId}/whatsapp_business_profile`,
        {
          messaging_product: 'whatsapp',
          ...profileData
        },
        {
          headers: {
            'Authorization': `Bearer ${this.accessToken}`,
            'Content-Type': 'application/json'
          }
        }
      );

      return {
        success: true,
        data: response.data
      };
    } catch (error) {
      console.error('❌ [WhatsApp] Failed to update business profile:', error.response?.data || error.message);
      throw new Error('Failed to update business profile');
    }
  }

  /**
   * Get message templates
   */
  async getMessageTemplates() {
    try {
      if (!this.businessAccountId) {
        throw new Error('WhatsApp Business Account ID not configured');
      }

      const response = await axios.get(
        `${this.apiURL}/${this.businessAccountId}/message_templates`,
        {
          headers: {
            'Authorization': `Bearer ${this.accessToken}`
          }
        }
      );

      return {
        success: true,
        templates: response.data.data
      };
    } catch (error) {
      console.error('❌ [WhatsApp] Failed to get templates:', error.response?.data || error.message);
      throw new Error('Failed to get message templates');
    }
  }
}

module.exports = new WhatsAppService();

