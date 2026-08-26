const axios = require('axios');
const crypto = require('crypto');
const PlatformConnection = require('../../models/PlatformConnection');
const whatsappService = require('./whatsappService');

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
 * WABA discovery (Embedded Signup): Meta documents reading WABA IDs from debug_token
 * granular_scopes (whatsapp_business_management → target_ids), then loading phone_numbers per WABA.
 * /me/businesses typically needs business_management; we try it after token-based discovery.
 *
 * Auth host:     https://www.facebook.com/dialog/oauth (or /v{version}/dialog/oauth)
 * Token URL:     https://graph.facebook.com/oauth/access_token
 * Graph API:     https://graph.facebook.com/v23.0
 * Scopes:        whatsapp_business_management, whatsapp_business_messaging, catalog_management
 *
 * Embedded Signup configuration (App Dashboard → WhatsApp → Embedded Signup):
 *   META_WHATSAPP_CONFIG_ID  Same numeric id as `config_id` in Meta’s onboarding URL, e.g.
 *   https://business.facebook.com/messaging/whatsapp/onboard/?app_id=…&config_id=…
 *   Facebook Login must pass `config_id` so users get that onboarding experience; the redirect
 *   still returns `code` to WHATSAPP_CALLBACK_URL for server-side exchange.
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
    if (!userId || !organizationId) {
      throw new Error(
        `Cannot generate WhatsApp OAuth state: userId=${userId}, organizationId=${organizationId}`
      );
    }
    const data = {
      userId: String(userId),
      organizationId: String(organizationId),
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

    const configId =
      process.env.META_WHATSAPP_CONFIG_ID ||
      process.env.WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID;

    const state = this.generateState(userId, organizationId);
    const redirectUri = this.getRedirectURI();

    const params = new URLSearchParams({
      client_id: appId,
      redirect_uri: redirectUri,
      scope: [
        'whatsapp_business_management',
        'whatsapp_business_messaging',
        'catalog_management'
      ].join(','),
      response_type: 'code',
      state
    });

    if (configId) {
      params.set('config_id', String(configId).trim());
    }

    const dialogVersion =
      process.env.META_WHATSAPP_OAUTH_DIALOG_VERSION ||
      process.env.FACEBOOK_OAUTH_DIALOG_VERSION;
    const trimmedVer = dialogVersion ? String(dialogVersion).trim() : '';
    const versionPath =
      trimmedVer && !/^\d+\.\d+/.test(trimmedVer)
        ? trimmedVer.startsWith('v')
          ? trimmedVer
          : `v${trimmedVer}`
        : trimmedVer
          ? `v${trimmedVer}`
          : '';
    const dialogBase = versionPath
      ? `https://www.facebook.com/${versionPath}/dialog/oauth`
      : this.authURL;

    return `${dialogBase}?${params.toString()}`;
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
   * WABA IDs granted to this app on the user token (Embedded Signup).
   * @see https://developers.facebook.com/docs/whatsapp/embedded-signup/manage-accounts
   */
  async getWabaIdsFromDebugToken(userAccessToken) {
    const appId = process.env.META_APP_ID;
    const appSecret = process.env.META_APP_SECRET;
    if (!appId || !appSecret) return [];

    const { data } = await axios.get(`${this.graphURL}/debug_token`, {
      params: {
        input_token: userAccessToken,
        access_token: `${appId}|${appSecret}`
      },
      timeout: 10000
    });

    const granular = data?.data?.granular_scopes;
    if (!Array.isArray(granular)) return [];

    const ids = [];
    for (const g of granular) {
      if (g.scope === 'whatsapp_business_management' && Array.isArray(g.target_ids)) {
        ids.push(...g.target_ids.map(String));
      }
    }
    return [...new Set(ids)];
  }

  /**
   * Load display data + phone_numbers for each WABA id.
   */
  async expandWabasToPhoneRows(wabaIds, accessToken) {
    const rows = [];

    for (const wabaId of wabaIds) {
      try {
        const [wabaMeta, phonesRes] = await Promise.all([
          axios.get(`${this.graphURL}/${wabaId}`, {
            params: { fields: 'id,name,timezone_id', access_token: accessToken },
            timeout: 10000
          }),
          axios.get(`${this.graphURL}/${wabaId}/phone_numbers`, {
            params: {
              fields: 'id,display_phone_number,verified_name,quality_rating,code_verification_status',
              access_token: accessToken
            },
            timeout: 10000
          })
        ]);

        const wabaName = wabaMeta.data?.name || '';
        const phones = phonesRes.data?.data || [];

        for (const phone of phones) {
          rows.push({
            wabaId,
            wabaName,
            phoneNumberId: phone.id,
            displayPhoneNumber: phone.display_phone_number,
            verifiedName: phone.verified_name,
            qualityRating: phone.quality_rating,
            codeVerificationStatus: phone.code_verification_status
          });
        }
      } catch (err) {
        console.warn(
          `[WhatsAppLogin] Failed to expand WABA ${wabaId}:`,
          err.response?.data?.error?.message || err.message
        );
      }
    }

    return rows;
  }

  /**
   * User-assigned WABAs (Graph edge documented for BSP / WhatsApp tooling).
   */
  async getPhoneNumbersFromAssignedAccounts(accessToken) {
    const assignedFields =
      'id,name,business_id,phone_numbers{id,display_phone_number,verified_name,quality_rating,code_verification_status}';
    const rows = [];
    let after;

    while (true) {
      const params = {
        fields: assignedFields,
        limit: 100,
        access_token: accessToken
      };
      if (after) params.after = after;

      const response = await axios.get(`${this.graphURL}/me/assigned_whatsapp_business_accounts`, {
        params,
        timeout: 10000
      });

      for (const waba of response.data?.data || []) {
        const wabaId = waba.id;
        const wabaName = waba.name;
        const businessId = waba.business_id;
        const phones = waba.phone_numbers?.data || waba.phone_numbers || [];

        for (const phone of phones) {
          rows.push({
            wabaId,
            wabaName,
            businessId,
            phoneNumberId: phone.id,
            displayPhoneNumber: phone.display_phone_number,
            verifiedName: phone.verified_name,
            qualityRating: phone.quality_rating,
            codeVerificationStatus: phone.code_verification_status
          });
        }
      }

      const nextAfter = response.data?.paging?.cursors?.after;
      if (!nextAfter) break;
      after = nextAfter;
    }

    return rows;
  }

  phoneNumbersFromBusinessesEdge(responseData) {
    const phoneNumbers = [];
    for (const business of responseData?.data || []) {
      for (const waba of business.whatsapp_business_accounts?.data || []) {
        for (const phone of waba.phone_numbers?.data || []) {
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
    return phoneNumbers;
  }

  /**
   * Fetch all WABAs the user has admin access to, with their phone numbers.
   * Returns a flat list of phone number objects, each including wabaId.
   */
  async getWhatsAppAccounts(accessToken) {
    /** @type {{ message?: string, data?: object } | null} */
    let lastGraphError = null;

    const recordErr = err => {
      const e = err?.response?.data?.error;
      lastGraphError = e ? { message: e.message, code: e.code, subcode: e.error_subcode } : null;
    };

    // 1) Embedded Signup — WABA IDs on the token via debug_token, then phone_numbers per WABA
    try {
      const wabaIds = await this.getWabaIdsFromDebugToken(accessToken);
      if (wabaIds.length > 0) {
        console.log('[WhatsAppLogin] debug_token reports', wabaIds.length, 'WABA id(s), loading phone numbers');
        const fromDebug = await this.expandWabasToPhoneRows(wabaIds, accessToken);
        if (fromDebug.length > 0) return fromDebug;
        console.warn(
          '[WhatsAppLogin] WABA IDs present on token but no phone_numbers yet — onboarding may still be completing (certificate / registration). Trying other discovery methods.'
        );
      }
    } catch (err) {
      recordErr(err);
      console.warn('[WhatsAppLogin] debug_token discovery failed:', err.response?.data || err.message);
    }

    // 2) Assigned accounts edge (/me)
    try {
      const assigned = await this.getPhoneNumbersFromAssignedAccounts(accessToken);
      if (assigned.length > 0) return assigned;
    } catch (err) {
      recordErr(err);
      console.warn(
        '[WhatsAppLogin] /me/assigned_whatsapp_business_accounts failed:',
        err.response?.data?.error?.message || err.message
      );
    }

    // 3) Business portfolio — usually requires business_management on the token
    try {
      const response = await axios.get(`${this.graphURL}/me/businesses`, {
        params: {
          fields:
            'id,name,whatsapp_business_accounts{id,name,timezone_id,phone_numbers{id,display_phone_number,verified_name,quality_rating,code_verification_status}}',
          access_token: accessToken
        },
        timeout: 10000
      });

      const fromBusinesses = this.phoneNumbersFromBusinessesEdge(response.data);
      if (fromBusinesses.length > 0) return fromBusinesses;
    } catch (err) {
      recordErr(err);
      console.warn('[WhatsAppLogin] /me/businesses failed:', err.response?.data?.error?.message || err.message);
    }

    // 4) Legacy /me/whatsapp_business_accounts
    try {
      const response = await axios.get(`${this.graphURL}/me/whatsapp_business_accounts`, {
        params: {
          fields:
            'id,name,phone_numbers{id,display_phone_number,verified_name,quality_rating,code_verification_status}',
          access_token: accessToken
        },
        timeout: 10000
      });

      const phoneNumbers = [];
      for (const waba of response.data?.data || []) {
        for (const phone of waba.phone_numbers?.data || []) {
          phoneNumbers.push({
            wabaId: waba.id,
            wabaName: waba.name,
            phoneNumberId: phone.id,
            displayPhoneNumber: phone.display_phone_number,
            verifiedName: phone.verified_name,
            qualityRating: phone.quality_rating,
            codeVerificationStatus: phone.code_verification_status
          });
        }
      }
      if (phoneNumbers.length > 0) return phoneNumbers;
    } catch (err) {
      recordErr(err);
      console.error('[WhatsAppLogin] /me/whatsapp_business_accounts failed:', err.response?.data || err.message);
    }

    if (lastGraphError?.message) {
      console.error('[WhatsAppLogin] Last Graph error detail:', lastGraphError);
    }

    throw new Error(
      'No WhatsApp phone numbers found after Embedded Signup. Complete the Meta signup flow until your number ' +
        'is registered for the API, reconnect, and confirm you granted WhatsApp permissions. ' +
        'If your portfolio uses Business Manager listings only, request `business_management` on the OAuth app ' +
        'and add it to WhatsApp Login scopes.'
    );
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
   * Register a phone number for WhatsApp Cloud API.
   *
   * This MUST be called after Embedded Signup OTP to move the number from
   * "Pending" to "Active". Without it the number can never receive messages.
   *
   * @see https://developers.facebook.com/docs/whatsapp/cloud-api/reference/phone-numbers#register-phone
   *
   * @param {string} phoneNumberId  - Meta phone number ID (platformUserId / platformData.phoneNumberId)
   * @param {string} accessToken    - Long-lived user or system-user token
   * @param {string} [pin='000000'] - 6-digit registration PIN (can be arbitrary; stored by Meta)
   * @returns {Promise<boolean>}    - true if registered / already registered
   */
  async registerPhoneNumber(phoneNumberId, accessToken, pin = '000000') {
    try {
      const resp = await axios.post(
        `${this.graphURL}/${phoneNumberId}/register`,
        { messaging_product: 'whatsapp', pin },
        {
          headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
          timeout: 15000
        }
      );
      if (resp.data?.success) {
        console.log(`[WhatsAppLogin] Phone ${phoneNumberId} registered successfully`);
        return true;
      }
      console.warn(`[WhatsAppLogin] Register phone unexpected response for ${phoneNumberId}:`, resp.data);
      return false;
    } catch (err) {
      const d = err.response?.data?.error;
      const msg = d?.message || err.message;
      const code = d?.code;
      // Code 80007 = already registered — treat as success
      if (code === 80007 || msg?.includes('already registered')) {
        console.log(`[WhatsAppLogin] Phone ${phoneNumberId} is already registered — skipping`);
        return true;
      }
      console.warn(`[WhatsAppLogin] Could not register phone ${phoneNumberId}: ${msg}`);
      return false;
    }
  }

  /**
   * Subscribe the WABA to webhook delivery for the Meta app.
   * Uses the user token (or system user token if available).
   */
  async subscribeToWebhook(wabaId, accessToken) {
    try {
      const response = await axios.post(
        `${this.graphURL}/${wabaId}/subscribed_apps`,
        { subscribed_fields: 'messages' },
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
  /**
   * Persist a WhatsApp connection from the embedded-signup flow.
   *
   * @param {object} [options]
   * @param {'meta'|'interakt'} [options.provider='meta'] which transport carries this
   *        connection's API calls (see PlatformConnection.platformData.provider)
   * @param {string} [options.connectionType='whatsapp_embedded_signup']
   */
  async saveConnection(userId, organizationId, accessToken, expiresIn, phoneNumberData, options = {}) {
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

    const provider = options.provider === 'interakt' ? 'interakt' : 'meta';
    const connectionType =
      options.connectionType ||
      (provider === 'interakt' ? 'whatsapp_interakt_signup' : 'whatsapp_embedded_signup');

    const existing = await PlatformConnection.findOne({
      organization: organizationId,
      platform: 'whatsapp',
      platformUserId: phoneNumberId
    });

    if (existing) {
      console.log(`[WhatsAppLogin] Updating connection for ${displayPhoneNumber}`);
      existing.accessToken = accessToken;
      // Schema path is `tokenExpiry`. This used to write `tokenExpiresAt`, which is
      // not a declared path and was therefore stripped on save — leaving WhatsApp
      // connections with no expiry tracking at all while the 60-day token lapsed.
      existing.tokenExpiry = new Date(Date.now() + expiresIn * 1000);
      existing.status = 'connected';
      existing.isActive = true;
      existing.lastSyncAt = new Date();
      existing.platformDisplayName = verifiedName || displayPhoneNumber;
      if (!existing.platformData) existing.platformData = {};
      existing.platformData.wabaId = wabaId;
      // Write both keys: readers across the codebase check `wabaId` first and fall
      // back to `businessAccountId`. Keeping them in sync stops the fallback chain
      // from ever reaching the shared env WABA.
      existing.platformData.businessAccountId = wabaId;
      existing.platformData.wabaName = wabaName;
      existing.platformData.businessId = businessId;
      existing.platformData.phoneNumberId = phoneNumberId;
      existing.platformData.displayPhoneNumber = displayPhoneNumber;
      existing.platformData.verifiedName = verifiedName;
      existing.platformData.qualityRating = qualityRating;
      existing.platformData.codeVerificationStatus = codeVerificationStatus;
      existing.platformData.provider = provider;
      existing.markModified('platformData');
      if (!existing.metadata) existing.metadata = {};
      existing.metadata.connectionType = connectionType;
      await existing.save();
      console.log(`[WhatsAppLogin] Updated connection for ${displayPhoneNumber}`);
      await this.registerPhoneNumber(phoneNumberId, accessToken);
      // Interakt owns the webhook subscription for its numbers and sets
      // override_callback_uri itself (interaktPartnerService.configureWebhook).
      // Subscribing our own app here would fight it for the callback.
      if (provider !== 'interakt') {
        await this.subscribeToWebhook(wabaId, accessToken);
      }
      await whatsappService.applyProfilePictureToConnection(existing).catch((e) =>
        console.warn('[WhatsAppLogin] applyProfilePictureToConnection:', e.message)
      );
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
      organization: organizationId,
      createdBy: userId,
      platform: 'whatsapp',
      platformUserId: phoneNumberId,
      platformDisplayName: verifiedName || displayPhoneNumber,
      accessToken,
      // `tokenExpiry` / `scope` are the declared schema paths. The previous
      // `tokenExpiresAt` / `scopes` (and a `user` field that does not exist on the
      // schema at all) were silently dropped by Mongoose strict mode.
      tokenExpiry: new Date(Date.now() + expiresIn * 1000),
      scope: ['whatsapp_business_management', 'whatsapp_business_messaging'],
      status: 'connected',
      isActive: true,
      platformData: {
        wabaId,
        businessAccountId: wabaId,   // keep both keys in sync — see update branch above
        wabaName,
        businessId,
        phoneNumberId,
        displayPhoneNumber,
        verifiedName,
        qualityRating,
        codeVerificationStatus,
        provider
      },
      metadata: {
        connectionType
      }
    });

    const platformConnectionService = require('../../services/platformConnectionService');
    await platformConnectionService.incrementConnectionCount(organizationId);

    console.log(`[WhatsAppLogin] Connection saved for ${displayPhoneNumber}`);
    await this.registerPhoneNumber(phoneNumberId, accessToken);
    // See note in the update branch above — Interakt manages its own subscription.
    if (provider !== 'interakt') {
      await this.subscribeToWebhook(wabaId, accessToken);
    }
    await whatsappService.applyProfilePictureToConnection(connection).catch((e) =>
      console.warn('[WhatsAppLogin] applyProfilePictureToConnection:', e.message)
    );
    return connection;
  }

  /**
   * Resolve the WABA id that owns this phone number using the user/access token.
   * Fixes stale/wrong platformData.wabaId (e.g. env ID confused with phone id) when
   * debug_token exposes whatsapp_business_management target WABAs.
   */
  async resolveWabaIdForPhoneNumber(accessToken, phoneNumberId) {
    if (!accessToken || !phoneNumberId) return null;
    try {
      const wabaIds = await this.getWabaIdsFromDebugToken(accessToken);
      if (!wabaIds.length) return null;
      const rows = await this.expandWabasToPhoneRows(wabaIds, accessToken);
      const hit = rows.find((r) => String(r.phoneNumberId) === String(phoneNumberId));
      return hit?.wabaId ? String(hit.wabaId) : null;
    } catch (err) {
      console.warn(
        '[WhatsAppLogin] resolveWabaIdForPhoneNumber failed:',
        err.response?.data?.error?.message || err.message
      );
      return null;
    }
  }
}

module.exports = new WhatsAppLoginAuthService();
