const PlatformConnection = require('../models/PlatformConnection');
const googleService = require('../integrations/google/googleService');
const youtubeService = require('../integrations/google/youtubeService');
const instagramService = require('../integrations/meta/instagramService');
const facebookService = require('../integrations/meta/facebookService');
const linkedinService = require('../integrations/linkedin/linkedinService');
const whatsappService = require('../integrations/whatsapp/whatsappService');
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
        try {
          const accounts = await googleService.getAccounts(tokens.accessToken);
          if (accounts && accounts.length > 0) {
            const account = accounts[0];
            try {
              const locations = await googleService.getLocations(tokens.accessToken, account.name);
              
              platformData = {
                accountId: account.name,
                accountName: account.accountName || account.name,
                locationIds: locations.map(loc => loc.name.split('/').pop())
              };
            } catch (locationError) {
              console.warn('Failed to get locations, continuing without location data:', locationError.message);
              // Still save connection even without locations
              platformData = {
                accountId: account.name,
                accountName: account.accountName || account.name,
                locationIds: []
              };
            }
          } else {
            console.warn('No Google Business Profile accounts found for this user');
            // Connection still succeeds, just no business profile data
            platformData = {
              note: 'No Business Profile account found. You can set up a Business Profile later.'
            };
          }
        } catch (accountsError) {
          // Handle 403 (permission denied) or 429 (rate limit) gracefully
          if (accountsError.message.includes('403')) {
            console.warn('Access denied to Google Business Profile API. User may not have a Business Profile or API not enabled.');
            platformData = {
              note: 'Business Profile access unavailable. This might require additional setup or the user may not have a Business Profile account.',
              error: 'api_access_denied'
            };
          } else if (accountsError.message.includes('429')) {
            console.warn('Rate limit reached for Google Business Profile API. Will retry later.');
            platformData = {
              note: 'Rate limit reached. Will sync Business Profile data later.',
              error: 'rate_limit'
            };
          } else {
            console.warn('Failed to get Google Business Profile accounts:', accountsError.message);
            // Connection still succeeds
            platformData = {
              note: 'Could not fetch Business Profile data. Connection established successfully.',
              error: accountsError.message
            };
          }
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

      const isNewConnection = !platformConnection;

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

      // Increment usage counter for new connections (SOLID: Dependency Inversion)
      if (isNewConnection) {
        const platformConnectionService = require('../services/platformConnectionService');
        await platformConnectionService.incrementConnectionCount(organizationId);
      }

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
 * @desc    Get all platform connections for organization with usage/limit info
 * @route   GET /api/platforms
 * @access  Private
 */
exports.getPlatformConnections = async (req, res, next) => {
  try {
    const platformConnectionService = require('../services/platformConnectionService');
    
    // Use the service to get connections with limits (follows Single Responsibility)
    const result = await platformConnectionService.getConnectionsWithLimits(
      req.user.organization._id
    );

    res.status(200).json({
      success: true,
      data: result.connections,
      // Include usage and limits so frontend can show "X of Y" and disable "Add account"
      usage: result.usage,
      limits: result.limits
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

    // Check if already disconnected
    if (!connection.isActive && connection.status === 'disconnected') {
      return res.status(200).json({
        success: true,
        message: 'Platform is already disconnected'
      });
    }

    // Check if this connection was counted toward the limit
    const platformConnectionService = require('../services/platformConnectionService');
    const wasCounted = platformConnectionService.shouldCountConnection({
      platform: connection.platform,
      metadata: connection.metadata
    });

    // Mark as disconnected
    const platformType = connection.platform; // Store before saving
    connection.isActive = false;
    connection.status = 'disconnected';
    await connection.save();

    // Decrement usage counter if this connection was counted (Dependency Inversion)
    if (wasCounted) {
      await platformConnectionService.decrementConnectionCount(req.user.organization._id);
    }

    // Clear all cache for this organization's interactions
    // This is important because the inbox query now filters by active connections
    const cacheService = require('../services/cacheService');
    await cacheService.delPattern(`interactions:${req.user.organization._id}*`);

    // Optionally: Archive or hide interactions from this disconnected platform
    // For now, they'll just be filtered out by the inbox query
    // If you want to permanently hide them, uncomment below:
    /*
    const Interaction = require('../models/Interaction');
    await Interaction.updateMany(
      { 
        organization: req.user.organization._id,
        platformConnection: connection._id 
      },
      { 
        $set: { status: 'archived' } 
      }
    );
    */

    res.status(200).json({
      success: true,
      message: `${platformType} disconnected successfully. Interactions from this platform will no longer appear in your inbox.`
    });
  } catch (error) {
    console.error('Error disconnecting platform:', error);
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

    const organizationId = req.user.organization._id.toString();
    let result = { count: 0, interactions: [] };

    // Ensure token is valid and fetch data
    if (connection.platform === 'youtube') {
      await youtubeService.ensureValidToken(connection);
      result = await youtubeService.fetchAllChannelComments(connection);
      console.log('🔍 [Sync] YouTube sync result:', result);
    } else if (connection.platform === 'google') {
      await googleService.ensureValidToken(connection);
      result = await googleService.fetchAllReviews(connection);
      
      if (!result.success && result.error) {
        return res.status(400).json({
          success: false,
          error: result.error,
          data: {
            interactionsAdded: result.count || 0
          }
        });
      }
    } else if (connection.platform === 'instagram') {
      // Check sync settings
      const syncComments = connection.settings?.syncComments !== false; // Default true
      const syncDMs = connection.settings?.syncDMs !== false; // Default true

      if (syncComments && syncDMs) {
        // Fetch both comments and DMs
        result = await instagramService.fetchAllInteractions(connection);
      } else if (syncComments) {
        // Only fetch comments
        result = await instagramService.fetchComments(connection);
      } else if (syncDMs) {
        // Only fetch DMs
        result = await instagramService.fetchMessages(connection);
      } else {
        return res.status(400).json({
          success: false,
          error: 'Both comments and DMs sync are disabled for this connection'
        });
      }
    } else if (connection.platform === 'facebook') {
      // Fetch both comments and reviews
      result = await facebookService.fetchAllInteractions(connection);
    } else if (connection.platform === 'linkedin') {
      try {
        // Fetch LinkedIn posts and comments
        result = await linkedinService.fetchAllInteractions(connection);
      } catch (linkedinError) {
        console.error('❌ [Sync] LinkedIn sync error:', linkedinError.message);
        return res.status(400).json({
          success: false,
          error: linkedinError.message || 'LinkedIn sync failed',
          data: {
            interactionsAdded: 0
          }
        });
      }
    } else {
      return res.status(400).json({
        success: false,
        error: 'Platform sync not implemented'
      });
    }

    // Queue auto-reply ONLY for newly synced interactions (not all)
    let autoReplyQueued = 0;
    let sentimentAnalyzed = 0;
    
    if (result.count > 0 && result.interactions && result.interactions.length > 0) {
      const autoReplyScheduler = require('../services/autoReplyScheduler');
      const { aiQueue } = require('../config/queue');
      const Interaction = require('../models/Interaction');
      const aiService = require('../services/aiService');
      
      // Get platform IDs from NEWLY synced interactions only
      const platformIds = result.interactions.map(i => i.platformId);
      
      // Find the newly synced interactions that are unread and have no replies
      const newInteractions = await Interaction.find({
        platformId: { $in: platformIds },
        organization: organizationId,
        status: 'unread',
        $or: [
          { replies: { $size: 0 } },
          { replies: { $exists: false } }
        ]
      });
      
      // AUTOMATIC SENTIMENT ANALYSIS: Analyze sentiment for new interactions immediately
      for (const interaction of newInteractions) {
        // Only analyze if sentiment is missing
        if (!interaction.sentiment && interaction.content) {
          try {
            const sentimentResult = aiService.fallbackSentimentAnalysis(interaction.content);
            interaction.sentiment = sentimentResult.sentiment;
            interaction.sentimentScore = sentimentResult.sentimentScore;
            interaction.sentimentConfidence = sentimentResult.sentimentConfidence;
            await interaction.save();
            sentimentAnalyzed++;
          } catch (sentimentError) {
            console.error(`⚠️ [Sync] Sentiment analysis failed for ${interaction._id}:`, sentimentError.message);
          }
        }
      }
      
      for (const interaction of newInteractions) {
        try {
          // Double-check: Skip if already has replies (safety check)
          if (interaction.replies && interaction.replies.length > 0) {
            console.log(`⏭️  [Sync] Skipping AI queue for ${interaction._id} - already has replies`);
            continue;
          }

          // Queue AI processing for new interactions only
          await aiQueue.add({
            interactionId: interaction._id
          }, {
            attempts: 3,
            backoff: 2000,
            jobId: `ai-${interaction._id}` // Use unique job ID to prevent duplicates
          });

          // Queue auto-reply
          const queued = await autoReplyScheduler.queueImmediateAutoReply(
            interaction._id.toString(),
            organizationId
          );
          
          if (queued) {
            autoReplyQueued++;
          }
        } catch (queueError) {
          console.error(`Error queueing interaction ${interaction._id}:`, queueError);
        }
      }
    }
    
    console.log(`📊 [Sync] Total: ${result.count} new interactions, ${sentimentAnalyzed} sentiments analyzed, ${autoReplyQueued} auto-replies queued`)
    
    // Invalidate interactions cache so frontend sees new data immediately
    if (result.count > 0) {
      const cacheService = require('../services/cacheService');
      const cachePattern = `interactions:${organizationId}:*`;
      await cacheService.delPattern(cachePattern);
      console.log(`🗑️  [Cache] Invalidated interaction cache: ${cachePattern}`);
    }
      
    res.status(200).json({
      success: true,
      message: result.count > 0 
        ? `Sync completed. Found ${result.count} new interactions. ${autoReplyQueued} auto-replies queued.` 
        : 'Sync completed. No new interactions found.',
      data: {
        interactionsAdded: result.count,
        autoRepliesQueued: autoReplyQueued
      }
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Refresh Google Business Profile locations
 * @route   POST /api/platforms/:id/refresh-locations
 * @access  Private
 */
exports.refreshGoogleLocations = async (req, res, next) => {
  try {
    const connection = await PlatformConnection.findOne({
      _id: req.params.id,
      organization: req.user.organization._id,
      platform: 'google',
      isActive: true
    });

    if (!connection) {
      return res.status(404).json({
        success: false,
        error: 'Google connection not found'
      });
    }

    const googleService = require('../integrations/google/googleService');

    // Ensure token is valid
    await googleService.ensureValidToken(connection);

    // Fetch accounts and locations
    try {
      const accounts = await googleService.getAccounts(connection.accessToken);
      
      if (!accounts || accounts.length === 0) {
        return res.status(404).json({
          success: false,
          error: 'No Google Business Profile accounts found',
          message: 'Please set up a Google Business Profile at https://business.google.com/',
          code: 'NO_ACCOUNTS'
        });
      }

      const account = accounts[0];
      const locations = await googleService.getLocations(connection.accessToken, account.name);
      
      if (!locations || locations.length === 0) {
        return res.status(404).json({
          success: false,
          error: 'No business locations found',
          message: 'Your Google Business Profile account exists but has no locations. Please add a business location at https://business.google.com/',
          code: 'NO_LOCATIONS',
          accountName: account.accountName || account.name
        });
      }

      // Update connection with location IDs
      const locationIds = locations.map(loc => loc.name.split('/').pop());
      connection.platformData = {
        ...connection.platformData,
        accountId: account.name,
        accountName: account.accountName || account.name,
        locationIds: locationIds,
        lastLocationRefresh: new Date()
      };
      await connection.save();

      console.log(`✅ [Google] Refreshed locations for connection ${connection._id}: Found ${locationIds.length} location(s)`);

      res.json({
        success: true,
        message: `Found ${locations.length} business location${locations.length !== 1 ? 's' : ''}`,
        data: {
          locationsCount: locations.length,
          locationNames: locations.map(loc => loc.title || loc.name),
          accountName: account.accountName || account.name
        }
      });
    } catch (apiError) {
      console.error('❌ [Google] Location refresh API error:', apiError.message);
      
      // Handle specific API errors
      if (apiError.message.includes('403')) {
        return res.status(403).json({
          success: false,
          error: 'Access denied to Google Business Profile API',
          message: 'Please ensure you have a Google Business Profile and granted all permissions during OAuth.',
          code: 'API_ACCESS_DENIED'
        });
      }

      return res.status(500).json({
        success: false,
        error: 'Failed to fetch locations',
        message: apiError.message,
        code: 'API_ERROR'
      });
    }
  } catch (error) {
    console.error('❌ [Google] Refresh locations error:', error);
    next(error);
  }
};

/**
 * @desc    Connect WhatsApp Business API
 * @route   POST /api/platforms/whatsapp/connect
 * @access  Private
 */
exports.connectWhatsApp = async (req, res, next) => {
  try {
    const organizationId = req.user.organization._id;

    // Verify WhatsApp connection
    const verificationResult = await whatsappService.verifyConnection();

    if (!verificationResult.success) {
      return res.status(400).json({
        success: false,
        error: 'Failed to verify WhatsApp connection',
        message: 'Please check your WhatsApp credentials in environment variables'
      });
    }

    // Check if already connected
    const existingConnection = await PlatformConnection.findOne({
      organization: organizationId,
      platform: 'whatsapp',
      isActive: true
    });

    if (existingConnection) {
      return res.status(400).json({
        success: false,
        error: 'WhatsApp already connected',
        message: 'This organization already has an active WhatsApp connection'
      });
    }

    // Get business profile
    const profileResult = await whatsappService.getBusinessProfile();

    // Create platform connection
    const connection = await PlatformConnection.create({
      organization: organizationId,
      platform: 'whatsapp',
      platformUserId: whatsappService.phoneNumberId,
      platformDisplayName: verificationResult.verifiedName,
      accessToken: whatsappService.accessToken, // Required field
      createdBy: req.user._id, // Required field
      platformData: {
        phoneNumberId: whatsappService.phoneNumberId,
        businessAccountId: whatsappService.businessAccountId,
        displayPhoneNumber: verificationResult.phoneNumber,
        verifiedName: verificationResult.verifiedName,
        qualityRating: verificationResult.qualityRating,
        codeVerificationStatus: verificationResult.codeVerificationStatus,
        businessProfile: profileResult.profile
      },
      status: 'connected',
      isActive: true
    });

    console.log('✅ [WhatsApp] Connection created:', connection._id);

    res.status(200).json({
      success: true,
      data: connection,
      message: 'WhatsApp connected successfully'
    });

  } catch (error) {
    console.error('❌ [WhatsApp] Connection error:', error);
    next(error);
  }
};

/**
 * @desc    Disconnect WhatsApp
 * @route   DELETE /api/platforms/whatsapp/disconnect
 * @access  Private
 */
exports.disconnectWhatsApp = async (req, res, next) => {
  try {
    const organizationId = req.user.organization._id;

    const connection = await PlatformConnection.findOne({
      organization: organizationId,
      platform: 'whatsapp',
      isActive: true
    });

    if (!connection) {
      return res.status(404).json({
        success: false,
        error: 'WhatsApp connection not found'
      });
    }

    // Deactivate connection
    connection.isActive = false;
    connection.status = 'disconnected';
    await connection.save();

    console.log('✅ [WhatsApp] Connection disconnected:', connection._id);

    res.status(200).json({
      success: true,
      message: 'WhatsApp disconnected successfully'
    });

  } catch (error) {
    console.error('❌ [WhatsApp] Disconnect error:', error);
    next(error);
  }
};

/**
 * @desc    Get WhatsApp connection status
 * @route   GET /api/platforms/whatsapp/status
 * @access  Private
 */
exports.getWhatsAppStatus = async (req, res, next) => {
  try {
    const organizationId = req.user.organization._id;

    const connection = await PlatformConnection.findOne({
      organization: organizationId,
      platform: 'whatsapp',
      isActive: true
    });

    if (!connection) {
      return res.status(200).json({
        success: true,
        data: {
          isConnected: false,
          connection: null
        }
      });
    }

    res.status(200).json({
      success: true,
      data: {
        isConnected: true,
        connection: {
          id: connection._id,
          displayPhoneNumber: connection.platformData.displayPhoneNumber,
          verifiedName: connection.platformData.verifiedName,
          qualityRating: connection.platformData.qualityRating,
          status: connection.status
        }
      }
    });

  } catch (error) {
    console.error('❌ [WhatsApp] Status check error:', error);
    next(error);
  }
};

