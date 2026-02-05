const { google } = require('googleapis');
const crypto = require('crypto');

/**
 * Google OAuth Service for User Authentication (Login/Signup)
 * Separate from Google platform connections
 */
class GoogleAuthService {
  constructor() {
    this.oauth2Client = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      process.env.GOOGLE_AUTH_REDIRECT_URI || `${process.env.FRONTEND_URL}/api/auth/google/callback`
    );
  }

  /**
   * Generate state parameter for OAuth security
   */
  generateState() {
    const stateData = {
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
      const decoded = JSON.parse(Buffer.from(state, 'base64').toString('utf-8'));
      
      // Check if state is not too old (5 minutes)
      const fiveMinutes = 5 * 60 * 1000;
      if (Date.now() - decoded.timestamp > fiveMinutes) {
        throw new Error('State expired');
      }
      
      return decoded;
    } catch (error) {
      throw new Error('Invalid state parameter');
    }
  }

  /**
   * Get Google OAuth URL for user authentication
   */
  getAuthURL() {
    const scopes = [
      'https://www.googleapis.com/auth/userinfo.email',
      'https://www.googleapis.com/auth/userinfo.profile'
    ];

    const state = this.generateState();

    const authUrl = this.oauth2Client.generateAuthUrl({
      access_type: 'offline',
      scope: scopes,
      state: state,
      prompt: 'consent' // Force consent screen to get refresh token
    });

    return authUrl;
  }

  /**
   * Exchange authorization code for tokens
   */
  async getTokens(code) {
    try {
      const { tokens } = await this.oauth2Client.getToken(code);
      return tokens;
    } catch (error) {
      console.error('Error getting tokens:', error);
      throw new Error('Failed to exchange code for tokens');
    }
  }

  /**
   * Get user profile from Google
   */
  async getUserProfile(accessToken) {
    try {
      this.oauth2Client.setCredentials({ access_token: accessToken });
      
      const oauth2 = google.oauth2({
        auth: this.oauth2Client,
        version: 'v2'
      });

      const { data } = await oauth2.userinfo.get();
      
      return {
        id: data.id,
        email: data.email,
        firstName: data.given_name || '',
        lastName: data.family_name || '',
        fullName: data.name,
        picture: data.picture,
        verified_email: data.verified_email
      };
    } catch (error) {
      console.error('Error getting user profile:', error);
      throw new Error('Failed to get user profile');
    }
  }

  /**
   * Verify Google ID token (alternative method)
   */
  async verifyIdToken(idToken) {
    try {
      const ticket = await this.oauth2Client.verifyIdToken({
        idToken: idToken,
        audience: process.env.GOOGLE_CLIENT_ID
      });
      
      const payload = ticket.getPayload();
      return {
        id: payload.sub,
        email: payload.email,
        firstName: payload.given_name || '',
        lastName: payload.family_name || '',
        fullName: payload.name,
        picture: payload.picture,
        verified_email: payload.email_verified
      };
    } catch (error) {
      console.error('Error verifying ID token:', error);
      throw new Error('Invalid ID token');
    }
  }
}

module.exports = new GoogleAuthService();
