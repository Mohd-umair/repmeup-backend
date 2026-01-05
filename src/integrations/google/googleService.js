const axios = require('axios');
const Interaction = require('../../models/Interaction');
const PlatformConnection = require('../../models/PlatformConnection');

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
      throw new Error(`Failed to get accounts: ${error.message}`);
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
      throw new Error(`Failed to get locations: ${error.message}`);
    }
  }

  /**
   * Fetch reviews for a location
   */
  async fetchReviews(platformConnection, locationId) {
    try {
      const { accessToken } = platformConnection;
      const locationName = `locations/${locationId}`;

      const response = await axios.get(
        `${this.businessInfoApiUrl}/${locationName}/reviews`,
        {
          headers: {
            Authorization: `Bearer ${accessToken}`
          }
        }
      );

      const reviews = response.data.reviews || [];
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

          // Determine sentiment based on rating
          if (review.starRating) {
            if (review.starRating >= 4) {
              interaction.sentiment = 'positive';
            } else if (review.starRating <= 2) {
              interaction.sentiment = 'negative';
            } else {
              interaction.sentiment = 'neutral';
            }
          }

          interactions.push(interaction);
        } catch (error) {
          console.error(`Error processing review ${review.reviewId}:`, error.message);
          continue;
        }
      }

      // Bulk insert interactions
      if (interactions.length > 0) {
        await Interaction.insertMany(interactions, { ordered: false });
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
      const { platformData } = platformConnection;
      const locationIds = platformData.locationIds || [];

      if (locationIds.length === 0) {
        return { success: true, count: 0, interactions: [] };
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

