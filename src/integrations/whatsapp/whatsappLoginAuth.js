const axios = require('axios');
const crypto = require('crypto');
const PlatformConnection = require('../../models/PlatformConnection');

/**
 * WhatsApp Business Embedded Signup Auth Service
 * Implements multi-tenant WhatsApp via Meta's Embedded Signup OAuth flow.
 * https://developers.facebook.com/docs/whatsapp/embedded-signup
 *
 * Flow:
 *  1. User clicks "Connect WhatsApp" → backend returns Embedded Signup URL.
 *  2. User completes Meta OAuth → Meta redirects to WHATSAPP_CALLBACK_URL with `code`.
 *  3. Backend exchanges code for a long-lived user access token.
 *  4. Backend fetches the user's WhatsApp Business Accounts (WABAs) and phone numbers.
 *  5. PlatformConnection is saved per phone number (per org).
 *  6. Backend subscribes the WABA to app webhooks.
 *
 * Auth host:     https://www.facebook.com/dialog/oauth
 * Token URL:     https://graph.facebook.com/oauth/access_token
 * Graph API:     https://graph.facebook.com/v23.0
 * Scopes:        whatsapp_business_management, whatsapp_business_messaging
 */
class WhatsAppLoginAuthService {
  constructor() {
    this.apiVersion = 'v23.0';
    this.authURL = 'https://www.facebook.com/dialog/oauth';
    this.tokenURL = `https://graph.facebook.com/oauth/access_token`;
    this.graphURL = `https://graph.facebook.com/${this.apiVersion}`;
  }

  // ---------------------------------------------------------------------------
  // State helpers — same base64-JSON pattern as instagramLoginAuth.js
  // ---------------------------------------------------------------------------

  generateState(userId, organizationId) {
    const data = {
      userId,
      organizationId,
      platform: 'whatsapp',
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

    // 10-minute window (Embedded Signup can take longer than IG Login)
    if (Date.now() - decoded.timestamp > 10 * 60 * 1000) {
      throw new Error('State expired. Please try connecting again.');
    }

    return decoded;
  }

  // ---------------------------------------------------------------------------
  // Redirect URI
  // ---------------------------------------------------------------------------

  getRedirectURI() {
    const uri = process.env.WHATSAPP_CALLBACK_URL;
    if (!uri) {
      throw new Error(
        'WHATSAPP_CALLBACK_URL is not configured. ' +
        'Add it to .env and register it in Meta Developer Console > WhatsApp > Configuration > Embedded Signup.'
      );
    }
    return uri;
  }

  // ---------------------------------------------------------------------------
  // OAuth URL — Embedded Signup
  // ---------------------------------------------------------------------------

  /**
   * Build the Meta Embedded Signup OAuth URL.
   * The frontend opens this URL in a popup or redirect.
   */
  getAuthURL(userId, organizationId) {
    const appId = process.env.META_APP_ID;
    if (!appId) throw new Error('META_APP_ID is not configured.');

    const state = this.generateState(userId, organizationId);
    const redirectUri = this.getRedirectURI();

    const params = new URLSearchParams({
      client_id: appId,
      redirect_uri: redirectUri,
      scope: [
        'whatsapp_business_management',
        'whatsapp_business_messaging'
      ].join(','),
      response_type: 'code',
      state,
      // Embedded Signup extras — configure your solution in the Meta App Dashboard
      // extras: JSON.stringify({ setup: {} })
    });

    return `${this.authURL}?${params.toString()}`;
  }

  // ---------------------------------------------------------------------------
  // Token exchange
  // ---------------------------------------------------------------------------

  /**
   * Exchange authorization code for a short-lived user access token.
   */
  async exchangeCode(code) {
    const appId = process.env.META_APP_ID;
    const appSecret = process.env.META_APP_SECRET;
    if (!appId || !appSecret) throw new Error('META_APP_ID or META_APP_SECRET not configured.');

    try {
      const response = await axios.get(this.tokenURL, {
        params: {
          client_id: appId,
          client_secret: appSecret,
          redirect_uri: this.getRedirectURI(),
          code
        },
        timeout: 10000
      });

      console.log('[WhatsAppLogin] Short-lived token obtained');
      return response.data.access_token;
    } catch (error) {
      console.error('[WhatsAppLogin] Token exchange error:', error.response?.data || error.message);
      throw new Error('Failed to exchange WhatsApp authorization code for token');
    }
  }

  /**
   * Exchange short-lived user token for a long-lived token (~60 days).
   * For production, consider migrating to a System User token via the API.
   */
  async getLongLivedToken(shortToken) {
    const appId = process.env.META_APP_ID;
    const appSecret = process.env.META_APP_SECRET;
    if (!appId || !appSecret) throw new Error('META_APP_ID or META_APP_SECRET not configured.');

    try {
      const response = await axios.get(this.tokenURL, {
        params: {
          grant_type: 'fb_exchange_token',
          client_id: appId,
          client_secret: appSecret,
          fb_exchange_token: shortToken
        },
        timeout: 10000
      });

      const expiresIn = response.data.expires_in || 5184000; // default 60 days
      console.log('[WhatsAppLogin] Long-lived token obtained, expires in:', expiresIn, 'seconds');
      return { accessToken: response.data.access_token, expiresIn };
    } catch (error) {
      console.error('[WhatsAppLogin] Long-lived token error:', error.response?.data || error.message);
      throw new Error('Failed to get long-lived WhatsApp token');
    }
  }

  // ---------------------------------------------------------------------------
  // WhatsApp Business Account discovery
  // ---------------------------------------------------------------------------

  /**
   * Fetch all WABAs the user has admin access to, with their phone numbers.
   * Returns a flat list of phone number objects, each including wabaId.
   */
  async getWhatsAppAccounts(accessToken) {
    try {
      // First try: get businesses + whatsapp_business_accounts
      const response = await axios.get(`${this.graphURL}/me/businesses`, {
        params: {
          fields: 'id,name,whatsapp_business_accounts{id,name,timezone_id,phone_numbers{id,display_phone_number,verified_name,quality_rating,code_verification_status}}',
          access_token: accessToken
        },
        timeout: 10000
      });

      const phoneNumbers = [];
      for (const business of (response.data.data || [])) {
        for (const waba of (business.whatsapp_business_accounts?.data || [])) {
          for (const phone of (waba.phone_numbers?.data || [])) {
            phoneNumbers.push({
              wabaId: waba.id,
              wabaName: waba.name,
              businessId: business.id,
              businessName: business.name,
              phoneNumberId: phone.id,
              displayPhoneNumber: phone.display_phone_number,
              verifiedName: phone.verified_name,
              qualityRating: phone.quality_rating,
              codeVerificationStatus: phone.code_verification_status
            });
          }
        }
      }

      if (phoneNumbers.length > 0) return phoneNumbers;
    } catch (err) {
      console.warn('[WhatsAppLogin] /me/businesses failed, trying direct WABA lookup:', err.response?.data?.error?.message || err.message);
    }

    // Fallback: try /me/whatsapp_business_accounts directly (some token types)
    try {
      const response = await axios.get(`${this.graphURL}/me/whatsapp_business_accounts`, {
        params: {
          fields: 'id,name,phone_numbers{id,display_phone_number,verified_name,quality_rating}',
          access_token: accessToken
        },
        timeout: 10000
      });

      const phoneNumbers = [];
      for (const waba of (response.data.data || [])) {
        for (const phone of (waba.phone_numbers?.data || [])) {
          phoneNumbers.push({
            wabaId: waba.id,
            wabaName: waba.name,
            phoneNumberId: phone.id,
            displayPhoneNumber: phone.display_phone_number,
            verifiedName: phone.verified_name,
            qualityRating: phone.quality_rating
          });
        }
      }
      return phoneNumbers;
    } catch (err) {
      console.error('[WhatsAppLogin] WABA discovery failed:', err.response?.data || err.message);
      throw new Error('Failed to discover WhatsApp Business Accounts. Ensure the account has admin access to a WABA.');
    }
  }

  /**
   * Fetch phone numbers directly for a known WABA ID.
   */
  async getPhoneNumbers(wabaId, accessToken) {
    try {
      const response = await axios.get(`${this.graphURL}/${wabaId}/phone_numbers`, {
        params: {
          fields: 'id,display_phone_number,verified_name,quality_rating,code_verification_status',
          access_token: accessToken
        },
        timeout: 10000
      });
      return response.data.data || [];
    } catch (error) {
      console.error('[WhatsAppLogin] Get phone numbers error:', error.response?.data || error.message);
      throw new Error('Failed to fetch WhatsApp phone numbers');
    }
  }

  // ---------------------------------------------------------------------------
  // Webhook subscription
  // ---------------------------------------------------------------------------

  /**
   * Subscribe the WABA to webhook delivery for the Meta app.
   * Uses the user token (or system user token if available).
   */
  async subscribeToWebhook(wabaId, accessToken) {
    try {
      const response = await axios.post(
        `${this.graphURL}/${wabaId}/subscribed_apps`,
        {},
        {
          params: { access_token: accessToken },
          timeout: 10000
        }
      );

      if (response.data.success) {
        console.log(`[WhatsAppLogin] WABA ${wabaId} subscribed to webhooks`);
      } else {
        console.warn(`[WhatsAppLogin] Unexpected webhook subscription response for WABA ${wabaId}:`, response.data);
      }
    } catch (err) {
      const msg = err.response?.data?.error?.message || err.message;
      console.warn(`[WhatsAppLogin] Could not subscribe WABA ${wabaId} to webhook: ${msg}`);
    }
  }

  /**
   * Unsubscribe the WABA from webhook delivery (called on disconnect).
   * Silently ignores errors since the connection will be deactivated anyway.
   */
  async unsubscribeFromWebhook(wabaId, accessToken) {
    try {
      await axios.delete(
        `${this.graphURL}/${wabaId}/subscribed_apps`,
        {
          params: { access_token: accessToken },
          timeout: 10000
        }
      );
      console.log(`[WhatsAppLogin] WABA ${wabaId} unsubscribed from webhooks`);
    } catch (err) {
      const msg = err.response?.data?.error?.message || err.message;
      console.warn(`[WhatsAppLogin] Could not unsubscribe WABA ${wabaId}: ${msg}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Save connection
  // ---------------------------------------------------------------------------

  /**
   * Persist a WhatsApp connection to the database.
   * One PlatformConnection is created per phone number per org.
   *
   * Storage layout:
   *  - platformUserId      = phoneNumberId (routing key for webhooks)
   *  - accessToken         = long-lived user token (or system user token)
   *  - platformData.wabaId = WhatsApp Business Account ID
   *  - platformData.phoneNumberId    = Meta phone number ID
   *  - platformData.displayPhoneNumber
   *  - platformData.verifiedName
   *  - metadata.connectionType = 'whatsapp_embedded_signup'
   */
  async saveConnection(userId, organizationId, accessToken, expiresIn, phoneNumberData) {
    const {
      wabaId,
      wabaName,
      businessId,
      phoneNumberId,
      displayPhoneNumber,
      verifiedName,
      qualityRating,
      codeVerificationStatus
    } = phoneNumberData;

    const existing = await PlatformConnection.findOne({
      organization: organizationId,
      platform: 'whatsapp',
      platformUserId: phoneNumberId
    });

    if (existing) {
      console.log(`[WhatsAppLogin] Updating connection for ${displayPhoneNumber}`);
      existing.accessToken = accessToken;
      existing.tokenExpiresAt = new Date(Date.now() + expiresIn * 1000);
      existing.status = 'connected';
      existing.isActive = true;
      existing.lastSyncAt = new Date();
      existing.platformDisplayName = verifiedName || displayPhoneNumber;
      if (!existing.platformData) existing.platformData = {};
      existing.platformData.wabaId = wabaId;
      existing.platformData.wabaName = wabaName;
      existing.platformData.businessId = businessId;
      existing.platformData.phoneNumberId = phoneNumberId;
      existing.platformData.displayPhoneNumber = displayPhoneNumber;
      existing.platformData.verifiedName = verifiedName;
      existing.platformData.qualityRating = qualityRating;
      existing.platformData.codeVerificationStatus = codeVerificationStatus;
      if (!existing.metadata) existing.metadata = {};
      existing.metadata.connectionType = 'whatsapp_embedded_signup';
      await existing.save();
      console.log(`[WhatsAppLogin] Updated connection for ${displayPhoneNumber}`);
      await this.subscribeToWebhook(wabaId, accessToken);
      return existing;
    }

    // Cross-org conflict — one phone number can only be active in one workspace
    const crossOrgConflict = await PlatformConnection.findCrossOrgConflict(
      'whatsapp', phoneNumberId, organizationId
    );
    if (crossOrgConflict) {
      const err = new Error('This WhatsApp number is already connected to another workspace.');
      err.code = 'CROSS_ORG_CONFLICT';
      throw err;
    }

    console.log(`[WhatsAppLogin] Creating new connection for ${displayPhoneNumber}`);
    const connection = await PlatformConnection.create({
      user: userId,
      organization: organizationId,
      createdBy: userId,
      platform: 'whatsapp',
      platformUserId: phoneNumberId,
      platformDisplayName: verifiedName || displayPhoneNumber,
      accessToken,
      tokenExpiresAt: new Date(Date.now() + expiresIn * 1000),
      scopes: ['whatsapp_business_management', 'whatsapp_business_messaging'],
      status: 'connected',
      isActive: true,
      platformData: {
        wabaId,
        wabaName,
        businessId,
        phoneNumberId,
        displayPhoneNumber,
        verifiedName,
        qualityRating,
        codeVerificationStatus
      },
      metadata: {
        connectionType: 'whatsapp_embedded_signup'
      }
    });

    const platformConnectionService = require('../../services/platformConnectionService');
    await platformConnectionService.incrementConnectionCount(organizationId);

    console.log(`[WhatsAppLogin] Connection saved for ${displayPhoneNumber}`);
    await this.subscribeToWebhook(wabaId, accessToken);
    return connection;
  }
}

module.exports = new WhatsAppLoginAuthService();
