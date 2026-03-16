const axios = require('axios');
const crypto = require('crypto');

class LinkedInAuthService {
  constructor() {
    this.clientId = process.env.LINKEDIN_CLIENT_ID;
    this.clientSecret = process.env.LINKEDIN_CLIENT_SECRET;
    this.redirectUri = process.env.LINKEDIN_REDIRECT_URI || `${process.env.API_URL}/api/auth/linkedin/callback`;
    this.baseURL = 'https://www.linkedin.com';
    this.apiURL = 'https://api.linkedin.com/v2';
  }

  /**
   * Generate OAuth URL for LinkedIn
   */
  getAuthURL(state) {
    // Start with basic scopes that are auto-approved
    const basicScopes = [
      'openid',
      'profile',
      'email'
    ];

    // Advanced scopes that require LinkedIn approval
    // Only include if explicitly enabled via environment variable
    const advancedScopes = [];
    const enableAdvanced = process.env.LINKEDIN_ENABLE_ADVANCED_SCOPES === 'true';
    const memberSocialOnly = process.env.LINKEDIN_MEMBER_SOCIAL_ONLY === 'true';

    if (enableAdvanced) {
      // Member-only: request only w_member_social (approved with Share on LinkedIn Default Tier).
      // Use this when org scopes are not yet approved to avoid "scope not authorized" errors.
      if (memberSocialOnly) {
        advancedScopes.push('w_member_social');
      } else {
        // Full org access: requires Community Management API approval
        advancedScopes.push(
          'w_member_social',
          'r_organization_social',
          'w_organization_social',
          'rw_organization_admin'
        );
      }
    }

    const scopes = [...basicScopes, ...advancedScopes];

    const params = new URLSearchParams({
      response_type: 'code',
      client_id: this.clientId,
      redirect_uri: this.redirectUri,
      state: state,
      scope: scopes.join(' ')
    });

    const authURL = `${this.baseURL}/oauth/v2/authorization?${params.toString()}`;
    
    console.log('🔗 [LinkedIn] Generating OAuth URL');
    console.log('🔗 [LinkedIn] Client ID:', this.clientId?.substring(0, 10) + '...');
    console.log('🔗 [LinkedIn] Redirect URI:', this.redirectUri);
    console.log('🔗 [LinkedIn] Scopes:', scopes.join(', '));
    console.log('🔗 [LinkedIn] Advanced scopes enabled:', enableAdvanced, 'member-social-only:', memberSocialOnly);
    
    return authURL;
  }

  /**
   * Exchange authorization code for access token
   */
  async exchangeCodeForToken(code) {
    try {
      console.log('🔄 [LinkedIn] Exchanging code for access token...');
      
      const response = await axios.post(
        `${this.baseURL}/oauth/v2/accessToken`,
        null,
        {
          params: {
            grant_type: 'authorization_code',
            code: code,
            client_id: this.clientId,
            client_secret: this.clientSecret,
            redirect_uri: this.redirectUri
          },
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded'
          }
        }
      );

      console.log('✅ [LinkedIn] Token exchange successful');
      
      return {
        accessToken: response.data.access_token,
        refreshToken: response.data.refresh_token,
        expiresIn: response.data.expires_in,
        scope: response.data.scope
      };
    } catch (error) {
      console.error('❌ [LinkedIn] Token exchange error:', error.response?.data || error.message);
      throw new Error(`Failed to exchange code for token: ${error.response?.data?.error_description || error.message}`);
    }
  }

  /**
   * Get user profile information
   */
  async getUserProfile(accessToken) {
    try {
      console.log('👤 [LinkedIn] Fetching user profile...');
      
      const response = await axios.get(`${this.apiURL}/userinfo`, {
        headers: {
          'Authorization': `Bearer ${accessToken}`
        }
      });

      console.log('✅ [LinkedIn] User profile fetched:', response.data.name);
      
      return {
        id: response.data.sub,
        name: response.data.name,
        email: response.data.email,
        picture: response.data.picture,
        emailVerified: response.data.email_verified
      };
    } catch (error) {
      console.error('❌ [LinkedIn] Failed to fetch user profile:', error.response?.data || error.message);
      throw error;
    }
  }

  /**
   * Get user's organizations (company pages they can manage)
   * Note: This requires r_organization_social scope which needs LinkedIn approval
   */
  async getUserOrganizations(accessToken) {
    try {
      console.log('🏢 [LinkedIn] Fetching user organizations...');
      
      // First, get the person URN using basic profile endpoint
      const meResponse = await axios.get(`${this.apiURL}/me`, {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'X-Restli-Protocol-Version': '2.0.0'
        }
      });

      const personUrn = `urn:li:person:${meResponse.data.id}`;
      console.log('👤 [LinkedIn] Person URN:', personUrn);

      // Try to get organization access control info
      // This requires r_organization_social scope
      try {
        const orgsResponse = await axios.get(
          `${this.apiURL}/organizationAcls`,
          {
            params: {
              q: 'roleAssignee',
              role: 'ADMINISTRATOR',
              projection: '(elements*(organization~(localizedName,logoV2)))'
            },
            headers: {
              'Authorization': `Bearer ${accessToken}`,
              'X-Restli-Protocol-Version': '2.0.0'
            }
          }
        );

        const organizations = orgsResponse.data.elements?.map(element => {
          const org = element['organization~'];
          return {
            id: element.organization.split(':').pop(),
            urn: element.organization,
            name: org.localizedName,
            logo: org.logoV2?.original || null,
            role: element.role
          };
        }) || [];

        console.log(`✅ [LinkedIn] Found ${organizations.length} organization(s)`);
        organizations.forEach(org => {
          console.log(`   - ${org.name} (${org.role})`);
        });

        return {
          personUrn,
          organizations
        };
      } catch (orgError) {
        // If organization API fails, it means advanced scopes aren't approved
        console.warn('⚠️  [LinkedIn] Cannot fetch organizations - advanced scopes not approved');
        console.warn('⚠️  [LinkedIn] Error:', orgError.response?.data || orgError.message);
        console.warn('⚠️  [LinkedIn] To enable organization features, request approval for:');
        console.warn('⚠️  [LinkedIn] - r_organization_social (read organization posts)');
        console.warn('⚠️  [LinkedIn] - w_organization_social (post on behalf of organization)');
        
        // Return empty organizations but still save personal profile
        return {
          personUrn,
          organizations: []
        };
      }
    } catch (error) {
      console.error('❌ [LinkedIn] Failed to fetch user info:', error.response?.data || error.message);
      // Return empty if error
      return {
        personUrn: null,
        organizations: []
      };
    }
  }

  /**
   * Save LinkedIn connection to database
   */
  async saveLinkedInConnection(userId, organizationId, accessToken, refreshToken, expiresIn, profile, orgData) {
    try {
      const PlatformConnection = require('../../models/PlatformConnection');
      
      console.log('💾 [LinkedIn] Saving connection...');
      console.log('💾 [LinkedIn] User ID:', userId);
      console.log('💾 [LinkedIn] Organization ID:', organizationId);
      console.log('💾 [LinkedIn] Profile:', profile.name);
      console.log('💾 [LinkedIn] Organizations:', orgData.organizations.length);

      const tokenExpiry = new Date(Date.now() + expiresIn * 1000);

      // If user has organizations, save each one
      if (orgData.organizations.length > 0) {
        const savedConnections = [];

        for (const org of orgData.organizations) {
          const connection = await PlatformConnection.findOneAndUpdate(
            {
              organization: organizationId,
              platform: 'linkedin',
              'platformData.organizationId': org.id
            },
            {
              platformUserId: profile.id,
              platformUsername: profile.name,
              platformDisplayName: profile.name,
              platformProfilePicture: profile.picture,
              platformEmail: profile.email,
              accessToken: accessToken,
              refreshToken: refreshToken,
              tokenExpiry: tokenExpiry,
              platformData: {
                organizationId: org.id,
                organizationName: org.name,
                organizationUrn: org.urn,
                personUrn: orgData.personUrn
              },
              isActive: true,
              status: 'connected',
              createdBy: userId
            },
            {
              upsert: true,
              new: true,
              setDefaultsOnInsert: true
            }
          );

          savedConnections.push(connection);
          console.log(`✅ [LinkedIn] Saved connection for organization: ${org.name}`);
        }

        return savedConnections;
      } else {
        // Save personal profile connection
        const connection = await PlatformConnection.findOneAndUpdate(
          {
            organization: organizationId,
            platform: 'linkedin',
            platformUserId: profile.id
          },
          {
            platformUserId: profile.id,
            platformUsername: profile.name,
            platformDisplayName: profile.name,
            platformProfilePicture: profile.picture,
            platformEmail: profile.email,
            accessToken: accessToken,
            refreshToken: refreshToken,
            tokenExpiry: tokenExpiry,
            platformData: {
              personUrn: orgData.personUrn
            },
            isActive: true,
            status: 'connected',
            createdBy: userId
          },
          {
            upsert: true,
            new: true,
            setDefaultsOnInsert: true
          }
        );

        console.log('✅ [LinkedIn] Saved personal profile connection');
        return [connection];
      }
    } catch (error) {
      console.error('❌ [LinkedIn] Error saving connection:', error);
      throw error;
    }
  }

  /**
   * Refresh access token
   */
  async refreshAccessToken(refreshToken) {
    try {
      console.log('🔄 [LinkedIn] Refreshing access token...');
      
      const response = await axios.post(
        `${this.baseURL}/oauth/v2/accessToken`,
        null,
        {
          params: {
            grant_type: 'refresh_token',
            refresh_token: refreshToken,
            client_id: this.clientId,
            client_secret: this.clientSecret
          },
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded'
          }
        }
      );

      console.log('✅ [LinkedIn] Token refresh successful');
      
      return {
        accessToken: response.data.access_token,
        refreshToken: response.data.refresh_token || refreshToken,
        expiresIn: response.data.expires_in
      };
    } catch (error) {
      console.error('❌ [LinkedIn] Token refresh error:', error.response?.data || error.message);
      throw new Error(`Failed to refresh token: ${error.response?.data?.error_description || error.message}`);
    }
  }

  /**
   * Generate and store state parameter for OAuth
   */
  generateState(userId, organizationId) {
    const stateData = {
      userId,
      organizationId,
      platform: 'linkedin',
      timestamp: Date.now(),
      nonce: crypto.randomBytes(16).toString('hex')
    };
    
    return Buffer.from(JSON.stringify(stateData)).toString('base64');
  }

  /**
   * Verify state parameter
   */
  verifyState(state) {
    try {
      const decoded = Buffer.from(state, 'base64').toString('utf-8');
      const stateData = JSON.parse(decoded);
      
      // Check if state is not older than 10 minutes
      const tenMinutes = 10 * 60 * 1000;
      if (Date.now() - stateData.timestamp > tenMinutes) {
        throw new Error('State parameter expired');
      }
      
      return stateData;
    } catch (error) {
      console.error('❌ [LinkedIn] State verification failed:', error.message);
      throw new Error('Invalid state parameter');
    }
  }
}

module.exports = new LinkedInAuthService();

