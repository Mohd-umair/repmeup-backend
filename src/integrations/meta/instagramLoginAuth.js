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
   * Subscribes using the app-scoped ISUID (what the token is valid for);
   * the resolvedId (global IG Business Account ID) is stored separately.
   */
  /**
   * Unsubscribe an Instagram account from app webhooks.
   * Must be called when the user disconnects the account so Meta stops
   * delivering events for it. Silently ignores errors (expired token, etc.)
   * since the DB record will be deactivated regardless.
   */
  async unsubscribeFromWebhook(igUserId, accessToken) {
    try {
      const response = await axios.delete(
        `${this.graphURL}/${igUserId}/subscribed_apps`,
        {
          params: { access_token: accessToken },
          timeout: 8000
        }
      );
      if (response.data?.success) {
        console.log(`[InstagramLogin] IG account ${igUserId} unsubscribed from webhooks`);
      } else {
        console.warn(`[InstagramLogin] Unexpected unsubscribe response for ${igUserId}:`, response.data);
      }
    } catch (err) {
      const msg = err.response?.data?.error?.message || err.message;
      console.warn(`[InstagramLogin] Could not unsubscribe IG ${igUserId} from webhooks (token may have expired): ${msg}`);
    }
  }

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
   * Persist an Instagram Login connection to the database.
   *
   * Key design:
   *  - graph.instagram.com/me returns the app-scoped Instagram User ID (ISUID).
   *    There is no API available with an IGAA token that resolves ISUID → global
   *    IG Business Account ID. DB lookups are unreliable (prior corrupted state).
   *  - We store the ISUID as platformUserId AND as metadata.igLoginScopedId.
   *    Both fields start with the same value.
   *  - On the FIRST webhook, handleInstagramLoginWebhook self-heals the connection:
   *    it updates platformUserId to the real global ID while igLoginScopedId keeps
   *    the ISUID. After healing, platformUserId ≠ igLoginScopedId, so the $expr
   *    discriminator in the webhook handler won't re-match this connection again.
   */
  async saveConnection(userId, organizationId, accessToken, expiresIn, userInfo) {
    const igAppScopedId = String(userInfo.id);
    const igUsername = userInfo.username;
    const accountType = (userInfo.account_type || 'business').toLowerCase();
    const scopes = [
      'instagram_business_basic',
      'instagram_business_content_publish',
      'instagram_business_manage_messages',
      'instagram_business_manage_comments'
    ];

    // Find any existing Instagram Login connection for this account.
    // Match by ISUID in platformUserId OR igLoginScopedId (handles re-connect
    // after a previous self-heal where platformUserId was already updated to
    // the global ID).
    const existing = await PlatformConnection.findOne({
      organization: organizationId,
      platform: 'instagram',
      $or: [
        { platformUserId: igAppScopedId },
        { 'metadata.igLoginScopedId': igAppScopedId }
      ]
    });

    if (existing) {
      console.log(`[InstagramLogin] Updating connection for @${igUsername} (ISUID: ${igAppScopedId})`);
      existing.accessToken = accessToken;
      existing.tokenExpiresAt = new Date(Date.now() + expiresIn * 1000);
      existing.status = 'connected';
      existing.isActive = true;
      existing.lastSyncAt = new Date();
      // Reset to ISUID so self-healing can run again on next webhook
      existing.platformUserId = igAppScopedId;
      existing.platformPageId = igAppScopedId;
      existing.scopes = scopes;
      if (userInfo.profile_picture_url) existing.platformProfilePicture = userInfo.profile_picture_url;
      if (!existing.metadata) existing.metadata = {};
      existing.metadata.connectionType = 'instagram_login';
      existing.metadata.accountType = accountType;
      existing.metadata.igLoginScopedId = igAppScopedId;
      if (!existing.platformData) existing.platformData = {};
      existing.platformData.businessAccountId = igAppScopedId;
      await existing.save();
      console.log(`[InstagramLogin] Updated connection for @${igUsername}`);
      await this.subscribeToWebhook(igAppScopedId, accessToken);
      return existing;
    }

    // Cross-org conflict check
    const crossOrgConflict = await PlatformConnection.findCrossOrgConflict(
      'instagram', igAppScopedId, organizationId
    );
    if (crossOrgConflict) {
      const err = new Error('This Instagram account is already connected to another workspace.');
      err.code = 'CROSS_ORG_CONFLICT';
      throw err;
    }

    console.log(`[InstagramLogin] Creating new connection for @${igUsername} (ISUID: ${igAppScopedId})`);
    const connection = await PlatformConnection.create({
      user: userId,
      organization: organizationId,
      createdBy: userId,
      platform: 'instagram',
      platformUserId: igAppScopedId,
      platformPageId: igAppScopedId,
      platformUsername: igUsername,
      platformDisplayName: userInfo.name || igUsername,
      platformEmail: null,
      platformProfilePicture: userInfo.profile_picture_url || null,
      accessToken,
      refreshToken: null,
      tokenExpiresAt: new Date(Date.now() + expiresIn * 1000),
      scopes,
      status: 'connected',
      isActive: true,
      platformData: {
        businessAccountId: igAppScopedId,
        accountType: (userInfo.account_type || 'BUSINESS').toUpperCase()
      },
      metadata: {
        connectionType: 'instagram_login',
        accountType,
        igLoginScopedId: igAppScopedId,
        profilePicture: userInfo.profile_picture_url
      }
    });

    const platformConnectionService = require('../../services/platformConnectionService');
    await platformConnectionService.incrementConnectionCount(organizationId);

    console.log(`[InstagramLogin] Connection saved for @${igUsername}`);
    await this.subscribeToWebhook(igAppScopedId, accessToken);
    return connection;
  }
}

module.exports = new InstagramLoginAuthService();
