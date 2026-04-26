const axios = require('axios');
const PlatformConnection = require('../../models/PlatformConnection');
const crypto = require('crypto');

/** Meta Graph API error code: application request limit (transient). */
const META_CODE_RATE_LIMIT = 4;

/**
 * Run an async fn; on Meta transient rate limit (code 4), retry with backoff.
 * @param {Function} fn - async () => Promise<T>
 * @param {{ maxRetries?: number, baseMs?: number }} opts - maxRetries default 3, baseMs 1500
 * @returns {Promise<T>}
 */
async function withRetryOnRateLimit(fn, opts = {}) {
  const { maxRetries = 3, baseMs = 1500 } = opts;
  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      const code = err.response?.data?.error?.code;
      const isTransient = err.response?.data?.error?.is_transient === true || code === META_CODE_RATE_LIMIT;
      if (!isTransient || attempt === maxRetries) throw err;
      const delayMs = baseMs * Math.pow(2, attempt);
      console.warn(`[Meta] Rate limit (code ${code}), retry in ${delayMs}ms (attempt ${attempt + 1}/${maxRetries})`);
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
  throw lastError;
}

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
    // Fail fast here so a bad caller doesn't produce a state that only
    // breaks AFTER the user authorizes on Meta and bounces back.
    // JSON.stringify silently drops undefined values.
    if (!userId || !organizationId) {
      throw new Error(
        `Cannot generate Meta OAuth state: userId=${userId}, organizationId=${organizationId}`
      );
    }
    const stateData = {
      userId: String(userId),
      organizationId: String(organizationId),
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
        'public_profile',
        'pages_show_list',
        'pages_read_engagement',
        'pages_manage_posts',
        'pages_manage_engagement',
        'pages_manage_metadata',
        'pages_messaging',
        'business_management',
        'instagram_basic',
        'instagram_manage_comments',
        'instagram_manage_messages',
        'instagram_manage_insights',
        'instagram_content_publish',
        'pages_read_user_content'
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
        'public_profile',
        'instagram_basic',
        'instagram_manage_comments',
        'instagram_manage_messages',
        'instagram_manage_insights',
        'instagram_content_publish',
        'pages_show_list',
        'pages_read_engagement',
        'pages_manage_posts',
        'pages_manage_engagement',
        'pages_manage_metadata',
        'pages_read_user_content',
        'business_management'
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
   * Exchange short-lived token for long-lived token (60 days).
   * Retries on Meta rate limit (code 4) with backoff.
   */
  async getLongLivedToken(shortLivedToken) {
    const appId = process.env.META_APP_ID ||
      process.env.INSTAGRAM_APP_ID ||
      process.env.FACEBOOK_APP_ID;
    const appSecret = process.env.META_APP_SECRET ||
      process.env.INSTAGRAM_APP_SECRET ||
      process.env.FACEBOOK_APP_SECRET;

    if (!appId || !appSecret) {
      throw new Error('Meta App ID or Secret not configured. Please check your environment variables.');
    }

    try {
      return await withRetryOnRateLimit(async () => {
        const response = await axios.get(this.tokenURL, {
          params: {
            grant_type: 'fb_exchange_token',
            client_id: appId,
            client_secret: appSecret,
            fb_exchange_token: shortLivedToken
          },
          timeout: 10000
        });
        return {
          accessToken: response.data.access_token,
          expiresIn: response.data.expires_in || 5184000
        };
      }, { maxRetries: 3, baseMs: 1500 });
    } catch (error) {
      if (error.response?.data?.error?.code === META_CODE_RATE_LIMIT || error.response?.data?.error?.is_transient) {
        throw new Error('Facebook is temporarily limiting requests. Please try again in a few minutes.');
      }
      console.error('Long-lived token error:', error.response?.data || error.message);
      throw new Error('Failed to get long-lived token');
    }
  }

  /**
   * Get user's Facebook pages.
   * Requires pages_show_list (and business_management when Pages are in a Business Account).
   * Retries on Meta rate limit (code 4) with backoff.
   */
  async getUserPages(accessToken) {
    try {
      const pages = await withRetryOnRateLimit(async () => {
        console.log('📄 [Meta] Fetching user pages from Facebook API...');
        const response = await axios.get(`${this.graphURL}/me/accounts`, {
          params: {
            access_token: accessToken,
            fields: 'id,name,access_token,picture,instagram_business_account{id,username,profile_picture_url}'
          },
          timeout: 10000
        });
        return response.data.data || [];
      }, { maxRetries: 3, baseMs: 1500 });

      console.log(`📄 [Meta] Found ${pages.length} pages`);
      // Trigger pages_read_engagement and pages_manage_engagement so Meta shows API test calls (required for App Review / dashboard)
      if (pages.length > 0) {
        const firstPage = pages[0];
        const firstPageId = firstPage.id;
        const pageAccessToken = firstPage.access_token;
        try {
          await axios.get(`${this.graphURL}/${firstPageId}/feed`, {
            params: {
              access_token: accessToken,
              limit: 1,
              fields: 'id'
            },
            timeout: 5000
          });
        } catch (e) {
          if (e.response?.data?.error?.code !== 10) {
            console.warn('[Meta] pages_read_engagement feed call (for API test count):', e.response?.data?.error?.message || e.message);
          }
        }
        // Use PAGE access token so Meta attributes the call to pages_manage_engagement (required for "1 API call" in App Review)
        if (pageAccessToken) {
          try {
            await axios.get(`${this.graphURL}/${firstPageId}/posts`, {
              params: {
                access_token: pageAccessToken,
                limit: 1,
                fields: 'id,comments.summary(true)'
              },
              timeout: 5000
            });
          } catch (e) {
            if (e.response?.data?.error?.code !== 10) {
              console.warn('[Meta] pages_manage_engagement (page token) for API test count:', e.response?.data?.error?.message || e.message);
            }
          }
        }
      }
      if (pages.length === 0) {
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
      const apiError = error.response?.data?.error;
      if (apiError?.code === META_CODE_RATE_LIMIT || apiError?.is_transient) {
        throw new Error('Facebook is temporarily limiting requests. Please try again in a few minutes.');
      }
      console.error('❌ [Meta] Get pages error:', error.response?.data || error.message);
      if (apiError) {
        throw new Error(`Facebook API Error: ${apiError.message} (Code: ${apiError.code})`);
      }
      throw new Error(`Failed to get user pages: ${error.message}`);
    }
  }

  /**
   * Get user info. Retries on Meta rate limit (code 4) with backoff.
   */
  async getUserInfo(accessToken) {
    try {
      return await withRetryOnRateLimit(async () => {
        const response = await axios.get(`${this.graphURL}/me`, {
          params: {
            access_token: accessToken,
            fields: 'id,name,email,picture'
          },
          timeout: 10000
        });
        return response.data;
      }, { maxRetries: 3, baseMs: 1500 });
    } catch (error) {
      const apiError = error.response?.data?.error;
      if (apiError?.code === META_CODE_RATE_LIMIT || apiError?.is_transient) {
        console.warn('[Meta] Get user info rate limited:', apiError?.message);
        const err = new Error('Facebook is temporarily limiting requests. Please try again in a few minutes.');
        err.isRateLimit = true;
        throw err;
      }
      console.error('Get user info error:', error.response?.data || error.message);
      throw new Error('Failed to get user info');
    }
  }

  /**
   * Get minimal user { id, name } from token via debug_token (used when /me is rate limited).
   * Returns null if debug_token fails or rate limited.
   */
  async getMinimalUserFromToken(accessToken) {
    const data = await this.verifyAccessToken(accessToken);
    if (data && data.user_id) {
      return { id: data.user_id, name: 'Facebook User', email: undefined };
    }
    return null;
  }

  /**
   * Verify access token. Tries each configured Meta app (META, INSTAGRAM, FACEBOOK) so that
   * tokens issued by any of them can be verified (fixes "App_id in the input_token did not match the Viewing App").
   */
  async verifyAccessToken(accessToken) {
    if (!accessToken) return null;
    const appCreds = [
      [process.env.META_APP_ID, process.env.META_APP_SECRET],
      [process.env.INSTAGRAM_LOGIN_APP_ID, process.env.INSTAGRAM_LOGIN_APP_SECRET],
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
        scopes: ['pages_show_list', 'pages_read_engagement', 'pages_manage_posts'],
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
        await this.subscribePageToWebhook(pageData.id, pageAccessToken);
        return existingConnection;
      }

      // Cross-org conflict check: block if this page is already active in another workspace
      const crossOrgConflict = await PlatformConnection.findCrossOrgConflict(
        'facebook', pageData.id, organizationId
      );
      if (crossOrgConflict) {
        const err = new Error('This Facebook page is already connected to another workspace.');
        err.code = 'CROSS_ORG_CONFLICT';
        throw err;
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
        scopes: ['pages_show_list', 'pages_read_engagement', 'pages_manage_posts'],
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
      await this.subscribePageToWebhook(pageData.id, pageAccessToken);
      return connection;
    } catch (error) {
      console.error('Save Facebook connection error:', error);
      throw new Error('Failed to save Facebook connection');
    }
  }

  /**
   * Subscribe a Facebook Page to this app's webhook (for Messenger/Page events and feed comments).
   * - messages, standby, etc.: Page DMs (Messenger).
   * - feed: post comments and other feed activity (required for comment webhooks).
   */
  async subscribePageToWebhook(pageId, pageAccessToken) {
    const fields = [
      'messages',
      'messaging_postbacks',
      'message_deliveries',
      'message_echoes',
      'message_reads',
      'messaging_optins',
      'messaging_referrals',
      'standby',
      'messaging_handovers',
      'feed'
    ].join(',');

    try {
      const url = `${this.graphURL}/${pageId}/subscribed_apps`;
      const response = await axios.post(url, null, {
        params: {
          subscribed_fields: fields,
          access_token: pageAccessToken
        }
      });
      if (response.data?.success) {
        console.log(`✅ [MetaAuth] Page ${pageId} subscribed to webhook fields: ${fields}`);
      } else {
        console.warn(`⚠️  [MetaAuth] Page subscription returned unexpected response:`, response.data);
      }
    } catch (err) {
      const msg = err.response?.data?.error?.message || err.message;
      console.warn(`⚠️  [MetaAuth] Could not subscribe page ${pageId} to webhook: ${msg}`);
    }
  }

  /**
   * Subscribe an Instagram Business Account to this app's webhook so Meta
   * delivers Instagram DMs to our Callback URL.
   * Must be called with the Page Access Token after connecting Instagram.
   */
  async subscribeInstagramToWebhook(igUserId, pageAccessToken) {
    const fields = [
      'messages',
      'messaging_seen',
      'messaging_postbacks',
      'standby',
      'message_reactions',
      'comments',
      'mentions'
    ].join(',');

    try {
      const url = `${this.graphURL}/${igUserId}/subscribed_apps`;
      const response = await axios.post(url, null, {
        params: {
          subscribed_fields: fields,
          access_token: pageAccessToken
        }
      });
      if (response.data?.success) {
        console.log(`✅ [MetaAuth] Instagram account ${igUserId} subscribed to webhook fields: ${fields}`);
      } else {
        console.warn(`⚠️  [MetaAuth] Instagram subscription returned unexpected response:`, response.data);
      }
    } catch (err) {
      const msg = err.response?.data?.error?.message || err.message;
      console.warn(`⚠️  [MetaAuth] Could not subscribe Instagram ${igUserId} to webhook (DMs may not arrive): ${msg}`);
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
        existingConnection.scopes = ['instagram_basic', 'instagram_manage_comments', 'instagram_manage_insights', 'instagram_content_publish', 'pages_show_list'];
        await existingConnection.save();
        console.log(`✅ [MetaAuth] Updated existing Instagram connection for: ${instagramAccount.username}`);
        await this.subscribePageToWebhook(pageData.id, pageAccessToken);
        await this.subscribeInstagramToWebhook(instagramAccount.id, pageAccessToken);
        return existingConnection;
      }

      // Cross-org conflict check: block if this IG account is already active in another workspace
      const crossOrgConflict = await PlatformConnection.findCrossOrgConflict(
        'instagram', instagramAccount.id, organizationId
      );
      if (crossOrgConflict) {
        const err = new Error('This Instagram account is already connected to another workspace.');
        err.code = 'CROSS_ORG_CONFLICT';
        throw err;
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
        scopes: ['instagram_basic', 'instagram_manage_comments', 'instagram_manage_insights', 'instagram_content_publish', 'pages_show_list'],
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
      await this.subscribePageToWebhook(pageData.id, pageAccessToken);
      await this.subscribeInstagramToWebhook(instagramAccount.id, pageAccessToken);
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
   * Get redirect URI for the Instagram Direct connect flow.
   * Reads INSTAGRAM_DIRECT_CALLBACK_URL, falls back to INSTAGRAM_CALLBACK_URL.
   */
  getInstagramDirectRedirectURI() {
    const redirectUri =
      process.env.INSTAGRAM_DIRECT_CALLBACK_URL ||
      process.env.INSTAGRAM_CALLBACK_URL ||
      process.env.META_CALLBACK_URL;

    if (!redirectUri) {
      throw new Error(
        'Instagram direct callback URL not configured. Please set INSTAGRAM_DIRECT_CALLBACK_URL in your environment variables.'
      );
    }
    return redirectUri;
  }

  /**
   * Auto-discover and save all Instagram Professional accounts accessible via a Facebook user token.
   * Iterates /me/accounts, finds pages with an instagram_business_account, and saves each as a
   * PlatformConnection with platform = 'instagram'.  Also saves the linked Facebook Page connection.
   *
   * @param {string} userId - ORM user id
   * @param {string} organizationId - ORM organisation id
   * @param {string} accessToken - Long-lived Facebook user access token
   * @param {object} userInfo - { id, name, email } from /me
   * @returns {{ savedCount: number, igAccounts: Array<{ username, pageId }>, errors: string[] }}
   */
  async autoSaveInstagramConnections(userId, organizationId, accessToken, userInfo) {
    const pages = await this.getUserPages(accessToken);
    const pagesWithIg = pages.filter(p => p.instagram_business_account);

    const igAccounts = [];
    const errors = [];

    for (const page of pagesWithIg) {
      const pageAccessToken = page.access_token;
      try {
        // Save the Facebook Page connection so inbox / publish work correctly
        await this.saveFacebookConnection(userId, organizationId, page, pageAccessToken);
      } catch (err) {
        if (err.code !== 'CROSS_ORG_CONFLICT') {
          console.warn(`[InstagramDirect] Could not save Facebook page ${page.name}: ${err.message}`);
        }
      }

      try {
        await this.saveInstagramConnection(userId, organizationId, page, pageAccessToken);
        igAccounts.push({
          username: page.instagram_business_account.username,
          pageId: page.id,
          pageName: page.name
        });
      } catch (err) {
        if (err.code === 'CROSS_ORG_CONFLICT') {
          errors.push(`Instagram account @${page.instagram_business_account.username} is already connected to another workspace.`);
        } else {
          console.error(`[InstagramDirect] Failed to save IG account for page ${page.name}:`, err.message);
          errors.push(`Could not connect @${page.instagram_business_account.username || page.name}: ${err.message}`);
        }
      }
    }

    console.log(`[InstagramDirect] Saved ${igAccounts.length}/${pagesWithIg.length} Instagram account(s) for org ${organizationId}`);
    return { savedCount: igAccounts.length, igAccounts, errors };
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

