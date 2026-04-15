const axios = require('axios');
const crypto = require('crypto');
const PlatformConnection = require('../../models/PlatformConnection');

/**
 * Instagram Login Auth Service
 * Implements "Instagram API with Instagram Login" — no Facebook account required.
 * https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login
 *
 * Key differences from Facebook Login flow:
 *  - Auth URL:      https://api.instagram.com/oauth/authorize
 *  - Token URL:     https://api.instagram.com/oauth/access_token
 *  - Long-lived:    https://graph.instagram.com/access_token
 *  - Graph API:     https://graph.instagram.com
 *  - No Facebook Page required
 *  - Scopes:        instagram_business_basic, instagram_business_content_publish,
 *                   instagram_business_manage_messages, instagram_business_manage_comments
 */
class InstagramLoginAuthService {
  constructor() {
    this.authURL = 'https://api.instagram.com/oauth/authorize';
    this.tokenURL = 'https://api.instagram.com/oauth/access_token';
    this.graphURL = 'https://graph.instagram.com';
  }

  // ---------------------------------------------------------------------------
  // State helpers (reuse same base64-JSON pattern as metaAuth.js)
  // ---------------------------------------------------------------------------

  generateState(userId, organizationId) {
    const data = {
      userId,
      organizationId,
      platform: 'instagram-login',
      timestamp: Date.now(),
      nonce: crypto.randomBytes(16).toString('hex')
    };
    return Buffer.from(JSON.stringify(data)).toString('base64');
  }

  verifyState(state) {
    if (!state) throw new Error('State parameter is missing');

    let decoded;
    try {
      decoded = JSON.parse(Buffer.from(state, 'base64').toString('utf-8'));
    } catch {
      throw new Error('State parameter is not valid base64 JSON');
    }

    if (!decoded.userId || !decoded.organizationId) {
      throw new Error('State parameter is missing required fields');
    }

    if (Date.now() - decoded.timestamp > 5 * 60 * 1000) {
      throw new Error('State expired. Please try connecting again.');
    }

    return decoded;
  }

  // ---------------------------------------------------------------------------
  // Redirect URI
  // ---------------------------------------------------------------------------

  getRedirectURI() {
    const uri = process.env.INSTAGRAM_LOGIN_CALLBACK_URL;
    if (!uri) {
      throw new Error(
        'INSTAGRAM_LOGIN_CALLBACK_URL is not configured. ' +
        'Add it to .env and register it in Meta Developer Console > Instagram > Settings > Valid OAuth Redirect URIs.'
      );
    }
    return uri;
  }

  // ---------------------------------------------------------------------------
  // OAuth URL
  // ---------------------------------------------------------------------------

  /**
   * Generate the Instagram Login OAuth authorization URL.
   * The user is sent here to log in with their Instagram credentials.
   */
  getAuthURL(userId, organizationId) {
    const appId =
      process.env.INSTAGRAM_LOGIN_APP_ID ||
      process.env.META_APP_ID ||
      process.env.INSTAGRAM_APP_ID ||
      process.env.FACEBOOK_APP_ID;

    if (!appId) {
      throw new Error('Meta App ID not configured. Set META_APP_ID in your environment variables.');
    }

    const state = this.generateState(userId, organizationId);
    const redirectUri = this.getRedirectURI();

    const params = new URLSearchParams({
      client_id: appId,
      redirect_uri: redirectUri,
      scope: [
        'instagram_business_basic',
        'instagram_business_content_publish',
        'instagram_business_manage_messages',
        'instagram_business_manage_comments'
      ].join(','),
      response_type: 'code',
      state
    });

    return `${this.authURL}?${params.toString()}`;
  }

  // ---------------------------------------------------------------------------
  // Token exchange
  // ---------------------------------------------------------------------------

  /**
   * Exchange authorization code for a short-lived access token.
   * POST https://api.instagram.com/oauth/access_token
   */
  async exchangeCode(code, redirectUri) {
    const appId =
      process.env.INSTAGRAM_LOGIN_APP_ID ||
      process.env.META_APP_ID ||
      process.env.INSTAGRAM_APP_ID ||
      process.env.FACEBOOK_APP_ID;
    const appSecret =
      process.env.INSTAGRAM_LOGIN_APP_SECRET ||
      process.env.META_APP_SECRET ||
      process.env.INSTAGRAM_APP_SECRET ||
      process.env.FACEBOOK_APP_SECRET;

    if (!appId || !appSecret) {
      throw new Error('Meta App ID or Secret not configured.');
    }

    try {
      const params = new URLSearchParams({
        client_id: appId,
        client_secret: appSecret,
        grant_type: 'authorization_code',
        redirect_uri: redirectUri,
        code
      });

      const response = await axios.post(this.tokenURL, params.toString(), {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 10000
      });

      console.log('[InstagramLogin] Short-lived token obtained');
      return response.data.access_token;
    } catch (error) {
      console.error('[InstagramLogin] Token exchange error:', error.response?.data || error.message);
      throw new Error('Failed to exchange Instagram authorization code for token');
    }
  }

  /**
   * Exchange short-lived token for a long-lived token (60 days).
   * GET https://graph.instagram.com/access_token
   */
  async getLongLivedToken(shortToken) {
    const appSecret =
      process.env.INSTAGRAM_LOGIN_APP_SECRET ||
      process.env.META_APP_SECRET ||
      process.env.INSTAGRAM_APP_SECRET ||
      process.env.FACEBOOK_APP_SECRET;

    if (!appSecret) {
      throw new Error('Meta App Secret not configured.');
    }

    try {
      const response = await axios.get(`${this.graphURL}/access_token`, {
        params: {
          grant_type: 'ig_exchange_token',
          client_secret: appSecret,
          access_token: shortToken
        },
        timeout: 10000
      });

      console.log('[InstagramLogin] Long-lived token obtained, expires in:', response.data.expires_in, 'seconds');
      return {
        accessToken: response.data.access_token,
        expiresIn: response.data.expires_in || 5184000
      };
    } catch (error) {
      console.error('[InstagramLogin] Long-lived token error:', error.response?.data || error.message);
      throw new Error('Failed to get long-lived Instagram token');
    }
  }

  // ---------------------------------------------------------------------------
  // User info
  // ---------------------------------------------------------------------------

  /**
   * Get the authenticated Instagram user's profile.
   * GET https://graph.instagram.com/me
   */
  async getUserInfo(accessToken) {
    try {
      const response = await axios.get(`${this.graphURL}/me`, {
        params: {
          fields: 'id,username,profile_picture_url,name,account_type',
          access_token: accessToken
        },
        timeout: 10000
      });

      const data = response.data;
      console.log(`[InstagramLogin] User info: @${data.username} (${data.account_type})`);
      return data;
    } catch (error) {
      console.error('[InstagramLogin] Get user info error:', error.response?.data || error.message);
      throw new Error('Failed to get Instagram user info');
    }
  }

  // ---------------------------------------------------------------------------
  // Webhook subscription
  // ---------------------------------------------------------------------------

  /**
   * Subscribe the Instagram account to app webhooks.
   * Uses the user access token (not a page token).
   * Same endpoint as Facebook Login flow: /{ig-user-id}/subscribed_apps
   */
  async subscribeToWebhook(igUserId, accessToken) {
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
      const response = await axios.post(
        `${this.graphURL}/${igUserId}/subscribed_apps`,
        null,
        {
          params: { subscribed_fields: fields, access_token: accessToken },
          timeout: 8000
        }
      );

      if (response.data?.success) {
        console.log(`[InstagramLogin] IG account ${igUserId} subscribed to webhook fields: ${fields}`);
      } else {
        console.warn(`[InstagramLogin] Unexpected webhook subscription response:`, response.data);
      }
    } catch (err) {
      const msg = err.response?.data?.error?.message || err.message;
      console.warn(`[InstagramLogin] Could not subscribe IG ${igUserId} to webhook (DMs may not arrive): ${msg}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Save connection
  // ---------------------------------------------------------------------------

  /**
   * Resolve the "real" Instagram Business Account ID that the webhook system uses.
   *
   * Instagram Login API returns an app-scoped ID (ASID) which is different from the
   * Instagram Business Account ID used in webhook entry.id events. We use the
   * Instagram Business Discovery API (via any connected account's token) to look up
   * the real ID by username.
   *
   * Falls back to the app-scoped ID if lookup fails.
   */
  async resolveRealInstagramId(username, appScopedId) {
    try {
      const PlatformConnection = require('../../models/PlatformConnection');
      // Find any active Instagram connection that can serve as the lookup account
      const helperConn = await PlatformConnection.findOne({
        platform: 'instagram',
        isActive: true,
        status: 'connected',
        // Prefer Facebook Login connections since they have full Graph API access
        'metadata.connectionType': { $ne: 'instagram_login' }
      }).select('accessToken platformData').lean();

      if (!helperConn?.accessToken) {
        console.log(`[InstagramLogin] No helper connection available for ID lookup, using app-scoped ID`);
        return appScopedId;
      }

      const helperAccountId = helperConn.platformData?.businessAccountId;
      if (!helperAccountId) return appScopedId;

      // Use Instagram Business Discovery API to find the real account ID by username
      const resp = await axios.get(`https://graph.facebook.com/v18.0/${helperAccountId}`, {
        params: {
          fields: `business_discovery.fields(id,username)`,
          username,
          access_token: helperConn.accessToken
        },
        timeout: 8000
      });

      const realId = resp.data?.business_discovery?.id;
      if (realId) {
        console.log(`[InstagramLogin] Resolved real Instagram ID for @${username}: ${appScopedId} → ${realId}`);
        return realId;
      }
    } catch (err) {
      console.warn(`[InstagramLogin] Business Discovery lookup failed for @${username}:`, err.response?.data?.error?.message || err.message);
    }
    return appScopedId;
  }

  /**
   * Persist an Instagram Login connection to the database.
   *
   * Important: platformPageId is set equal to platformUserId (the IG account ID)
   * so that the existing processWebhook.js DM routing (which queries by platformPageId)
   * works without any changes.
   */
  async saveConnection(userId, organizationId, accessToken, expiresIn, userInfo) {
    const igAppScopedId = userInfo.id;
    const igUsername = userInfo.username;

    // Resolve the real Instagram Business Account ID (matches webhook entry.id)
    const igUserId = await this.resolveRealInstagramId(igUsername, igAppScopedId);

    // Check for existing connection by username, real ID, or app-scoped ID
    const existing = await PlatformConnection.findOne({
      organization: organizationId,
      platform: 'instagram',
      $or: [
        { platformUsername: igUsername },
        { platformUserId: igUserId },
        { platformUserId: igAppScopedId },
        { 'metadata.igLoginScopedId': igAppScopedId }
      ]
    });

    if (existing) {
      console.log(`[InstagramLogin] Updating existing connection for @${igUsername} (real ID: ${igUserId}, scoped: ${igAppScopedId})`);
      existing.accessToken = accessToken;
      existing.tokenExpiresAt = new Date(Date.now() + expiresIn * 1000);
      existing.status = 'connected';
      existing.isActive = true;
      existing.lastSyncAt = new Date();
      existing.platformUserId = igUserId;
      existing.platformPageId = igUserId;
      if (userInfo.profile_picture_url) {
        existing.platformProfilePicture = userInfo.profile_picture_url;
      }
      if (!existing.metadata) existing.metadata = {};
      existing.metadata.connectionType = 'instagram_login';
      existing.metadata.igLoginScopedId = igAppScopedId;
      if (!existing.platformData) existing.platformData = {};
      existing.platformData.businessAccountId = igUserId;
      existing.scopes = [
        'instagram_business_basic',
        'instagram_business_content_publish',
        'instagram_business_manage_messages',
        'instagram_business_manage_comments'
      ];
      await existing.save();
      console.log(`[InstagramLogin] Updated connection for @${igUsername}`);
      await this.subscribeToWebhook(igUserId, accessToken);
      return existing;
    }

    // Cross-org conflict check
    const crossOrgConflict = await PlatformConnection.findCrossOrgConflict(
      'instagram', igUserId, organizationId
    );
    if (crossOrgConflict) {
      const err = new Error('This Instagram account is already connected to another workspace.');
      err.code = 'CROSS_ORG_CONFLICT';
      throw err;
    }

    // Create new connection
    console.log(`[InstagramLogin] Creating new connection for @${igUsername} (${userInfo.account_type})`);
    const connection = await PlatformConnection.create({
      user: userId,
      organization: organizationId,
      createdBy: userId,
      platform: 'instagram',
      platformUserId: igUserId,
      platformUsername: igUsername,
      platformDisplayName: userInfo.name || igUsername,
      platformEmail: null,
      // Set platformPageId = platformUserId so webhook DM routing works without changes
      platformPageId: igUserId,
      platformProfilePicture: userInfo.profile_picture_url || null,
      accessToken,
      refreshToken: null,
      tokenExpiresAt: new Date(Date.now() + expiresIn * 1000),
      scopes: [
        'instagram_business_basic',
        'instagram_business_content_publish',
        'instagram_business_manage_messages',
        'instagram_business_manage_comments'
      ],
      status: 'connected',
      isActive: true,
      platformData: {
        businessAccountId: igUserId,
        accountType: (userInfo.account_type || 'BUSINESS').toUpperCase()
      },
      metadata: {
        connectionType: 'instagram_login',
        accountType: (userInfo.account_type || 'business').toLowerCase(),
        profilePicture: userInfo.profile_picture_url,
        // Store app-scoped ID so webhook routing can match by either ID
        igLoginScopedId: igAppScopedId
      }
    });

    // Increment usage counter
    const platformConnectionService = require('../../services/platformConnectionService');
    await platformConnectionService.incrementConnectionCount(organizationId);

    console.log(`[InstagramLogin] Connection saved for @${igUsername}`);
    await this.subscribeToWebhook(igUserId, accessToken);
    return connection;
  }
}

module.exports = new InstagramLoginAuthService();
