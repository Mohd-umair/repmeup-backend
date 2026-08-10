const axios = require('axios');
const Interaction = require('../../models/Interaction');
const { generateChatRef } = require('../../utils/chatRefHelper');

/** Google starRating enum → numeric 1–5 */
const STAR_RATING_MAP = {
  ONE: 1,
  TWO: 2,
  THREE: 3,
  FOUR: 4,
  FIVE: 5,
  STAR_RATING_UNSPECIFIED: null
};

class GoogleService {
  constructor() {
    this.clientId = process.env.GOOGLE_CLIENT_ID;
    this.clientSecret = process.env.GOOGLE_CLIENT_SECRET;
    this.redirectUri = process.env.GOOGLE_REDIRECT_URI || 'http://localhost:3000/api/platforms/google/callback';
    // Account Management API — list GBP accounts
    this.businessProfileApiUrl = 'https://mybusinessaccountmanagement.googleapis.com/v1';
    // Business Information API — list locations
    this.businessInfoApiUrl = 'https://mybusinessbusinessinformation.googleapis.com/v1';
    // My Business API v4 — reviews + reply (correct surface)
    this.reviewsApiUrl = 'https://mybusiness.googleapis.com/v4';
  }

  /**
   * Get OAuth authorization URL
   */
  getAuthorizationUrl(state) {
    const scopes = [
      'https://www.googleapis.com/auth/business.manage',
      'https://www.googleapis.com/auth/userinfo.email',
      'https://www.googleapis.com/auth/userinfo.profile'
    ].join(' ');

    const params = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: this.redirectUri,
      response_type: 'code',
      scope: scopes,
      access_type: 'offline',
      prompt: 'consent',
      state: state
    });

    return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
  }

  /**
   * Exchange authorization code for tokens
   */
  async exchangeCodeForTokens(code) {
    try {
      const response = await axios.post('https://oauth2.googleapis.com/token', {
        client_id: this.clientId,
        client_secret: this.clientSecret,
        code: code,
        grant_type: 'authorization_code',
        redirect_uri: this.redirectUri
      });

      return {
        accessToken: response.data.access_token,
        refreshToken: response.data.refresh_token,
        expiresIn: response.data.expires_in,
        tokenType: response.data.token_type
      };
    } catch (error) {
      const detail = error.response?.data?.error_description || error.message;
      throw new Error(`Failed to exchange code for tokens: ${detail}`);
    }
  }

  /**
   * Refresh access token
   */
  async refreshAccessToken(refreshToken) {
    try {
      const response = await axios.post('https://oauth2.googleapis.com/token', {
        client_id: this.clientId,
        client_secret: this.clientSecret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token'
      });

      return {
        accessToken: response.data.access_token,
        expiresIn: response.data.expires_in
      };
    } catch (error) {
      const detail = error.response?.data?.error_description || error.message;
      throw new Error(`Failed to refresh token: ${detail}`);
    }
  }

  /**
   * Get user info from Google
   */
  async getUserInfo(accessToken) {
    try {
      const response = await axios.get('https://www.googleapis.com/oauth2/v2/userinfo', {
        headers: {
          Authorization: `Bearer ${accessToken}`
        }
      });

      return {
        platformUserId: response.data.id,
        platformEmail: response.data.email,
        platformDisplayName: response.data.name,
        platformProfilePicture: response.data.picture,
        platformUsername: response.data.email.split('@')[0]
      };
    } catch (error) {
      throw new Error(`Failed to get user info: ${error.message}`);
    }
  }

  /**
   * Create a structured Google API error (status + code for controllers).
   */
  _makeApiError(statusCode, message, code) {
    const err = new Error(message);
    err.statusCode = statusCode;
    err.code = code;
    return err;
  }

  /**
   * GET accounts from one host. Returns [] on empty success.
   */
  async _listAccountsFrom(url, accessToken) {
    const response = await axios.get(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
      timeout: 20000
    });
    return response.data.accounts || [];
  }

  /**
   * Pick the most actionable error when multiple account endpoints fail.
   * Prefer quota (429) over dead legacy endpoints (404).
   */
  _pickAccountsError(errors) {
    if (!errors.length) return { statusCode: 500, errorMessage: 'Unknown error' };
    const rank = (status) => {
      if (status === 429) return 0;
      if (status === 403) return 1;
      if (status === 401) return 2;
      if (status === 404) return 9; // legacy/disabled hosts often 404 — least useful
      return 5;
    };
    return [...errors].sort((a, b) => rank(a.statusCode) - rank(b.statusCode))[0];
  }

  /**
   * Get Google Business Profile accounts.
   * Primary: Account Management API.
   * Fallback on quota only: legacy My Business v4 accounts (separate quota pool).
   * Soft-cooldown after 429 so repeated Setup clicks don't burn the minute quota.
   */
  async getAccounts(accessToken) {
    const now = Date.now();
    if (this._accountsCooldownUntil && now < this._accountsCooldownUntil) {
      const waitSec = Math.ceil((this._accountsCooldownUntil - now) / 1000);
      throw this._makeApiError(
        429,
        `Google Business Profile account quota is cooling down. Wait ~${waitSec}s, then try again. ` +
          `If this keeps happening, your GCP project likely has 0 Requests/minute on ` +
          `My Business Account Management API — request GBP API access and a quota increase ` +
          `(Cloud Console → APIs & Services → My Business Account Management API → Quotas).`,
        'GBP_QUOTA_EXCEEDED'
      );
    }

    const primaryUrl = `${this.businessProfileApiUrl}/accounts`;
    const legacyUrl = `${this.reviewsApiUrl}/accounts`;
    const errors = [];

    try {
      const accounts = await this._listAccountsFrom(primaryUrl, accessToken);
      this._accountsCooldownUntil = 0;
      return accounts;
    } catch (error) {
      const statusCode = error.response?.status;
      const errorMessage =
        error.response?.data?.error?.message || error.message;
      errors.push({ statusCode, errorMessage, url: primaryUrl });
      console.warn(`[Google] accounts.list failed on ${primaryUrl}: ${statusCode} ${errorMessage}`);

      // Only try legacy host when primary is quota-limited — not on 403/404.
      if (statusCode === 429) {
        try {
          const accounts = await this._listAccountsFrom(legacyUrl, accessToken);
          this._accountsCooldownUntil = 0;
          return accounts;
        } catch (legacyError) {
          const legacyStatus = legacyError.response?.status;
          const legacyMessage =
            legacyError.response?.data?.error?.message || legacyError.message;
          errors.push({ statusCode: legacyStatus, errorMessage: legacyMessage, url: legacyUrl });
          console.warn(`[Google] accounts.list failed on ${legacyUrl}: ${legacyStatus} ${legacyMessage}`);
        }
      }
    }

    const { statusCode, errorMessage } = this._pickAccountsError(errors);

    if (statusCode === 429) {
      this._accountsCooldownUntil = Date.now() + 60_000;
      throw this._makeApiError(
        429,
        `Google API quota exceeded for Account Management (429). ` +
          `In Cloud Console for this GCP project, open My Business Account Management API → Quotas. ` +
          `If Requests/minute is 0, request GBP API access + quota increase ` +
          `(https://developers.google.com/my-business/content/prereqs). Wait 1 minute before retrying. ` +
          `Detail: ${errorMessage}`,
        'GBP_QUOTA_EXCEEDED'
      );
    }
    if (statusCode === 403) {
      throw this._makeApiError(
        403,
        `Access denied (403): ${errorMessage}. Enable Business Profile APIs and ensure the Google user manages a Business Profile.`,
        'API_ACCESS_DENIED'
      );
    }
    if (statusCode === 404) {
      throw this._makeApiError(
        404,
        `Google Account Management API returned 404. Enable "My Business Account Management API" ` +
          `on the same GCP project as GOOGLE_CLIENT_ID, then retry. Detail: ${errorMessage}`,
        'API_NOT_FOUND'
      );
    }
    throw this._makeApiError(
      statusCode || 500,
      `Failed to get accounts (${statusCode || 'unknown'}): ${errorMessage}`,
      'API_ERROR'
    );
  }

  /**
   * Get locations for an account (paginated).
   * @param {string} accessToken
   * @param {string} accountName - e.g. accounts/123456
   */
  async getLocations(accessToken, accountName) {
    try {
      const accountPath = this._normalizeAccountName(accountName);
      const locations = [];
      let pageToken;

      do {
        const params = {
          readMask: 'name,title,storefrontAddress,phoneNumbers,websiteUri',
          pageSize: 100
        };
        if (pageToken) params.pageToken = pageToken;

        const response = await axios.get(`${this.businessInfoApiUrl}/${accountPath}/locations`, {
          headers: { Authorization: `Bearer ${accessToken}` },
          params
        });

        locations.push(...(response.data.locations || []));
        pageToken = response.data.nextPageToken;
      } while (pageToken);

      return locations;
    } catch (error) {
      const statusCode = error.response?.status;
      const errorMessage = error.response?.data?.error?.message || error.message;

      if (statusCode === 403) {
        throw new Error(`Access denied (403): ${errorMessage}`);
      } else if (statusCode === 429) {
        throw new Error(`Rate limit exceeded (429): ${errorMessage}`);
      } else {
        throw new Error(`Failed to get locations (${statusCode || 'unknown'}): ${errorMessage}`);
      }
    }
  }

  /**
   * Normalize location list for PlatformConnection.platformData.
   * Stores short IDs (compat) + full resource metadata for v4 reviews.
   */
  buildLocationPlatformData(account, locations = []) {
    const accountName = this._normalizeAccountName(account?.name || account);
    const mapped = (locations || []).map((loc) => {
      const locationId = this._extractLocationId(loc.name);
      return {
        id: locationId,
        name: loc.name,
        title: loc.title || locationId
      };
    });

    return {
      accountId: accountName,
      accountName: account?.accountName || accountName,
      locationIds: mapped.map((l) => l.id).filter(Boolean),
      locations: mapped
    };
  }

  mapStarRating(starRating) {
    if (typeof starRating === 'number' && starRating >= 1 && starRating <= 5) return starRating;
    if (typeof starRating === 'string') {
      if (STAR_RATING_MAP[starRating] != null) return STAR_RATING_MAP[starRating];
      const n = parseInt(starRating, 10);
      if (n >= 1 && n <= 5) return n;
    }
    return null;
  }

  /**
   * Build v4 parent: accounts/{accountId}/locations/{locationId}
   */
  _buildReviewsParent(accountId, locationId) {
    const accountNum = this._extractAccountId(accountId);
    const locationNum = this._extractLocationId(locationId);
    if (!accountNum || !locationNum) {
      throw new Error('Missing accountId or locationId for Google reviews API');
    }
    return `accounts/${accountNum}/locations/${locationNum}`;
  }

  _normalizeAccountName(accountId) {
    if (!accountId) return '';
    const s = String(accountId);
    return s.startsWith('accounts/') ? s.split('/').slice(0, 2).join('/') : `accounts/${s}`;
  }

  _extractAccountId(accountId) {
    if (!accountId) return '';
    const s = String(accountId).replace(/^accounts\//, '');
    return s.split('/')[0];
  }

  _extractLocationId(locationRef) {
    if (!locationRef) return '';
    const s = String(locationRef);
    if (s.includes('/locations/')) {
      return s.split('/locations/').pop().split('/')[0];
    }
    return s.replace(/^locations\//, '').split('/')[0];
  }

  _googleApiError(error, fallback) {
    const msg =
      error.response?.data?.error?.message ||
      error.response?.data?.error_description ||
      error.message ||
      fallback;
    return msg;
  }

  /**
   * Fetch all review pages for one location via My Business API v4.
   */
  async fetchReviews(platformConnection, locationId) {
    try {
      const accessToken = await this.ensureValidToken(platformConnection);
      const accountId = platformConnection.platformData?.accountId;
      if (!accountId) {
        throw new Error('Google connection is missing accountId. Reconnect or refresh locations.');
      }

      const parent = this._buildReviewsParent(accountId, locationId);
      const reviews = [];
      let pageToken;

      do {
        const params = {
          pageSize: 50,
          orderBy: 'updateTime desc'
        };
        if (pageToken) params.pageToken = pageToken;

        const response = await axios.get(
          `${this.reviewsApiUrl}/${parent}/reviews`,
          {
            headers: { Authorization: `Bearer ${accessToken}` },
            params
          }
        );

        reviews.push(...(response.data.reviews || []));
        pageToken = response.data.nextPageToken;
      } while (pageToken);

      console.log(`[Google] Found ${reviews.length} reviews for ${parent}`);

      const interactions = [];
      const shortLocationId = this._extractLocationId(locationId);

      for (const review of reviews) {
        try {
          const reviewId = review.reviewId || (review.name ? review.name.split('/').pop() : null);
          if (!reviewId) continue;

          const rating = this.mapStarRating(review.starRating);

          interactions.push({
            organization: platformConnection.organization,
            platformConnection: platformConnection._id,
            platform: 'google',
            type: 'review',
            platformId: reviewId,
            content: review.comment || '',
            contentType: 'text',
            language: null,

            author: {
              platformId: review.reviewer?.profilePhotoUrl || reviewId,
              name: review.reviewer?.displayName || 'Anonymous',
              username: review.reviewer?.displayName || 'Anonymous',
              profileUrl: review.reviewer?.profilePhotoUrl || null,
              avatarUrl: review.reviewer?.profilePhotoUrl || null,
              isVerified: false
            },

            rating,
            reviewDate: review.createTime ? new Date(review.createTime) : new Date(),

            status: 'unread',
            isRead: false,

            platformCreatedAt: review.createTime ? new Date(review.createTime) : new Date(),
            platformUpdatedAt: review.updateTime ? new Date(review.updateTime) : new Date(),

            metadata: {
              reviewId,
              reviewName: review.name || `${parent}/reviews/${reviewId}`,
              reviewReply: review.reviewReply || null,
              starRating: review.starRating,
              rating,
              locationId: shortLocationId,
              accountId: this._normalizeAccountName(accountId),
              reviewsParent: parent
            },

            sentiment: null
          });
        } catch (error) {
          console.error(`[Google] Error processing review:`, error.message);
        }
      }

      if (interactions.length > 0) {
        const orgId = platformConnection.organization;
        const existingIds = new Set(
          (
            await Interaction.find({
              organization: orgId,
              platform: 'google',
              platformId: { $in: interactions.map((i) => i.platformId) }
            })
              .select('platformId')
              .lean()
          ).map((i) => i.platformId)
        );

        const chatRefMap = {};
        for (const interaction of interactions) {
          if (!existingIds.has(interaction.platformId)) {
            chatRefMap[interaction.platformId] = await generateChatRef(orgId).catch(() => ({
              chatNumber: null,
              chatRef: null
            }));
          }
        }

        const bulkOps = interactions.map((interaction) => {
          const { status, isRead, sentiment, ...platformFields } = interaction;
          const ref = chatRefMap[interaction.platformId] || {};
          return {
            updateOne: {
              filter: {
                organization: orgId,
                platform: 'google',
                platformId: interaction.platformId
              },
              update: {
                $set: {
                  ...platformFields,
                  // Keep reply metadata fresh on re-sync
                  'metadata.reviewReply': interaction.metadata.reviewReply,
                  'metadata.rating': interaction.metadata.rating,
                  rating: interaction.rating,
                  content: interaction.content,
                  platformUpdatedAt: interaction.platformUpdatedAt
                },
                $setOnInsert: {
                  status: 'unread',
                  isRead: false,
                  source: 'sync',
                  sentiment: sentiment ?? null,
                  chatNumber: ref.chatNumber ?? null,
                  chatRef: ref.chatRef ?? null
                }
              },
              upsert: true
            }
          };
        });

        await Interaction.bulkWrite(bulkOps, { ordered: false });
      }

      return {
        success: true,
        count: interactions.length,
        interactions
      };
    } catch (error) {
      const detail = this._googleApiError(error, 'Failed to fetch reviews');
      console.error('[Google] Error fetching reviews:', detail);
      throw new Error(`Failed to fetch reviews: ${detail}`);
    }
  }

  /**
   * Fetch all reviews for all locations on the connection
   */
  async fetchAllReviews(platformConnection) {
    try {
      let { platformData } = platformConnection;
      platformData = platformData || {};
      let locationIds = platformData.locationIds || [];

      if (locationIds.length === 0 && platformData.accountId) {
        try {
          console.log('[Google] No locationIds found, fetching locations...');
          const accessToken = await this.ensureValidToken(platformConnection);
          const locations = await this.getLocations(accessToken, platformData.accountId);
          const built = this.buildLocationPlatformData(
            { name: platformData.accountId, accountName: platformData.accountName },
            locations
          );
          locationIds = built.locationIds;
          platformConnection.platformData = {
            ...platformData,
            ...built,
            lastLocationRefresh: new Date()
          };
          await platformConnection.save();
          platformData = platformConnection.platformData;
          console.log(`[Google] Found ${locationIds.length} location(s)`);
        } catch (error) {
          console.error('[Google] Failed to fetch locations during sync:', error.message);
          return {
            success: false,
            count: 0,
            interactions: [],
            error: `No locations found. Please ensure your Google Business Profile has locations set up. Error: ${error.message}`
          };
        }
      }

      if (locationIds.length === 0) {
        return {
          success: false,
          count: 0,
          interactions: [],
          error: 'No Google Business Profile locations found.',
          errorDetails: {
            code: 'NO_LOCATIONS',
            message: 'Your Google account is connected, but no business locations were found.',
            resolution: [
              '1. Visit https://business.google.com/',
              '2. Create or claim your business location',
              '3. Verify your business',
              '4. Click "Refresh Locations" in settings to retry'
            ]
          }
        };
      }

      let totalCount = 0;
      const allInteractions = [];

      for (const locationId of locationIds) {
        try {
          const result = await this.fetchReviews(platformConnection, locationId);
          totalCount += result.count;
          allInteractions.push(...result.interactions);
        } catch (error) {
          console.error(`[Google] Error fetching reviews for location ${locationId}:`, error.message);
        }
      }

      await platformConnection.updateSyncStats(totalCount, true);

      return {
        success: true,
        count: totalCount,
        interactions: allInteractions
      };
    } catch (error) {
      await platformConnection.logError(error);
      throw error;
    }
  }

  /**
   * Reply to a review via My Business API v4.
   * PUT accounts/{a}/locations/{l}/reviews/{r}/reply  { comment }
   */
  async replyToReview(platformConnection, locationId, reviewId, replyText) {
    try {
      const accessToken = await this.ensureValidToken(platformConnection);
      const accountId =
        platformConnection.platformData?.accountId ||
        null;

      // Prefer parent stored on interaction metadata path when caller only has short IDs
      const parent = this._buildReviewsParent(accountId, locationId);
      const cleanReviewId = String(reviewId).split('/').pop();

      const response = await axios.put(
        `${this.reviewsApiUrl}/${parent}/reviews/${cleanReviewId}/reply`,
        { comment: replyText },
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json'
          }
        }
      );

      return {
        success: true,
        reviewReply: response.data,
        platformResponseId: `google-review-${cleanReviewId}`
      };
    } catch (error) {
      const detail = this._googleApiError(error, 'Failed to reply to review');
      throw new Error(`Failed to reply to review: ${detail}`);
    }
  }

  /**
   * Ensure token is valid, refresh if needed
   */
  async ensureValidToken(platformConnection) {
    if (!platformConnection.isTokenExpired()) {
      return platformConnection.accessToken;
    }

    if (!platformConnection.refreshToken) {
      throw new Error('Refresh token not available');
    }

    const { accessToken, expiresIn } = await this.refreshAccessToken(
      platformConnection.refreshToken
    );

    platformConnection.accessToken = accessToken;
    platformConnection.tokenExpiry = new Date(Date.now() + expiresIn * 1000);
    await platformConnection.save();

    return accessToken;
  }
}

module.exports = new GoogleService();
