const axios = require('axios');
const Interaction = require('../../models/Interaction');

/**
 * WhatsApp Business Cloud API Service
 * Multi-tenant: all send/query methods accept a `connection` object (PlatformConnection)
 * instead of reading from process.env. This allows each customer to use their own
 * WhatsApp Business Account credentials stored in the database.
 *
 * Documentation: https://developers.facebook.com/docs/whatsapp/cloud-api
 */
class WhatsAppService {
  constructor() {
    this.apiVersion = 'v23.0';
    this.apiURL = `https://graph.facebook.com/${this.apiVersion}`;
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  /**
   * Extract phone number ID from a PlatformConnection.
   * Supports both new (platformData.phoneNumberId) and legacy (platformUserId) storage.
   */
  _phoneNumberId(connection) {
    return connection.platformData?.phoneNumberId
      || connection.platformData?.phoneNumberId
      || connection.platformUserId
      || process.env.WHATSAPP_PHONE_NUMBER_ID;
  }

  /**
   * Extract access token from a PlatformConnection, falling back to env.
   */
  _accessToken(connection) {
    return connection?.accessToken || process.env.WHATSAPP_ACCESS_TOKEN;
  }

  _authHeader(connection) {
    return { Authorization: `Bearer ${this._accessToken(connection)}` };
  }

  _jsonHeaders(connection) {
    return {
      Authorization: `Bearer ${this._accessToken(connection)}`,
      'Content-Type': 'application/json'
    };
  }

  // ---------------------------------------------------------------------------
  // Connection verification
  // ---------------------------------------------------------------------------

  /**
   * Verify a WhatsApp connection by querying the phone number details.
   * @param {Object} connection  PlatformConnection document (or null for env fallback)
   */
  async verifyConnection(connection = null) {
    const phoneNumberId = this._phoneNumberId(connection || {});
    const token = this._accessToken(connection || {});

    if (!phoneNumberId || !token) {
      throw new Error('WhatsApp credentials not configured');
    }

    try {
      const response = await axios.get(`${this.apiURL}/${phoneNumberId}`, {
        headers: { Authorization: `Bearer ${token}` },
        timeout: 10000
      });

      return {
        success: true,
        phoneNumber: response.data.display_phone_number,
        verifiedName: response.data.verified_name,
        codeVerificationStatus: response.data.code_verification_status,
        qualityRating: response.data.quality_rating
      };
    } catch (error) {
      console.error('[WhatsApp] Connection verification failed:', error.response?.data || error.message);
      throw new Error(error.response?.data?.error?.message || 'Failed to verify WhatsApp connection');
    }
  }

  // ---------------------------------------------------------------------------
  // Messaging
  // ---------------------------------------------------------------------------

  /**
   * Send a plain text message.
   * @param {Object} connection  PlatformConnection
   * @param {string} to          Recipient phone number (E.164 format)
   * @param {string} message     Message body
   */
  async sendTextMessage(connection, to, message) {
    const phoneNumberId = this._phoneNumberId(connection);
    try {
      const response = await axios.post(
        `${this.apiURL}/${phoneNumberId}/messages`,
        {
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to,
          type: 'text',
          text: { preview_url: true, body: message }
        },
        { headers: this._jsonHeaders(connection), timeout: 15000 }
      );

      console.log('[WhatsApp] Message sent:', response.data.messages?.[0]?.id);
      return { success: true, messageId: response.data.messages[0].id, status: 'sent' };
    } catch (error) {
      console.error('[WhatsApp] Failed to send message:', error.response?.data || error.message);
      throw new Error(error.response?.data?.error?.message || 'Failed to send WhatsApp message');
    }
  }

  /**
   * Send a template message.
   * @param {Object} connection
   * @param {string} to
   * @param {string} templateName
   * @param {string} languageCode
   * @param {Array}  components
   */
  async sendTemplateMessage(connection, to, templateName, languageCode = 'en', components = []) {
    const phoneNumberId = this._phoneNumberId(connection);
    try {
      const response = await axios.post(
        `${this.apiURL}/${phoneNumberId}/messages`,
        {
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to,
          type: 'template',
          template: { name: templateName, language: { code: languageCode }, components }
        },
        { headers: this._jsonHeaders(connection), timeout: 15000 }
      );

      return { success: true, messageId: response.data.messages[0].id };
    } catch (error) {
      const metaErr = error.response?.data?.error;
      console.error('[WhatsApp] Failed to send template:', error.response?.data || error.message);
      const err = new Error(metaErr?.message || 'Failed to send WhatsApp template');
      err.httpStatus = error.response?.status;
      err.metaCode = metaErr?.code;
      throw err;
    }
  }

  /**
   * Upload media binary to WhatsApp Cloud API (required before sending image/document/video/audio).
   * @param {Object} connection
   * @param {string} filePath     Absolute path to the file on disk
   * @param {string} waType       'image' | 'video' | 'audio' | 'document'
   * @returns {Promise<string>}   Graph media id
   */
  async uploadMedia(connection, filePath, waType) {
    const FormData = require('form-data');
    const fs = require('fs');
    const phoneNumberId = this._phoneNumberId(connection);
    const token = this._accessToken(connection);
    if (!phoneNumberId || !token) {
      throw new Error('WhatsApp credentials not configured');
    }
    if (!fs.existsSync(filePath)) {
      throw new Error('WhatsApp media upload: file not found');
    }
    const form = new FormData();
    form.append('messaging_product', 'whatsapp');
    form.append('type', waType);
    form.append('file', fs.createReadStream(filePath));

    try {
      const response = await axios.post(`${this.apiURL}/${phoneNumberId}/media`, form, {
        headers: {
          Authorization: `Bearer ${token}`,
          ...form.getHeaders()
        },
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
        timeout: 120000
      });
      const id = response.data?.id;
      if (!id) {
        throw new Error(response.data?.error?.message || 'WhatsApp media upload returned no id');
      }
      return id;
    } catch (error) {
      console.error('[WhatsApp] Media upload failed-', error.response?.data || error.message);
      throw new Error(error.response?.data?.error?.message || 'Failed to upload media to WhatsApp');
    }
  }

  /**
   * @param {string} [documentFilename] Required for type `document` (customer-visible filename)
   */
  async sendMediaMessage(connection, to, mediaType, mediaId, caption = '', documentFilename = null) {
    const phoneNumberId = this._phoneNumberId(connection);
    try {
      const mediaPayload = { id: mediaId };
      if (mediaType === 'document' && documentFilename) {
        mediaPayload.filename = documentFilename;
      }
      if (caption && ['image', 'video', 'document'].includes(mediaType)) {
        mediaPayload.caption = caption;
      }

      const messageData = {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to,
        type: mediaType,
        [mediaType]: mediaPayload
      };

      const response = await axios.post(
        `${this.apiURL}/${phoneNumberId}/messages`,
        messageData,
        { headers: this._jsonHeaders(connection), timeout: 15000 }
      );

      return { success: true, messageId: response.data.messages[0].id };
    } catch (error) {
      console.error('[WhatsApp] Failed to send media:', error.response?.data || error.message);
      throw new Error(error.response?.data?.error?.message || 'Failed to send WhatsApp media');
    }
  }

  /**
   * Mark a message as read.
   * @param {Object} connection
   * @param {string} messageId
   */
  async markAsRead(connection, messageId) {
    const phoneNumberId = this._phoneNumberId(connection);
    try {
      await axios.post(
        `${this.apiURL}/${phoneNumberId}/messages`,
        { messaging_product: 'whatsapp', status: 'read', message_id: messageId },
        { headers: this._jsonHeaders(connection), timeout: 10000 }
      );
      return { success: true };
    } catch (error) {
      // Non-fatal — log and continue
      console.warn('[WhatsApp] Failed to mark as read:', error.response?.data?.error?.message || error.message);
      return { success: false };
    }
  }

  // ---------------------------------------------------------------------------
  // Media
  // ---------------------------------------------------------------------------

  /**
   * Get media metadata (URL, mime type, size, sha256).
   * @param {Object} connection
   * @param {string} mediaId
   */
  async getMediaUrl(connection, mediaId) {
    try {
      const response = await axios.get(`${this.apiURL}/${mediaId}`, {
        headers: this._authHeader(connection),
        timeout: 10000
      });
      return {
        success: true,
        url: response.data.url,
        mimeType: response.data.mime_type,
        sha256: response.data.sha256,
        fileSize: response.data.file_size
      };
    } catch (error) {
      console.error('[WhatsApp] Failed to get media URL:', error.response?.data || error.message);
      throw new Error('Failed to get media URL');
    }
  }

  /**
   * Download media binary.
   * @param {Object} connection
   * @param {string} mediaUrl
   */
  async downloadMedia(connection, mediaUrl) {
    try {
      const response = await axios.get(mediaUrl, {
        headers: this._authHeader(connection),
        responseType: 'arraybuffer',
        timeout: 30000
      });
      return { success: true, data: response.data, contentType: response.headers['content-type'] };
    } catch (error) {
      console.error('[WhatsApp] Failed to download media:', error.message);
      throw new Error('Failed to download media');
    }
  }

  // ---------------------------------------------------------------------------
  // Webhook payload parsing (stateless — no connection needed)
  // ---------------------------------------------------------------------------

  /**
   * Human-readable text when Meta sends type "unsupported" (Cloud API cannot expose content).
   * @see https://developers.facebook.com/docs/whatsapp/cloud-api/webhooks/reference/messages/unsupported
   */
  _formatUnsupportedMessage(message) {
    const err = Array.isArray(message?.errors) ? message.errors[0] : null;
    const code = err?.code != null ? Number(err.code) : null;

    if (code === 131060) {
      return 'This message is temporarily unavailable. The customer may have contacted you from the WhatsApp Business app — ask them to send the message again.';
    }
    if (code === 131051) {
      return 'This message type is not supported by WhatsApp Business API (e.g. poll, GIF, or deleted message). Ask the customer to resend as text, photo, or document.';
    }
    if (err?.message || err?.title) {
      return String(err.message || err.title);
    }
    return 'This message could not be displayed. WhatsApp did not provide the content via the Business API. Ask the customer to resend as text, photo, or document.';
  }

  /**
   * Parse an incoming WhatsApp webhook payload and extract message data.
   * Returns { success, skipped, messageData } — does not touch the database.
   */
  processWebhookMessage(webhookData) {
    try {
      const entry = webhookData.entry?.[0];
      const value = entry?.changes?.[0]?.value;

      if (!value?.messages?.length) {
        return { success: true, skipped: true };
      }

      const message = value.messages[0];
      const contact = value.contacts?.[0];

      const messageData = {
        platformId: message.id,
        from: message.from,
        timestamp: new Date(parseInt(message.timestamp, 10) * 1000),
        type: message.type,
        contact: {
          name: contact?.profile?.name || message.from,
          wa_id: contact?.wa_id || message.from
        }
      };

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
          messageData.content = `[Contact: ${message.contacts?.[0]?.name?.formatted_name || 'Unknown'}]`;
          messageData.contacts = message.contacts;
          break;
        case 'sticker':
          messageData.content = '[Sticker]';
          messageData.mediaId = message.sticker?.id;
          messageData.mediaType = 'sticker';
          break;
        case 'reaction':
          messageData.content = `[Reaction: ${message.reaction?.emoji || ''}]`;
          messageData.reactionEmoji = message.reaction?.emoji;
          messageData.reactedToMessageId = message.reaction?.message_id;
          break;
        case 'button':
          messageData.content = message.button?.text || '[Button reply]';
          messageData.buttonPayload = message.button?.payload;
          break;
        case 'interactive':
          messageData.content = message.interactive?.button_reply?.title
            || message.interactive?.list_reply?.title
            || '[Interactive reply]';
          break;
        case 'order':
          messageData.content = message.order?.text?.trim() || '[Product order]';
          messageData.order = message.order;
          break;
        case 'unsupported':
          messageData.content = this._formatUnsupportedMessage(message);
          messageData.isUnsupported = true;
          if (message.errors?.length) {
            messageData.unsupportedErrors = message.errors;
          }
          break;
        default:
          messageData.content = `[Unsupported message type: ${message.type}]`;
          messageData.isUnsupported = true;
      }

      return { success: true, messageData };
    } catch (error) {
      console.error('[WhatsApp] Error processing webhook:', error);
      throw error;
    }
  }

  /**
   * Build an Interaction document from parsed message data + connection context.
   *
   * @deprecated This produces a per-message Interaction (platformId = wamid), which
   * creates a new conversation row for every inbound message. For webhook handling,
   * thread messages by `dm_<phoneNumberId>_<senderNumber>` and push each message into
   * `metadata.incomingMessages` (see controllers/webhookController.js::handleWhatsAppWebhook
   * and jobs/processWebhook.js::handleWhatsAppWebhook). Kept only for backward
   * compatibility with any non-webhook callers.
   */
  transformToInteraction(messageData, platformConnection, organization) {
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

    if (messageData.mediaId) {
      interaction.metadata = {
        mediaId: messageData.mediaId,
        mediaType: messageData.mediaType,
        hasMedia: true
      };
    }

    if (messageData.location) {
      interaction.metadata = { ...interaction.metadata, location: messageData.location };
    }

    return interaction;
  }

  // ---------------------------------------------------------------------------
  // Business profile & templates
  // ---------------------------------------------------------------------------

  /**
   * @param {Object} connection
   */
  async getBusinessProfile(connection) {
    const phoneNumberId = this._phoneNumberId(connection);
    try {
      const response = await axios.get(
        `${this.apiURL}/${phoneNumberId}/whatsapp_business_profile`,
        {
          params: { fields: 'about,address,description,email,profile_picture_url,websites,vertical' },
          headers: this._authHeader(connection),
          timeout: 10000
        }
      );
      const body = response.data || {};
      let profile = {};
      if (Array.isArray(body.data)) profile = body.data[0] || {};
      else if (body.data && typeof body.data === 'object' && !Array.isArray(body.data)) profile = body.data;
      else if (typeof body.profile_picture_url === 'string') profile = body;
      return { success: true, profile };
    } catch (error) {
      console.error('[WhatsApp] Failed to get business profile:', error.response?.data || error.message);
      return { success: false, profile: {} };
    }
  }

  /**
   * Fetch WhatsApp Business profile from Meta and persist profile picture + profile
   * on the PlatformConnection (for Settings → Platforms and inbox badges).
   * @param {import('mongoose').Document} connection  PlatformConnection mongoose doc
   * @returns {Promise<boolean>} true if a profile_picture_url was saved
   */
  async applyProfilePictureToConnection(connection) {
    if (!connection || !this._accessToken(connection) || !this._phoneNumberId(connection)) {
      return false;
    }
    const { success, profile } = await this.getBusinessProfile(connection);
    if (!success || !profile) return false;

    const url = profile.profile_picture_url || null;
    if (!connection.platformData) connection.platformData = {};
    connection.platformData.businessProfile = {
      ...(connection.platformData.businessProfile || {}),
      ...profile
    };
    connection.markModified('platformData');

    if (url) {
      connection.platformProfilePicture = url;
      if (!connection.metadata) connection.metadata = {};
      connection.metadata.profilePicture = url;
      connection.markModified('metadata');
    }

    if (typeof connection.save === 'function') {
      await connection.save();
    }

    const orgId = connection.organization;
    const connId = connection._id;
    const threadPic =
      url ||
      connection.platformProfilePicture ||
      connection.metadata?.profilePicture ||
      null;
    if (orgId && connId && threadPic) {
      try {
        await Interaction.updateMany(
          { organization: orgId, platform: 'whatsapp', platformConnection: connId },
          { $set: { 'metadata.whatsappBusinessAvatarUrl': threadPic } }
        );
      } catch (e) {
        console.warn('[WhatsApp] Could not backfill thread avatar metadata:', e.message);
      }
    }

    return !!url;
  }

  /**
   * @param {Object} connection
   * @param {Object} profileData
   */
  async updateBusinessProfile(connection, profileData) {
    const phoneNumberId = this._phoneNumberId(connection);
    try {
      const response = await axios.post(
        `${this.apiURL}/${phoneNumberId}/whatsapp_business_profile`,
        { messaging_product: 'whatsapp', ...profileData },
        { headers: this._jsonHeaders(connection), timeout: 10000 }
      );
      return { success: true, data: response.data };
    } catch (error) {
      console.error('[WhatsApp] Failed to update business profile:', error.response?.data || error.message);
      throw new Error('Failed to update business profile');
    }
  }

  /**
   * @param {Object} connection
   */
  async getMessageTemplates(connection) {
    const wabaId = connection?.platformData?.wabaId
      || connection?.platformData?.businessAccountId
      || process.env.WHATSAPP_BUSINESS_ACCOUNT_ID;

    if (!wabaId) throw new Error('WhatsApp Business Account ID not available on this connection');

    try {
      const response = await axios.get(
        `${this.apiURL}/${wabaId}/message_templates`,
        { headers: this._authHeader(connection), timeout: 10000 }
      );
      return { success: true, templates: response.data.data };
    } catch (error) {
      console.error('[WhatsApp] Failed to get templates:', error.response?.data || error.message);
      throw new Error('Failed to get message templates');
    }
  }
}

module.exports = new WhatsAppService();
