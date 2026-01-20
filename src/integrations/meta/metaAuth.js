const axios = require('axios');
const PlatformConnection = require('../../models/PlatformConnection');
const crypto = require('crypto');

/**
 * Meta Auth Service
 * Handles OAuth authentication for Facebook and Instagram
 */
class MetaAuthService {
  constructor() {
    this.apiVersion = 'v18.0';
    this.facebookAuthURL = `https://www.facebook.com/${this.apiVersion}/dialog/oauth`;
    this.tokenURL = `https://graph.facebook.com/${this.apiVersion}/oauth/access_token`;
    this.graphURL = `https://graph.facebook.com/${this.apiVersion}`;
  }

  /**
   * Generate state parameter for OAuth (security)
   */
  generateState(userId, organizationId, platform = 'facebook') {
    const stateData = {
      userId,
      organizationId,
      platform,
      timestamp: Date.now(),
      nonce: crypto.randomBytes(16).toString('hex')
    };
    return Buffer.from(JSON.stringify(stateData)).toString('base64');
  }

  /**
   * Verify and decode state parameter
   */
  verifyState(state) {
    try {
      const decoded = JSON.parse(Buffer.from(state, 'base64').toString());
      
      // Check if state is not too old (5 minutes)
      const fiveMinutes = 5 * 60 * 1000;
      if (Date.now() - decoded.timestamp > fiveMinutes) {
        throw new Error('State expired');
      }
      
      return decoded;
    } catch (error) {
      throw new Error('Invalid state parameter');
    }
  }

  /**
   * Generate Facebook OAuth URL
   */
  getFacebookAuthURL(userId, organizationId) {
    const state = this.generateState(userId, organizationId, 'facebook');
    
    const params = new URLSearchParams({
      client_id: process.env.META_APP_ID,
      redirect_uri: process.env.META_CALLBACK_URL,
      state: state,
      scope: [
        'pages_show_list',
        'pages_read_engagement',
        'pages_manage_posts',
        'pages_manage_metadata',
        'pages_read_user_content'
      ].join(','),
      response_type: 'code'
    });

    return `${this.facebookAuthURL}?${params.toString()}`;
  }

  /**
   * Generate Instagram OAuth URL
   */
  getInstagramAuthURL(userId, organizationId) {
    const state = this.generateState(userId, organizationId, 'instagram');
    
    const params = new URLSearchParams({
      client_id: process.env.META_APP_ID,
      redirect_uri: process.env.INSTAGRAM_CALLBACK_URL || process.env.META_CALLBACK_URL,
      state: state,
      scope: [
        'instagram_basic',
        'instagram_manage_comments',
        'instagram_manage_messages',
        'pages_show_list',
        'pages_read_engagement'
      ].join(','),
      response_type: 'code'
    });

    return `${this.facebookAuthURL}?${params.toString()}`;
  }

  /**
   * Exchange authorization code for access token
   */
  async exchangeCodeForToken(code, redirectUri) {
    try {
      const response = await axios.get(this.tokenURL, {
        params: {
          client_id: process.env.META_APP_ID,
          client_secret: process.env.META_APP_SECRET,
          redirect_uri: redirectUri,
          code: code
        }
      });

      return response.data.access_token;
    } catch (error) {
      console.error('Token exchange error:', error.response?.data || error.message);
      throw new Error('Failed to exchange code for token');
    }
  }

  /**
   * Exchange short-lived token for long-lived token (60 days)
   */
  async getLongLivedToken(shortLivedToken) {
    try {
      const response = await axios.get(this.tokenURL, {
        params: {
          grant_type: 'fb_exchange_token',
          client_id: process.env.META_APP_ID,
          client_secret: process.env.META_APP_SECRET,
          fb_exchange_token: shortLivedToken
        }
      });

      return {
        accessToken: response.data.access_token,
        expiresIn: response.data.expires_in || 5184000 // 60 days default
      };
    } catch (error) {
      console.error('Long-lived token error:', error.response?.data || error.message);
      throw new Error('Failed to get long-lived token');
    }
  }

  /**
   * Get user's Facebook pages
   */
  async getUserPages(accessToken) {
    try {
      const response = await axios.get(`${this.graphURL}/me/accounts`, {
        params: {
          access_token: accessToken,
          fields: 'id,name,access_token,instagram_business_account{id,username,profile_picture_url}'
        }
      });

      return response.data.data || [];
    } catch (error) {
      console.error('Get pages error:', error.response?.data || error.message);
      throw new Error('Failed to get user pages');
    }
  }

  /**
   * Get user info
   */
  async getUserInfo(accessToken) {
    try {
      const response = await axios.get(`${this.graphURL}/me`, {
        params: {
          access_token: accessToken,
          fields: 'id,name,email,picture'
        }
      });

      return response.data;
    } catch (error) {
      console.error('Get user info error:', error.response?.data || error.message);
      throw new Error('Failed to get user info');
    }
  }

  /**
   * Verify access token
   */
  async verifyAccessToken(accessToken) {
    try {
      const response = await axios.get(`${this.graphURL}/debug_token`, {
        params: {
          input_token: accessToken,
          access_token: `${process.env.META_APP_ID}|${process.env.META_APP_SECRET}`
        }
      });

      return response.data.data;
    } catch (error) {
      console.error('Token verification error:', error.response?.data || error.message);
      return null;
    }
  }

  /**
   * Save Facebook connection to database
   */
  async saveFacebookConnection(userId, organizationId, pageData, pageAccessToken) {
    try {
      // Check if connection already exists
      const existingConnection = await PlatformConnection.findOne({
        organization: organizationId,
        platform: 'facebook',
        platformPageId: pageData.id
      });

      if (existingConnection) {
        // Update existing connection
        existingConnection.accessToken = pageAccessToken;
        existingConnection.tokenExpiresAt = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000);
        existingConnection.status = 'connected';
        existingConnection.isActive = true;
        existingConnection.lastSyncAt = new Date();
        await existingConnection.save();
        return existingConnection;
      }

      // Create new connection
      const connection = await PlatformConnection.create({
        user: userId,
        organization: organizationId,
        platform: 'facebook',
        platformUserId: pageData.id,
        platformUsername: pageData.name,
        platformDisplayName: pageData.name,
        platformEmail: null,
        platformPageId: pageData.id,
        accessToken: pageAccessToken,
        refreshToken: null,
        tokenExpiresAt: new Date(Date.now() + 60 * 24 * 60 * 60 * 1000), // 60 days
        scopes: ['pages_show_list', 'pages_read_engagement', 'pages_manage_posts'],
        status: 'connected',
        isActive: true,
        metadata: {
          instagramAccountId: pageData.instagram_business_account?.id || null,
          instagramUsername: pageData.instagram_business_account?.username || null
        }
      });

      console.log(`Facebook connection saved for page: ${pageData.name}`);
      return connection;
    } catch (error) {
      console.error('Save Facebook connection error:', error);
      throw new Error('Failed to save Facebook connection');
    }
  }

  /**
   * Save Instagram connection to database
   */
  async saveInstagramConnection(userId, organizationId, pageData, pageAccessToken) {
    try {
      const instagramAccount = pageData.instagram_business_account;
      
      if (!instagramAccount) {
        throw new Error('No Instagram Business Account linked to this page');
      }

      // Check if connection already exists
      const existingConnection = await PlatformConnection.findOne({
        organization: organizationId,
        platform: 'instagram',
        platformUserId: instagramAccount.id
      });

      if (existingConnection) {
        // Update existing connection
        existingConnection.accessToken = pageAccessToken;
        existingConnection.tokenExpiresAt = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000);
        existingConnection.status = 'connected';
        existingConnection.isActive = true;
        existingConnection.lastSyncAt = new Date();
        await existingConnection.save();
        return existingConnection;
      }

      // Create new connection
      const connection = await PlatformConnection.create({
        user: userId,
        organization: organizationId,
        platform: 'instagram',
        platformUserId: instagramAccount.id,
        platformUsername: instagramAccount.username,
        platformDisplayName: instagramAccount.username,
        platformEmail: null,
        platformPageId: pageData.id, // Facebook Page ID
        accessToken: pageAccessToken,
        refreshToken: null,
        tokenExpiresAt: new Date(Date.now() + 60 * 24 * 60 * 60 * 1000),
        scopes: ['instagram_basic', 'instagram_manage_comments', 'pages_show_list'],
        status: 'connected',
        isActive: true,
        metadata: {
          facebookPageId: pageData.id,
          facebookPageName: pageData.name,
          profilePicture: instagramAccount.profile_picture_url
        }
      });

      console.log(`Instagram connection saved for account: ${instagramAccount.username}`);
      return connection;
    } catch (error) {
      console.error('Save Instagram connection error:', error);
      throw error;
    }
  }

  /**
   * Refresh access token (if needed before expiry)
   */
  async refreshAccessToken(platformConnection) {
    try {
      // Meta long-lived tokens last 60 days, so we check expiry
      const daysUntilExpiry = Math.floor(
        (platformConnection.tokenExpiresAt - Date.now()) / (1000 * 60 * 60 * 24)
      );

      // If less than 7 days until expiry, get a new token
      if (daysUntilExpiry < 7) {
        const tokenData = await this.getLongLivedToken(platformConnection.accessToken);
        
        platformConnection.accessToken = tokenData.accessToken;
        platformConnection.tokenExpiresAt = new Date(Date.now() + tokenData.expiresIn * 1000);
        await platformConnection.save();
        
        console.log(`Refreshed token for ${platformConnection.platform} connection`);
      }

      return platformConnection;
    } catch (error) {
      console.error('Token refresh error:', error);
      throw error;
    }
  }
}

module.exports = new MetaAuthService();

