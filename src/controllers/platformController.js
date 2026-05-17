const PlatformConnection = require('../models/PlatformConnection');
const googleService = require('../integrations/google/googleService');
const youtubeService = require('../integrations/google/youtubeService');
const instagramService = require('../integrations/meta/instagramService');
const facebookService = require('../integrations/meta/facebookService');
const linkedinService = require('../integrations/linkedin/linkedinService');
const whatsappService = require('../integrations/whatsapp/whatsappService');
const crypto = require('crypto');
const logger = require('../config/logger');
const logEvents = require('../utils/logEvents');
const platformSyncService = require('../services/platformSyncService');
const whatsappConnectionService = require('../services/whatsappConnectionService');

/**
 * Lightweight public SPA URL so the OAuth popup can postMessage to opener and window.close().
 */
function buildWhatsAppOAuthCallbackUrl(frontendUrl, queryObj) {
  const base = (frontendUrl || 'http://localhost:4200').replace(/\/$/, '');
  const q = new URLSearchParams(queryObj).toString();
  return `${base}/whatsapp-oauth-callback${q ? `?${q}` : ''}`;
}

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
        // Cross-org conflict check: block if this account is active in another workspace
        const crossOrgConflict = await PlatformConnection.findCrossOrgConflict(
          platform, userInfo.platformUserId, organizationId
        );
        if (crossOrgConflict) {
          const err = new Error(
            `This ${platform} account is already connected to another workspace.`
          );
          err.code = 'CROSS_ORG_CONFLICT';
          throw err;
        }

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
      logger.error('OAuth callback error', { 
        error: error.message,
        platform,
        userId: req.user?._id?.toString()
      });
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

    // Normalize so frontend always gets platformProfilePicture when we have it (root or metadata)
    const connections = (result.connections || []).map((c) => {
      const doc = c.toObject ? c.toObject() : { ...c };
      if (!doc.platformProfilePicture && doc.metadata?.profilePicture) {
        doc.platformProfilePicture = doc.metadata.profilePicture;
      }
      return doc;
    });

    res.status(200).json({
      success: true,
      data: connections,
      // Include usage and limits so frontend can show "X of Y" and disable "Add account"
      usage: result.usage,
      limits: result.limits
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Refresh profile pictures for existing Meta (Facebook/Instagram) connections
 *          Uses current Meta API data to backfill platformProfilePicture / metadata.profilePicture
 * @route   POST /api/platforms/refresh-profile-pictures
 * @access  Private
 */
exports.refreshProfilePictures = async (req, res, next) => {
  try {
    const metaAuth = require('../integrations/meta/metaAuth');
    const organizationId = req.user.organization._id || req.user.organization;

    const userConnection = await PlatformConnection.findOne({
      organization: organizationId,
      platform: 'facebook',
      'metadata.type': 'user_token',
      isActive: true
    }).select('accessToken');
    if (!userConnection?.accessToken) {
      return res.status(400).json({
        success: false,
        error: 'No Facebook user connection found. Connect a Facebook account first.'
      });
    }

    const pages = await metaAuth.getUserPages(userConnection.accessToken);
    let updated = 0;
    for (const page of pages) {
      const pagePictureUrl = page.picture?.data?.url || (typeof page.picture === 'string' ? page.picture : null) || null;
      const fbConn = await PlatformConnection.findOne({
        organization: organizationId,
        platform: 'facebook',
        platformUserId: page.id,
        isActive: true
      });
      if (fbConn && pagePictureUrl) {
        fbConn.platformProfilePicture = pagePictureUrl;
        if (!fbConn.metadata) fbConn.metadata = {};
        fbConn.metadata.profilePicture = pagePictureUrl;
        await fbConn.save();
        updated++;
      }
      const ig = page.instagram_business_account;
      if (ig?.profile_picture_url) {
        const igConn = await PlatformConnection.findOne({
          organization: organizationId,
          platform: 'instagram',
          platformUserId: ig.id,
          isActive: true
        });
        if (igConn) {
          igConn.platformProfilePicture = ig.profile_picture_url;
          if (!igConn.metadata) igConn.metadata = {};
          igConn.metadata.profilePicture = ig.profile_picture_url;
          await igConn.save();
          updated++;
        }
      }
    }
    res.status(200).json({
      success: true,
      message: `Refreshed profile pictures for ${updated} connection(s)`,
      updated
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

    // For Instagram Login connections, revoke the Meta webhook subscription so
    // Meta stops delivering events for this account. Fire-and-forget — DB is
    // already updated so a failure here doesn't block the disconnect response.
    if (
      connection.platform === 'instagram' &&
      (connection.metadata?.connectionType === 'instagram_login' ||
        (typeof connection.accessToken === 'string' && connection.accessToken.startsWith('IGAA')))
    ) {
      const igLoginAuth = require('../integrations/meta/instagramLoginAuth');
      const isuid = connection.metadata?.igLoginScopedId || connection.platformUserId;
      igLoginAuth.unsubscribeFromWebhook(isuid, connection.accessToken).catch(() => {});
    }

    // Decrement usage counter if this connection was counted (Dependency Inversion)
    if (wasCounted) {
      await platformConnectionService.decrementConnectionCount(req.user.organization._id);
    }

    // Clear all cache for this organization's interactions
    // This is important because the inbox query now filters by active connections
    const cacheService = require('../services/cacheService');
    await cacheService.invalidateInteractionCaches(req.user.organization._id);

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
    logger.error('Error disconnecting platform', { 
      error: error.message,
      platform: req.body.platform,
      userId: req.user._id.toString()
    });
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
      return res.status(404).json({ success: false, error: 'Platform connection not found' });
    }

    const organizationId = req.user.organization._id.toString();
    const syncResult = await platformSyncService.syncPlatform(connection, organizationId);

    // Non-fatal platform-level error (e.g. sync disabled, unsupported platform)
    if (syncResult.error) {
      return res.status(400).json({
        success: false,
        error: syncResult.error,
        data: { interactionsAdded: syncResult.count || 0 }
      });
    }

    const { count, autoReplyQueued, linkedInSyncHint, aiSkippedBackfill = 0 } = syncResult;
    const message =
      count > 0
        ? `Sync completed. Found ${count} new interactions. ${autoReplyQueued} auto-replies queued.`
        : linkedInSyncHint
          ? 'Sync completed. No new interactions. LinkedIn did not allow listing posts (read access).'
          : 'Sync completed. No new interactions found.';

    res.status(200).json({
      success: true,
      message,
      data: {
        interactionsAdded: count,
        autoRepliesQueued: autoReplyQueued,
        aiSkippedBackfill,
        ...(linkedInSyncHint && { linkedInSyncHint })
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
/**
 * @desc    Initiate WhatsApp Embedded Signup OAuth flow
 * @route   GET /api/platforms/whatsapp/connect
 * @access  Private
 * Returns an authUrl for the frontend to open in a popup/redirect.
 */
exports.initiateWhatsAppConnection = async (req, res, next) => {
  try {
    const whatsappLoginAuth = require('../integrations/whatsapp/whatsappLoginAuth');
    const userId = req.user._id.toString();
    const organizationId = req.user.organization._id.toString();

    const authUrl = whatsappLoginAuth.getAuthURL(userId, organizationId);

    res.status(200).json({
      success: true,
      data: { authUrl }
    });
  } catch (error) {
    console.error('❌ [WhatsApp] Initiate connection error:', error);
    next(error);
  }
};

/**
 * @desc    Handle WhatsApp OAuth callback (Embedded Signup)
 * @route   GET /api/platforms/whatsapp/callback  (public — called by Meta redirect)
 * @access  Public
 */
exports.handleWhatsAppCallback = async (req, res, next) => {
  const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:4200';

  try {
    const { code, state, error: oauthError, error_description } = req.query;

    if (oauthError) {
      console.error('[WhatsApp] OAuth error:', oauthError, error_description);
      return res.redirect(
        buildWhatsAppOAuthCallbackUrl(frontendUrl, {
          whatsapp_error: error_description || oauthError
        })
      );
    }

    if (!code || !state) {
      return res.redirect(
        buildWhatsAppOAuthCallbackUrl(frontendUrl, {
          whatsapp_error: 'Missing code or state parameter'
        })
      );
    }

    const whatsappLoginAuth = require('../integrations/whatsapp/whatsappLoginAuth');

    // Verify state and extract userId / organizationId
    let stateData;
    try {
      stateData = whatsappLoginAuth.verifyState(state);
    } catch (stateErr) {
      return res.redirect(
        buildWhatsAppOAuthCallbackUrl(frontendUrl, { whatsapp_error: stateErr.message })
      );
    }

    const { userId, organizationId } = stateData;

    // Exchange code for short-lived token then long-lived token
    const shortToken = await whatsappLoginAuth.exchangeCode(code);
    const { accessToken, expiresIn } = await whatsappLoginAuth.getLongLivedToken(shortToken);

    // Discover WABAs and phone numbers
    const phoneNumbers = await whatsappLoginAuth.getWhatsAppAccounts(accessToken);

    if (!phoneNumbers || phoneNumbers.length === 0) {
      return res.redirect(
        buildWhatsAppOAuthCallbackUrl(frontendUrl, {
          whatsapp_error:
            'No WhatsApp Business phone numbers found. Ensure the account has admin access to a WABA.'
        })
      );
    }

    // Save all discovered phone numbers as separate connections (or just the first)
    const savedConnections = [];
    for (const phoneData of phoneNumbers) {
      try {
        const conn = await whatsappLoginAuth.saveConnection(
          userId, organizationId, accessToken, expiresIn, phoneData
        );
        savedConnections.push(conn);
      } catch (saveErr) {
        if (saveErr.code === 'CROSS_ORG_CONFLICT') {
          console.warn(`[WhatsApp] Cross-org conflict for ${phoneData.displayPhoneNumber}, skipping`);
        } else {
          console.error(`[WhatsApp] Failed to save connection for ${phoneData.displayPhoneNumber}:`, saveErr.message);
        }
      }
    }

    if (savedConnections.length === 0) {
      return res.redirect(
        buildWhatsAppOAuthCallbackUrl(frontendUrl, {
          whatsapp_error:
            'Could not save WhatsApp connection. The number may already be connected in another workspace.'
        })
      );
    }

    console.log(`✅ [WhatsApp] ${savedConnections.length} connection(s) saved for org ${organizationId}`);
    return res.redirect(
      buildWhatsAppOAuthCallbackUrl(frontendUrl, {
        whatsapp_connected: 'true',
        count: String(savedConnections.length)
      })
    );

  } catch (error) {
    console.error('❌ [WhatsApp] Callback error:', error);
    return res.redirect(
      buildWhatsAppOAuthCallbackUrl(frontendUrl, {
        whatsapp_error: error.message || 'WhatsApp connection failed'
      })
    );
  }
};

/**
 * @desc    Connect WhatsApp using env credentials (dev/fallback — single-tenant)
 * @route   POST /api/platforms/whatsapp/connect-direct
 * @access  Private
 */
exports.connectWhatsApp = async (req, res, next) => {
  try {
    const { connection } = await whatsappConnectionService.connectDirect(
      req.user.organization._id,
      req.user._id
    );
    res.status(200).json({ success: true, data: connection, message: 'WhatsApp connected successfully' });
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({
        success: false,
        error: error.message,
        ...(error.clientMessage && { message: error.clientMessage }),
        ...(error.code && { code: error.code })
      });
    }
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
    const connectionId = req.query.connectionId || req.body?.connectionId || null;
    await whatsappConnectionService.disconnect(req.user.organization._id, connectionId);
    res.status(200).json({ success: true, message: 'WhatsApp disconnected successfully' });
  } catch (error) {
    if (error.statusCode === 404) {
      return res.status(404).json({ success: false, error: error.message });
    }
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
    const status = await whatsappConnectionService.getStatus(req.user.organization._id);
    res.status(200).json({ success: true, data: status });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Register an existing Pending WhatsApp phone number for Cloud API.
 *          Calls POST /{phoneNumberId}/register which moves it from Pending → Active.
 * @route   POST /api/platforms/whatsapp/register-phone
 * @access  Private (org admin)
 */
exports.registerWhatsAppPhone = async (req, res, next) => {
  try {
    const whatsappLoginAuth = require('../integrations/whatsapp/whatsappLoginAuth');
    const PlatformConnection = require('../models/PlatformConnection');

    const { connectionId } = req.body;
    const query = {
      organization: req.user.organization._id,
      platform: 'whatsapp',
      isActive: true
    };
    if (connectionId) query._id = connectionId;

    const conn = await PlatformConnection.findOne(query).lean();
    if (!conn) {
      return res.status(400).json({ success: false, error: 'No active WhatsApp connection found.' });
    }

    const phoneNumberId =
      conn.platformData?.phoneNumberId || conn.platformUserId;
    const accessToken = conn.accessToken || process.env.WHATSAPP_ACCESS_TOKEN;

    if (!phoneNumberId || !accessToken) {
      return res.status(400).json({
        success: false,
        error: 'Phone number id or access token missing on connection.'
      });
    }

    const ok = await whatsappLoginAuth.registerPhoneNumber(phoneNumberId, accessToken);

    // Also (re)subscribe the WABA to webhooks
    const wabaId =
      conn.platformData?.wabaId ||
      conn.platformData?.businessAccountId ||
      process.env.WHATSAPP_BUSINESS_ACCOUNT_ID;
    if (wabaId) {
      await whatsappLoginAuth.subscribeToWebhook(wabaId, accessToken);
    }

    return res.status(200).json({
      success: true,
      registered: ok,
      phoneNumberId,
      wabaId: wabaId || null,
      message: ok
        ? 'Phone number registered. Status should change to Active within a few minutes.'
        : 'Registration call made but Meta returned an unexpected response — check logs.'
    });
  } catch (error) {
    next(error);
  }
};

