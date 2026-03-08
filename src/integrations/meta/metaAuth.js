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
      if (!state) {
        console.error('❌ [MetaAuth] State parameter is missing');
        throw new Error('State parameter is missing');
      }

      // Decode base64
      let decoded;
      try {
        const decodedString = Buffer.from(state, 'base64').toString('utf-8');
        decoded = JSON.parse(decodedString);
      } catch (decodeError) {
        console.error('❌ [MetaAuth] Failed to decode state:', decodeError.message);
        console.error('❌ [MetaAuth] State value received:', state);
        throw new Error('State parameter is not valid base64 or JSON');
      }

      // Validate required fields
      if (!decoded.userId || !decoded.organizationId) {
        console.error('❌ [MetaAuth] State missing required fields:', decoded);
        throw new Error('State parameter missing required fields');
      }

      // Check if state is not too old (5 minutes)
      const fiveMinutes = 5 * 60 * 1000;
      if (Date.now() - decoded.timestamp > fiveMinutes) {
        console.error('❌ [MetaAuth] State expired. Age:', Date.now() - decoded.timestamp, 'ms');
        throw new Error('State expired. Please try connecting again.');
      }

      console.log('✅ [MetaAuth] State verified successfully:', {
        userId: decoded.userId,
        organizationId: decoded.organizationId,
        platform: decoded.platform,
        age: Date.now() - decoded.timestamp
      });

      return decoded;
    } catch (error) {
      // Re-throw with original message if it's already a specific error
      if (error.message && error.message !== 'Invalid state parameter') {
        throw error;
      }
      console.error('❌ [MetaAuth] State verification failed:', error.message);
      throw new Error(`Invalid state parameter: ${error.message}`);
    }
  }

  /**
   * Get Facebook redirect URI (helper method to ensure consistency)
   */
  getFacebookRedirectURI() {
    const redirectUri = process.env.META_CALLBACK_URL ||
      process.env.FACEBOOK_CALLBACK_URL ||
      `${process.env.FRONTEND_URL}/api/auth/facebook/callback`;

    if (!redirectUri) {
      throw new Error('Meta callback URL not configured. Please set META_CALLBACK_URL, FACEBOOK_CALLBACK_URL, or FRONTEND_URL in your environment variables.');
    }

    return redirectUri;
  }

  /**
   * Generate Facebook OAuth URL
   * Uses auth_type=reauthorize + display=page to ask Meta to re-prompt for permissions.
   * If the consent screen still does not show (e.g. app Admin/Tester in Development mode), the user must
   * revoke our app first: Facebook → Settings → Apps and Websites → [App] → Remove, then connect again.
   */
  getFacebookAuthURL(userId, organizationId, options = {}) {
    // Check for app ID - try multiple environment variable names
    const appId = process.env.META_APP_ID ||
      process.env.FACEBOOK_APP_ID ||
      process.env.INSTAGRAM_APP_ID;

    if (!appId) {
      throw new Error('Meta App ID not configured. Please set META_APP_ID, FACEBOOK_APP_ID, or INSTAGRAM_APP_ID in your environment variables.');
    }

    const state = this.generateState(userId, organizationId, 'facebook');
    console.log('🔗 [Facebook] Generated state for OAuth:', {
      userId,
      organizationId,
      stateLength: state.length,
      statePreview: state.substring(0, 20) + '...'
    });

    const redirectUri = this.getFacebookRedirectURI();
    console.log('🔗 [Facebook] OAuth redirect URI:', redirectUri);

    const params = new URLSearchParams({
      client_id: appId,
      redirect_uri: redirectUri,
      state: state,
      scope: [
        'pages_show_list',
        'pages_read_engagement',
        'pages_read_user_content',
        'pages_manage_engagement',
        'business_management',   // Required when Pages are linked to a Facebook Business Account
        'instagram_basic',      // Required so GET /me/accounts returns instagram_business_account for linked Pages
        'instagram_manage_comments'  // Required to reply to Instagram comments from the app
      ].join(','),
      response_type: 'code',
      auth_type: 'reauthorize',
      display: 'page'
    });

    const authUrl = `${this.facebookAuthURL}?${params.toString()}`;
    console.log('🔗 [Facebook] Generated OAuth URL (auth_type=reauthorize, display=page)');

    return authUrl;
  }

  /**
   * Generate Instagram OAuth URL
   * Uses auth_type=reauthorize + display=page to ask Meta to re-prompt for permissions.
   * If the consent screen still does not show (e.g. app Admin/Tester in Development mode), the user must
   * revoke our app first: Facebook → Settings → Apps and Websites → [App] → Remove, then connect again.
   */
  getInstagramAuthURL(userId, organizationId, options = {}) {
    // Check for app ID - try multiple environment variable names
    const appId = process.env.META_APP_ID ||
      process.env.INSTAGRAM_APP_ID ||
      process.env.FACEBOOK_APP_ID;

    if (!appId) {
      throw new Error('Meta App ID not configured. Please set META_APP_ID, INSTAGRAM_APP_ID, or FACEBOOK_APP_ID in your environment variables.');
    }

    const state = this.generateState(userId, organizationId, 'instagram');

    const redirectUri = process.env.INSTAGRAM_CALLBACK_URL ||
      process.env.META_CALLBACK_URL ||
      `${process.env.FRONTEND_URL}/api/auth/instagram/callback`;

    if (!redirectUri) {
      throw new Error('Instagram callback URL not configured. Please set INSTAGRAM_CALLBACK_URL or META_CALLBACK_URL in your environment variables.');
    }

    const params = new URLSearchParams({
      client_id: appId,
      redirect_uri: redirectUri,
      state: state,
      scope: [
        'instagram_basic',
        'instagram_manage_comments',
        'instagram_manage_messages',
        'instagram_content_publish',  // Create and publish posts to Instagram
        'pages_show_list',
        'pages_read_engagement',
        'business_management'  // Required when Pages are linked to a Facebook Business Account
      ].join(','),
      response_type: 'code',
      auth_type: 'reauthorize',
      display: 'page'
    });

    console.log('🔗 [Instagram] OAuth URL (auth_type=reauthorize, display=page)');
    return `${this.facebookAuthURL}?${params.toString()}`;
  }

  /**
   * Exchange authorization code for access token
   */
  async exchangeCodeForToken(code, redirectUri) {
    try {
      const appId = process.env.META_APP_ID ||
        process.env.INSTAGRAM_APP_ID ||
        process.env.FACEBOOK_APP_ID;
      const appSecret = process.env.META_APP_SECRET ||
        process.env.INSTAGRAM_APP_SECRET ||
        process.env.FACEBOOK_APP_SECRET;

      if (!appId || !appSecret) {
        throw new Error('Meta App ID or Secret not configured. Please check your environment variables.');
      }

      console.log('🔄 [Token Exchange] Exchanging code for token:', {
        redirectUri: redirectUri,
        codeLength: code?.length || 0,
        appIdPreview: appId?.substring(0, 10) + '...'
      });

      const response = await axios.get(this.tokenURL, {
        params: {
          client_id: appId,
          client_secret: appSecret,
          redirect_uri: redirectUri,
          code: code
        }
      });

      console.log('✅ [Token Exchange] Successfully exchanged code for token');
      return response.data.access_token;
    } catch (error) {
      console.error('❌ [Token Exchange] Error:', error.response?.data || error.message);
      if (error.response?.data?.error) {
        console.error('❌ [Token Exchange] Error details:', {
          message: error.response.data.error.message,
          type: error.response.data.error.type,
          code: error.response.data.error.code,
          redirectUri: redirectUri
        });
      }
      throw new Error('Failed to exchange code for token');
    }
  }

  /**
   * Exchange short-lived token for long-lived token (60 days)
   */
  async getLongLivedToken(shortLivedToken) {
    try {
      const appId = process.env.META_APP_ID ||
        process.env.INSTAGRAM_APP_ID ||
        process.env.FACEBOOK_APP_ID;
      const appSecret = process.env.META_APP_SECRET ||
        process.env.INSTAGRAM_APP_SECRET ||
        process.env.FACEBOOK_APP_SECRET;

      if (!appId || !appSecret) {
        throw new Error('Meta App ID or Secret not configured. Please check your environment variables.');
      }

      const response = await axios.get(this.tokenURL, {
        params: {
          grant_type: 'fb_exchange_token',
          client_id: appId,
          client_secret: appSecret,
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
   * Requires pages_show_list (and business_management when Pages are in a Business Account).
   */
  async getUserPages(accessToken) {
    try {
      console.log('📄 [Meta] Fetching user pages from Facebook API...');

      const response = await axios.get(`${this.graphURL}/me/accounts`, {
        params: {
          access_token: accessToken,
          fields: 'id,name,access_token,picture,instagram_business_account{id,username,profile_picture_url}'
        }
      });

      const pages = response.data.data || [];
      console.log(`📄 [Meta] Found ${pages.length} pages`);
      if (pages.length === 0) {
        // Log token scopes to help debug "no pages" (e.g. missing business_management for Business-linked Pages)
        try {
          const debug = await this.verifyAccessToken(accessToken);
          if (debug && debug.scopes) {
            console.log('📄 [Meta] Token scopes:', debug.scopes.join(', '));
          }
        } catch (e) {
          // ignore
        }
      }
      return pages;
    } catch (error) {
      console.error('❌ [Meta] Get pages error:', error.response?.data || error.message);

      // Return detailed error message
      const apiError = error.response?.data?.error;
      if (apiError) {
        const errorMsg = `Facebook API Error: ${apiError.message} (Code: ${apiError.code}, Type: ${apiError.type})`;
        console.error('API Error Details:', apiError);
        throw new Error(errorMsg);
      }

      throw new Error(`Failed to get user pages: ${error.message}`);
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
   * Verify access token. Tries each configured Meta app (META, INSTAGRAM, FACEBOOK) so that
   * tokens issued by any of them can be verified (fixes "App_id in the input_token did not match the Viewing App").
   */
  async verifyAccessToken(accessToken) {
    if (!accessToken) return null;
    const appCreds = [
      [process.env.META_APP_ID, process.env.META_APP_SECRET],
      [process.env.INSTAGRAM_APP_ID, process.env.INSTAGRAM_APP_SECRET],
      [process.env.FACEBOOK_APP_ID, process.env.FACEBOOK_APP_SECRET]
    ].filter(([id, secret]) => id && secret);

    if (appCreds.length === 0) {
      console.error('Token verification: no Meta app ID/Secret configured (META_*, INSTAGRAM_*, or FACEBOOK_*).');
      return null;
    }

    for (let i = 0; i < appCreds.length; i++) {
      const [appId, appSecret] = appCreds[i];
      try {
        const response = await axios.get(`${this.graphURL}/debug_token`, {
          params: {
            input_token: accessToken,
            access_token: `${appId}|${appSecret}`
          },
          timeout: 5000
        });
        const data = response.data?.data;
        if (data && data.is_valid !== false) return data;
        if (response.data?.error?.code === 100 && response.data?.error?.message?.includes('Viewing App')) continue;
        return data || null;
      } catch (error) {
        const code = error.response?.data?.error?.code;
        const msg = (error.response?.data?.error?.message || '').toString();
        if (code === 100 && msg.includes('Viewing App')) continue;
        if (i === appCreds.length - 1) {
          console.error('Token verification error:', error.response?.data || error.message);
          if (code === 190) {
            console.warn('[Meta] Code 190 = invalid app credentials or app not found. Ensure META_APP_ID/SECRET (or INSTAGRAM_*/FACEBOOK_*) match the app where you connected Instagram and where the webhook is subscribed.');
          }
        }
      }
    }
    return null;
  }

  /**
   * Save Facebook user-level connection (for accessing /me/accounts)
   */
  async saveFacebookUserConnection(userId, organizationId, userAccessToken, userInfo) {
    try {
      // Save or update a special "user-level" connection
      const existingConnection = await PlatformConnection.findOne({
        organization: organizationId,
        platform: 'facebook',
        platformUserId: userInfo.id,
        platformPageId: null // User-level connection has no pageId
      });

      if (existingConnection) {
        existingConnection.accessToken = userAccessToken;
        existingConnection.tokenExpiresAt = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000);
        existingConnection.status = 'connected';
        existingConnection.isActive = true;
        existingConnection.usesAccountSlot = false; // User-level token does not count toward plan limit
        // Ensure metadata is set (might be missing on old connections)
        existingConnection.metadata = {
          ...existingConnection.metadata,
          type: 'user_token',
          purpose: 'page_management'
        };
        await existingConnection.save();
        console.log(`✅ [Meta] Updated Facebook user-level connection for: ${userInfo.name}`);
        return existingConnection;
      }

      const connection = await PlatformConnection.create({
        organization: organizationId,
        createdBy: userId,
        platform: 'facebook',
        platformUserId: userInfo.id,
        platformUsername: userInfo.name,
        platformDisplayName: userInfo.name,
        platformEmail: userInfo.email,
        platformPageId: null, // User-level connection
        accessToken: userAccessToken,
        tokenExpiresAt: new Date(Date.now() + 60 * 24 * 60 * 60 * 1000),
        scopes: ['pages_show_list', 'pages_read_engagement'],
        status: 'connected',
        isActive: true,
        usesAccountSlot: false, // User-level token does not count toward plan limit
        metadata: {
          type: 'user_token', // Mark this as a user-level token
          purpose: 'page_management'
        }
      });

      console.log(`✅ [Meta] Created Facebook user-level connection for: ${userInfo.name}`);
      return connection;
    } catch (error) {
      console.error('❌ [Meta] Save Facebook user connection error:', error);
      throw error;
    }
  }

  /**
   * Save Facebook page connection to database
   */
  async saveFacebookConnection(userId, organizationId, pageData, pageAccessToken) {
    try {
      // Check if connection already exists (using platformUserId to match unique index)
      const existingConnection = await PlatformConnection.findOne({
        organization: organizationId,
        platform: 'facebook',
        platformUserId: pageData.id
      });

      if (existingConnection) {
        // Update existing connection
        existingConnection.accessToken = pageAccessToken;
        existingConnection.tokenExpiresAt = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000);
        existingConnection.status = 'connected';
        existingConnection.isActive = true;
        existingConnection.lastSyncAt = new Date();
        existingConnection.platformPageId = pageData.id; // Ensure platformPageId is set
        const pagePictureUrl = pageData.picture?.data?.url || (typeof pageData.picture === 'string' ? pageData.picture : null) || null;
        if (pagePictureUrl) {
          existingConnection.platformProfilePicture = pagePictureUrl;
          if (!existingConnection.metadata) existingConnection.metadata = {};
          existingConnection.metadata.profilePicture = pagePictureUrl;
        }
        await existingConnection.save();
        return existingConnection;
      }

      // Create new connection
      const pagePictureUrl = pageData.picture?.data?.url || (typeof pageData.picture === 'string' ? pageData.picture : null) || null;
      const connection = await PlatformConnection.create({
        user: userId,
        organization: organizationId,
        createdBy: userId, // Required field - set to the user creating the connection
        platform: 'facebook',
        platformUserId: pageData.id,
        platformUsername: pageData.name,
        platformDisplayName: pageData.name,
        platformEmail: null,
        platformPageId: pageData.id,
        platformProfilePicture: pagePictureUrl,
        accessToken: pageAccessToken,
        refreshToken: null,
        tokenExpiresAt: new Date(Date.now() + 60 * 24 * 60 * 60 * 1000), // 60 days
        scopes: ['pages_show_list', 'pages_read_engagement'],
        status: 'connected',
        isActive: true,
        metadata: {
          instagramAccountId: pageData.instagram_business_account?.id || null,
          instagramUsername: pageData.instagram_business_account?.username || null,
          profilePicture: pagePictureUrl
        }
      });

      // Increment usage counter (SOLID: Dependency Inversion - depend on service, not direct model manipulation)
      const platformConnectionService = require('../../services/platformConnectionService');
      await platformConnectionService.incrementConnectionCount(organizationId);

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
        console.log(`🔄 [MetaAuth] Updating existing Instagram connection for: ${instagramAccount.username}`);
        existingConnection.accessToken = pageAccessToken;
        existingConnection.tokenExpiresAt = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000);
        existingConnection.status = 'connected';
        existingConnection.isActive = true;
        existingConnection.lastSyncAt = new Date();
        existingConnection.platformPageId = pageData.id; // Required for Send API (thread owner)
        // Ensure platformData is set
        if (!existingConnection.platformData) {
          existingConnection.platformData = {};
        }
        existingConnection.platformData.businessAccountId = instagramAccount.id;
        existingConnection.platformData.pageId = pageData.id;
        existingConnection.platformData.pageName = pageData.name;
        if (instagramAccount.profile_picture_url) {
          existingConnection.platformProfilePicture = instagramAccount.profile_picture_url;
          if (!existingConnection.metadata) existingConnection.metadata = {};
          existingConnection.metadata.profilePicture = instagramAccount.profile_picture_url;
        }
        await existingConnection.save();
        console.log(`✅ [MetaAuth] Updated existing Instagram connection for: ${instagramAccount.username}`);
        return existingConnection;
      }

      // Create new connection
      console.log(`💾 [MetaAuth] Creating new Instagram connection for: ${instagramAccount.username}`);
      console.log(`💾 [MetaAuth] User ID: ${userId}, Organization ID: ${organizationId}`);
      console.log(`💾 [MetaAuth] Instagram Account ID: ${instagramAccount.id}`);
      console.log(`💾 [MetaAuth] Facebook Page ID: ${pageData.id}`);
      const connection = await PlatformConnection.create({
        user: userId,
        organization: organizationId,
        createdBy: userId, // Required field - set to the user creating the connection
        platform: 'instagram',
        platformUserId: instagramAccount.id,
        platformUsername: instagramAccount.username,
        platformDisplayName: instagramAccount.username,
        platformEmail: null,
        platformPageId: pageData.id, // Facebook Page ID
        platformProfilePicture: instagramAccount.profile_picture_url || null,
        accessToken: pageAccessToken,
        refreshToken: null,
        tokenExpiresAt: new Date(Date.now() + 60 * 24 * 60 * 60 * 1000),
        scopes: ['instagram_basic', 'instagram_manage_comments', 'pages_show_list'],
        status: 'connected',
        isActive: true,
        platformData: {
          businessAccountId: instagramAccount.id, // Store for API calls
          pageId: pageData.id, // Facebook Page ID
          pageName: pageData.name
        },
        metadata: {
          facebookPageId: pageData.id,
          facebookPageName: pageData.name,
          profilePicture: instagramAccount.profile_picture_url
        }
      });

      // Increment usage counter (SOLID: Dependency Inversion)
      const platformConnectionService = require('../../services/platformConnectionService');
      await platformConnectionService.incrementConnectionCount(organizationId);

      console.log(`✅ [MetaAuth] Instagram connection saved for account: ${instagramAccount.username}`);
      return connection;
    } catch (error) {
      console.error('❌ [MetaAuth] Save Instagram connection error:', error.message);
      console.error('❌ [MetaAuth] Full error:', error);
      if (error.name === 'ValidationError') {
        console.error('❌ [MetaAuth] Validation errors:', error.errors);
      }
      if (error.code === 11000) {
        console.error('❌ [MetaAuth] Duplicate key error - connection may already exist');
      }
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

