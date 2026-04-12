const axios = require('axios');
const Interaction = require('../../models/Interaction');
const PlatformConnection = require('../../models/PlatformConnection');
const { generateChatRef } = require('../../utils/chatRefHelper');

class GoogleService {
  constructor() {
    this.clientId = process.env.GOOGLE_CLIENT_ID;
    this.clientSecret = process.env.GOOGLE_CLIENT_SECRET;
    this.redirectUri = process.env.GOOGLE_REDIRECT_URI || 'http://localhost:3000/api/platforms/google/callback';
    this.businessProfileApiUrl = 'https://mybusinessaccountmanagement.googleapis.com/v1';
    this.businessInfoApiUrl = 'https://mybusinessbusinessinformation.googleapis.com/v1';
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
      throw new Error(`Failed to exchange code for tokens: ${error.message}`);
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
      throw new Error(`Failed to refresh token: ${error.message}`);
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
   * Get Google Business Profile accounts
   */
  async getAccounts(accessToken) {
    try {
      const response = await axios.get(`${this.businessProfileApiUrl}/accounts`, {
        headers: {
          Authorization: `Bearer ${accessToken}`
        }
      });

      return response.data.accounts || [];
    } catch (error) {
      // Provide more detailed error information
      const statusCode = error.response?.status;
      const errorMessage = error.response?.data?.error?.message || error.message;
      
      if (statusCode === 403) {
        throw new Error(`Access denied (403): ${errorMessage}. The Google Business Profile API may not be enabled, or the user may not have a Business Profile account.`);
      } else if (statusCode === 429) {
        throw new Error(`Rate limit exceeded (429): ${errorMessage}. Please wait before retrying.`);
      } else if (statusCode === 404) {
        throw new Error(`Not found (404): ${errorMessage}. The API endpoint may be incorrect or the API is not enabled.`);
      } else {
        throw new Error(`Failed to get accounts (${statusCode || 'unknown'}): ${errorMessage}`);
      }
    }
  }

  /**
   * Get locations for an account
   */
  async getLocations(accessToken, accountName) {
    try {
      const response = await axios.get(`${this.businessInfoApiUrl}/${accountName}/locations`, {
        headers: {
          Authorization: `Bearer ${accessToken}`
        },
        params: {
          readMask: 'name,title,storefrontAddress,phoneNumbers,websiteUri'
        }
      });

      return response.data.locations || [];
    } catch (error) {
      // Provide more detailed error information
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
   * Fetch reviews for a location
   */
  async fetchReviews(platformConnection, locationId) {
    try {
      const accessToken = await this.ensureValidToken(platformConnection);
      const locationName = `locations/${locationId}`;

      const response = await axios.get(
        `${this.businessInfoApiUrl}/${locationName}/reviews`,
        {
          headers: {
            Authorization: `Bearer ${accessToken}`
          },
          params: {
            pageSize: 50,
            orderBy: 'updateTime desc'
          }
        }
      );

      const reviews = response.data.reviews || [];
      console.log(`Found ${reviews.length} reviews for location ${locationId}`);
      const interactions = [];

      for (const review of reviews) {
        try {
          // Check if interaction already exists
          const existingInteraction = await Interaction.findOne({
            platformId: review.reviewId,
            organization: platformConnection.organization
          });

          if (existingInteraction) {
            continue; // Skip if already exists
          }

          // Create interaction from review
          const interaction = {
            organization: platformConnection.organization,
            platformConnection: platformConnection._id,
            platform: 'google',
            type: 'review',
            platformId: review.reviewId,
            platformUrl: review.reviewReply?.reply || null,
            content: review.comment || '',
            contentType: 'text',
            language: review.reviewer?.displayName ? 'en' : null,
            
            // Author information
            author: {
              platformId: review.reviewer?.profilePhotoUrl || null,
              name: review.reviewer?.displayName || 'Anonymous',
              username: review.reviewer?.displayName || 'Anonymous',
              profileUrl: review.reviewer?.profilePhotoUrl || null,
              avatarUrl: review.reviewer?.profilePhotoUrl || null,
              isVerified: false
            },
            
            // Review-specific data
            rating: review.starRating || null,
            reviewDate: review.createTime ? new Date(review.createTime) : new Date(),
            
            // Status
            status: 'unread',
            isRead: false,
            
            // Platform timestamps
            platformCreatedAt: review.createTime ? new Date(review.createTime) : new Date(),
            platformUpdatedAt: review.updateTime ? new Date(review.updateTime) : new Date(),
            
            // Metadata
            metadata: {
              reviewId: review.reviewId,
              reviewReply: review.reviewReply || null,
              starRating: review.starRating,
              locationId: locationId
            }
          };

          // Sentiment will be analyzed by AI processing job
          // Star rating is stored in metadata for reference
          interaction.sentiment = null;

          interactions.push(interaction);
        } catch (error) {
          console.error(`Error processing review ${review.reviewId}:`, error.message);
          continue;
        }
      }

      // Bulk upsert interactions (insert new, update existing)
      if (interactions.length > 0) {
        const ggOrgId = platformConnection.organization;
        const ggExistingIds = new Set(
          (await Interaction.find({ platformId: { $in: interactions.map(i => i.platformId) } }).select('platformId').lean())
            .map(i => i.platformId)
        );
        const ggChatRefMap = {};
        for (const interaction of interactions) {
          if (!ggExistingIds.has(interaction.platformId)) {
            ggChatRefMap[interaction.platformId] = await generateChatRef(ggOrgId).catch(() => ({ chatNumber: null, chatRef: null }));
          }
        }
        const bulkOps = interactions.map(interaction => {
          const { status, isRead, sentiment, ...platformFields } = interaction;
          const ref = ggChatRefMap[interaction.platformId] || {};
          return {
            updateOne: {
              filter: { platformId: interaction.platformId },
              update: {
                $set: platformFields,
                $setOnInsert: { status: 'unread', isRead: false, sentiment: sentiment ?? null, chatNumber: ref.chatNumber ?? null, chatRef: ref.chatRef ?? null }
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
      console.error('Error fetching reviews:', error);
      throw new Error(`Failed to fetch reviews: ${error.message}`);
    }
  }

  /**
   * Fetch all reviews for all locations
   */
  async fetchAllReviews(platformConnection) {
    try {
      let { platformData } = platformConnection;
      let locationIds = platformData.locationIds || [];

      // If no locationIds, try to fetch them now
      if (locationIds.length === 0 && platformData.accountId) {
        try {
          console.log('No locationIds found, attempting to fetch locations...');
          const accessToken = await this.ensureValidToken(platformConnection);
          const locations = await this.getLocations(accessToken, platformData.accountId);
          locationIds = locations.map(loc => loc.name.split('/').pop());
          
          // Update platformData with locationIds
          platformData.locationIds = locationIds;
          platformConnection.platformData = platformData;
          await platformConnection.save();
          
          console.log(`Found ${locationIds.length} location(s) for Google Business Profile`);
        } catch (error) {
          console.error('Failed to fetch locations during sync:', error.message);
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
          console.error(`Error fetching reviews for location ${locationId}:`, error.message);
          continue;
        }
      }

      // Update sync stats
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
   * Reply to a review
   */
  async replyToReview(platformConnection, locationId, reviewId, replyText) {
    try {
      const { accessToken } = platformConnection;
      const locationName = `locations/${locationId}`;

      const response = await axios.put(
        `${this.businessInfoApiUrl}/${locationName}/reviews/${reviewId}`,
        {
          reviewReply: {
            comment: replyText
          }
        },
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json'
          }
        }
      );

      return {
        success: true,
        review: response.data
      };
    } catch (error) {
      throw new Error(`Failed to reply to review: ${error.message}`);
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

    // Update platform connection
    platformConnection.accessToken = accessToken;
    platformConnection.tokenExpiry = new Date(Date.now() + expiresIn * 1000);
    await platformConnection.save();

    return accessToken;
  }
}

module.exports = new GoogleService();

