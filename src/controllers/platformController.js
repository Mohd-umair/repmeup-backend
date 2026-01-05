const PlatformConnection = require('../models/PlatformConnection');
const googleService = require('../integrations/google/googleService');
const youtubeService = require('../integrations/google/youtubeService');
const crypto = require('crypto');

/**
 * @desc    Initiate Google OAuth flow
 * @route   GET /api/platforms/google/connect
 * @access  Private
 */
exports.initiateGoogleConnection = async (req, res, next) => {
  try {
    const { type = 'reviews' } = req.query; // 'reviews' or 'youtube'
    
    // Generate state token for security
    const state = crypto.randomBytes(32).toString('hex');
    
    // Store state in session or cache (for production, use Redis)
    // For now, we'll include organization ID in state
    const stateData = {
      organizationId: req.user.organization._id.toString(),
      userId: req.user._id.toString(),
      type: type,
      timestamp: Date.now()
    };
    
    const encodedState = Buffer.from(JSON.stringify(stateData)).toString('base64');
    
    // Get authorization URL based on type
    let authUrl;
    if (type === 'youtube') {
      authUrl = youtubeService.getAuthorizationUrl(encodedState);
    } else {
      authUrl = googleService.getAuthorizationUrl(encodedState);
    }

    res.status(200).json({
      success: true,
      data: {
        authorizationUrl: authUrl,
        state: encodedState
      }
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Handle Google OAuth callback
 * @route   GET /api/platforms/google/callback
 * @access  Public (called by Google)
 */
exports.handleGoogleCallback = async (req, res, next) => {
  try {
    const { code, state, error } = req.query;

    if (error) {
      return res.redirect(`${process.env.FRONTEND_URL || 'http://localhost:4200'}/settings?error=${encodeURIComponent(error)}`);
    }

    if (!code || !state) {
      return res.redirect(`${process.env.FRONTEND_URL || 'http://localhost:4200'}/settings?error=missing_parameters`);
    }

    try {
      // Decode state
      const stateData = JSON.parse(Buffer.from(state, 'base64').toString());
      const { organizationId, userId, type } = stateData;

      // Exchange code for tokens
      const tokens = await googleService.exchangeCodeForTokens(code);

      // Get user info
      const userInfo = await googleService.getUserInfo(tokens.accessToken);

      // Determine platform and fetch platform-specific data
      let platformData = {};
      let platform = 'google';

      if (type === 'youtube') {
        platform = 'youtube';
        const channelInfo = await youtubeService.getChannelInfo(tokens.accessToken);
        if (channelInfo) {
          platformData = {
            channelId: channelInfo.id,
            channelName: channelInfo.snippet.title,
            channelDescription: channelInfo.snippet.description,
            subscriberCount: channelInfo.statistics?.subscriberCount || 0
          };
        }
      } else {
        // Google Business Profile
        const accounts = await googleService.getAccounts(tokens.accessToken);
        if (accounts && accounts.length > 0) {
          const account = accounts[0];
          const locations = await googleService.getLocations(tokens.accessToken, account.name);
          
          platformData = {
            accountId: account.name,
            accountName: account.accountName || account.name,
            locationIds: locations.map(loc => loc.name.split('/').pop())
          };
        }
      }

      // Calculate token expiry
      const tokenExpiry = new Date(Date.now() + tokens.expiresIn * 1000);

      // Check if connection already exists
      let platformConnection = await PlatformConnection.findOne({
        organization: organizationId,
        platform: platform,
        platformUserId: userInfo.platformUserId
      });

      if (platformConnection) {
        // Update existing connection
        platformConnection.accessToken = tokens.accessToken;
        platformConnection.refreshToken = tokens.refreshToken;
        platformConnection.tokenExpiry = tokenExpiry;
        platformConnection.platformData = platformData;
        platformConnection.status = 'connected';
        platformConnection.isActive = true;
        platformConnection.lastSyncAt = new Date();
      } else {
        // Create new connection
        platformConnection = new PlatformConnection({
          organization: organizationId,
          platform: platform,
          platformUserId: userInfo.platformUserId,
          platformUsername: userInfo.platformUsername,
          platformDisplayName: userInfo.platformDisplayName,
          platformProfilePicture: userInfo.platformProfilePicture,
          platformEmail: userInfo.platformEmail,
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken,
          tokenExpiry: tokenExpiry,
          scope: ['business.manage', 'youtube.readonly'],
          platformData: platformData,
          status: 'connected',
          isActive: true,
          createdBy: userId
        });
      }

      await platformConnection.save();

      // Trigger initial sync
      try {
        if (platform === 'youtube') {
          await youtubeService.fetchAllChannelComments(platformConnection);
        } else {
          await googleService.fetchAllReviews(platformConnection);
        }
      } catch (syncError) {
        console.error('Initial sync error:', syncError);
        // Don't fail the connection if sync fails
      }

      // Redirect to frontend with success
      res.redirect(`${process.env.FRONTEND_URL || 'http://localhost:4200'}/app/settings?connected=${platform}&success=true`);
    } catch (error) {
      console.error('OAuth callback error:', error);
      res.redirect(`${process.env.FRONTEND_URL || 'http://localhost:4200'}/app/settings?error=${encodeURIComponent(error.message)}`);
    }
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Get all platform connections for organization
 * @route   GET /api/platforms
 * @access  Private
 */
exports.getPlatformConnections = async (req, res, next) => {
  try {
    const connections = await PlatformConnection.find({
      organization: req.user.organization._id,
      isActive: true
    }).select('-accessToken -refreshToken'); // Don't send tokens to frontend

    res.status(200).json({
      success: true,
      data: connections
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Get single platform connection
 * @route   GET /api/platforms/:id
 * @access  Private
 */
exports.getPlatformConnection = async (req, res, next) => {
  try {
    const connection = await PlatformConnection.findOne({
      _id: req.params.id,
      organization: req.user.organization._id
    }).select('-accessToken -refreshToken');

    if (!connection) {
      return res.status(404).json({
        success: false,
        error: 'Platform connection not found'
      });
    }

    res.status(200).json({
      success: true,
      data: connection
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Disconnect platform
 * @route   DELETE /api/platforms/:id
 * @access  Private
 */
exports.disconnectPlatform = async (req, res, next) => {
  try {
    const connection = await PlatformConnection.findOne({
      _id: req.params.id,
      organization: req.user.organization._id
    });

    if (!connection) {
      return res.status(404).json({
        success: false,
        error: 'Platform connection not found'
      });
    }

    connection.isActive = false;
    connection.status = 'disconnected';
    await connection.save();

    res.status(200).json({
      success: true,
      message: 'Platform disconnected successfully'
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Sync platform data manually
 * @route   POST /api/platforms/:id/sync
 * @access  Private
 */
exports.syncPlatform = async (req, res, next) => {
  try {
    const connection = await PlatformConnection.findOne({
      _id: req.params.id,
      organization: req.user.organization._id,
      isActive: true
    });

    if (!connection) {
      return res.status(404).json({
        success: false,
        error: 'Platform connection not found'
      });
    }

    // Ensure token is valid
    if (connection.platform === 'youtube') {
      await youtubeService.ensureValidToken(connection);
      const result = await youtubeService.fetchAllChannelComments(connection);
      
      res.status(200).json({
        success: true,
        message: 'Sync completed',
        data: {
          interactionsAdded: result.count
        }
      });
    } else if (connection.platform === 'google') {
      await googleService.ensureValidToken(connection);
      const result = await googleService.fetchAllReviews(connection);
      
      res.status(200).json({
        success: true,
        message: 'Sync completed',
        data: {
          interactionsAdded: result.count
        }
      });
    } else {
      return res.status(400).json({
        success: false,
        error: 'Platform sync not implemented'
      });
    }
  } catch (error) {
    next(error);
  }
};

