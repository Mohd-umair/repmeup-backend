const PlatformConnection = require('../models/PlatformConnection');
const metaAuth = require('../integrations/meta/metaAuth');
const platformConnectionService = require('../services/platformConnectionService');

/**
 * Meta Pages Controller (Step 8)
 * Handles page selection for Facebook/Instagram connections
 * SOLID: Single Responsibility - Only handles Meta page selection flow
 */

/**
 * @desc    Get user's Facebook pages with connection status
 * @route   GET /api/meta/pages
 * @access  Private
 */
exports.getUserPages = async (req, res, next) => {
  try {
    const organizationId = req.user.organization._id || req.user.organization;

    // Find user-level Facebook connection (needed to get pages)
    // Try with metadata.type first, fallback to just platformPageId: null
    let userConnection = await PlatformConnection.findOne({
      organization: organizationId,
      platform: 'facebook',
      platformPageId: null, // User-level connection
      'metadata.type': 'user_token',
      isActive: true
    });

    // Fallback: If not found, try without metadata.type (for older connections)
    if (!userConnection) {
      console.log('⚠️ [Meta Pages] User connection not found with metadata.type, trying fallback query...');
      userConnection = await PlatformConnection.findOne({
        organization: organizationId,
        platform: 'facebook',
        platformPageId: null, // User-level connection
        isActive: true
      }).sort({ updatedAt: -1 }); // Get most recent
      
      // If found, update it with proper metadata
      if (userConnection && !userConnection.metadata?.type) {
        userConnection.metadata = {
          ...userConnection.metadata,
          type: 'user_token',
          purpose: 'page_management'
        };
        await userConnection.save();
        console.log('✅ [Meta Pages] Updated connection with metadata.type');
      }
    }

    if (!userConnection) {
      return res.status(404).json({
        success: false,
        error: 'No Facebook user connection found. Please connect Facebook first.',
        code: 'USER_CONNECTION_NOT_FOUND'
      });
    }

    // Fetch pages from Facebook API
    const pages = await metaAuth.getUserPages(userConnection.accessToken);
    console.log(`📊 [Meta Pages] Fetched ${pages.length} pages from Facebook API`);

    // Get already connected pages for this organization
    const connectedPages = await PlatformConnection.find({
      organization: organizationId,
      platform: { $in: ['facebook', 'instagram'] },
      isActive: true,
      status: 'connected',
      platformPageId: { $ne: null } // Exclude user-level connection
    });

    const connectedPageIds = new Set(
      connectedPages.map(c => c.platformPageId || c.platformUserId)
    );

    const connectedInstagramIds = new Set(
      connectedPages
        .filter(c => c.platform === 'instagram')
        .map(c => c.platformUserId)
    );

    // Get remaining slots for this organization
    const remainingSlots = await platformConnectionService.getRemainingSlots(organizationId);
    console.log(`📊 [Meta Pages] Remaining slots: ${remainingSlots}, Connected pages: ${connectedPages.length}`);

    // Map pages with connection status
    const pagesWithStatus = pages.map(page => ({
      id: page.id,
      name: page.name,
      accessToken: page.access_token, // Include for connection
      category: page.category,
      hasInstagram: !!page.instagram_business_account,
      instagramAccount: page.instagram_business_account ? {
        id: page.instagram_business_account.id,
        username: page.instagram_business_account.username,
        profilePictureUrl: page.instagram_business_account.profile_picture_url
      } : null,
      isConnectedFacebook: connectedPageIds.has(page.id),
      isConnectedInstagram: page.instagram_business_account 
        ? connectedInstagramIds.has(page.instagram_business_account.id)
        : false,
      canConnect: remainingSlots > 0 || connectedPageIds.has(page.id) // Can reconnect already connected
    }));

    const responseData = {
      success: true,
      data: {
        pages: pagesWithStatus,
        remainingSlots,
        totalPages: pagesWithStatus.length,
        connectedCount: connectedPages.length
      }
    };
    
    console.log(`✅ [Meta Pages] Sending response:`, {
      totalPages: pagesWithStatus.length,
      remainingSlots,
      connectedCount: connectedPages.length,
      pageNames: pagesWithStatus.map(p => p.name)
    });
    
    res.json(responseData);
  } catch (error) {
    console.error('❌ [Meta Pages] Error fetching pages:', error);
    next(error);
  }
};

/**
 * @desc    Connect selected Facebook/Instagram pages
 * @route   POST /api/meta/pages/connect
 * @access  Private
 */
exports.connectSelectedPages = async (req, res, next) => {
  try {
    const { pageIds, includeInstagram } = req.body;
    const organizationId = req.user.organization._id || req.user.organization;
    const userId = req.user._id;

    if (!pageIds || !Array.isArray(pageIds) || pageIds.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Please provide at least one page ID to connect',
        code: 'INVALID_PAGE_IDS'
      });
    }

    // CRITICAL: Check if user can add the requested number of accounts BEFORE starting
    const remainingSlotsCheck = await platformConnectionService.getRemainingSlots(organizationId);
    const requestedAccountsCount = includeInstagram 
      ? pageIds.length * 2  // Each page + Instagram
      : pageIds.length;     // Just Facebook pages
    
    if (remainingSlotsCheck < requestedAccountsCount) {
      console.warn(`⚠️ [Meta Pages] User trying to connect ${requestedAccountsCount} accounts but only ${remainingSlotsCheck} slots remaining`);
      return res.status(403).json({
        success: false,
        error: `Your plan allows ${requestedAccountsCount > 1 ? 'only' : ''} ${remainingSlotsCheck} more account${remainingSlotsCheck !== 1 ? 's' : ''}. You're trying to connect ${requestedAccountsCount}. Please upgrade your plan or select fewer accounts.`,
        code: 'PLAN_LIMIT_EXCEEDED',
        data: {
          requested: requestedAccountsCount,
          remaining: remainingSlotsCheck
        }
      });
    }

    // Find user-level connection for access token
    let userConnection = await PlatformConnection.findOne({
      organization: organizationId,
      platform: 'facebook',
      platformPageId: null,
      'metadata.type': 'user_token',
      isActive: true
    });

    // Fallback: If not found, try without metadata.type (for older connections)
    if (!userConnection) {
      console.log('⚠️ [Meta Pages Connect] User connection not found with metadata.type, trying fallback query...');
      userConnection = await PlatformConnection.findOne({
        organization: organizationId,
        platform: 'facebook',
        platformPageId: null, // User-level connection
        isActive: true
      }).sort({ updatedAt: -1 }); // Get most recent
      
      // If found, update it with proper metadata
      if (userConnection && !userConnection.metadata?.type) {
        userConnection.metadata = {
          ...userConnection.metadata,
          type: 'user_token',
          purpose: 'page_management'
        };
        await userConnection.save();
        console.log('✅ [Meta Pages Connect] Updated connection with metadata.type');
      }
    }

    if (!userConnection) {
      console.error('❌ [Meta Pages Connect] No Facebook user connection found for org:', organizationId);
      return res.status(404).json({
        success: false,
        error: 'User connection not found',
        code: 'USER_CONNECTION_NOT_FOUND'
      });
    }

    console.log('✅ [Meta Pages Connect] Found user connection, fetching pages...');

    // Fetch pages from Facebook API to get tokens
    const pages = await metaAuth.getUserPages(userConnection.accessToken);
    const pagesMap = new Map(pages.map(p => [p.id, p]));

    const results = {
      connected: [],
      failed: [],
      skipped: []
    };

    // Process each page
    for (const pageId of pageIds) {
      const pageData = pagesMap.get(pageId);
      
      if (!pageData) {
        results.failed.push({
          pageId,
          reason: 'Page not found in user pages'
        });
        continue;
      }

      // Check if page is already connected
      const existingFacebookConnection = await PlatformConnection.findOne({
        organization: organizationId,
        platform: 'facebook',
        platformUserId: pageId,
        isActive: true
      });

      if (existingFacebookConnection) {
        results.skipped.push({
          pageId,
          pageName: pageData.name,
          reason: 'Already connected',
          platform: 'facebook'
        });
      } else {
        // CRITICAL: Check fresh limit before each connection
        const limitCheck = await platformConnectionService.canAddConnection(organizationId);
        
        if (!limitCheck.canConnect) {
          console.warn(`⚠️ [Meta Pages] Cannot add page ${pageData.name} - limit reached (${limitCheck.current}/${limitCheck.limit})`);
          results.failed.push({
            pageId,
            pageName: pageData.name,
            reason: 'Plan limit reached. Please upgrade your plan or disconnect an account.',
            platform: 'facebook'
          });
          continue;
        }

        // Connect Facebook page
        try {
          await metaAuth.saveFacebookConnection(
            userId,
            organizationId,
            pageData,
            pageData.access_token
          );
          results.connected.push({
            pageId,
            pageName: pageData.name,
            platform: 'facebook'
          });
          console.log(`✅ [Meta Pages] Connected Facebook page: ${pageData.name}`);
        } catch (error) {
          console.error(`❌ [Meta Pages] Failed to connect Facebook page ${pageId}:`, error);
          results.failed.push({
            pageId,
            pageName: pageData.name,
            reason: error.message,
            platform: 'facebook'
          });
        }
      }

      // Connect Instagram if requested and available
      if (includeInstagram && pageData.instagram_business_account) {
        const instagramId = pageData.instagram_business_account.id;
        
        const existingInstagramConnection = await PlatformConnection.findOne({
          organization: organizationId,
          platform: 'instagram',
          platformUserId: instagramId,
          isActive: true
        });

        if (existingInstagramConnection) {
          results.skipped.push({
            pageId: instagramId,
            pageName: pageData.instagram_business_account.username,
            reason: 'Already connected',
            platform: 'instagram'
          });
        } else {
          // CRITICAL: Check fresh limit before Instagram connection
          const limitCheck = await platformConnectionService.canAddConnection(organizationId);
          
          if (!limitCheck.canConnect) {
            console.warn(`⚠️ [Meta Pages] Cannot add Instagram ${pageData.instagram_business_account.username} - limit reached (${limitCheck.current}/${limitCheck.limit})`);
            results.failed.push({
              pageId: instagramId,
              pageName: pageData.instagram_business_account.username,
              reason: 'Plan limit reached. Please upgrade your plan or disconnect an account.',
              platform: 'instagram'
            });
            continue;
          }

          try {
            await metaAuth.saveInstagramConnection(
              userId,
              organizationId,
              pageData,
              pageData.access_token
            );
            results.connected.push({
              pageId: instagramId,
              pageName: pageData.instagram_business_account.username,
              platform: 'instagram'
            });
            console.log(`✅ [Meta Pages] Connected Instagram: ${pageData.instagram_business_account.username}`);
          } catch (error) {
            console.error(`❌ [Meta Pages] Failed to connect Instagram ${instagramId}:`, error);
            results.failed.push({
              pageId: instagramId,
              pageName: pageData.instagram_business_account.username,
              reason: error.message,
              platform: 'instagram'
            });
          }
        }
      }
    }

    // If all connections failed due to limit, return 403 status
    if (results.connected.length === 0 && results.failed.length > 0 && 
        results.failed.every(f => f.reason.includes('Plan limit'))) {
      return res.status(403).json({
        success: false,
        error: 'Unable to connect any accounts - plan limit reached',
        code: 'PLAN_LIMIT_EXCEEDED',
        data: results
      });
    }

    res.json({
      success: true,
      data: results,
      message: `Connected ${results.connected.length} account(s). ${results.failed.length} failed. ${results.skipped.length} skipped.`
    });
  } catch (error) {
    console.error('❌ [Meta Pages] Error connecting pages:', error);
    next(error);
  }
};

/**
 * @desc    Re-subscribe connected Facebook Pages and Instagram accounts to app webhooks.
 *          Use this after webhook field changes (e.g. mentions) so existing connections receive events.
 * @route   POST /api/meta/pages/resubscribe-webhooks
 * @access  Private
 */
exports.resubscribeFacebookWebhooks = async (req, res, next) => {
  try {
    const organizationId = req.user.organization._id || req.user.organization;

    const fbConnections = await PlatformConnection.find({
      organization: organizationId,
      platform: 'facebook',
      platformPageId: { $exists: true, $ne: null },
      isActive: true,
      status: 'connected'
    }).select('platformPageId platformUsername accessToken').lean();

    const igConnections = await PlatformConnection.find({
      organization: organizationId,
      platform: 'instagram',
      platformUserId: { $exists: true, $ne: null },
      isActive: true,
      status: { $in: ['connected', 'available'] }
    }).select('platformUserId platformUsername accessToken').lean();

    if (fbConnections.length === 0 && igConnections.length === 0) {
      return res.json({
        success: true,
        data: { subscribed: 0, failed: 0, pages: [], instagram: [] },
        message: 'No connected Facebook/Instagram accounts to resubscribe.'
      });
    }

    const results = { subscribed: 0, failed: 0, pages: [], instagram: [] };
    for (const conn of fbConnections) {
      try {
        await metaAuth.subscribePageToWebhook(conn.platformPageId, conn.accessToken);
        results.subscribed++;
        results.pages.push({ pageId: conn.platformPageId, name: conn.platformUsername, ok: true });
      } catch (err) {
        results.failed++;
        results.pages.push({
          pageId: conn.platformPageId,
          name: conn.platformUsername,
          ok: false,
          error: err.message || 'Subscription failed'
        });
      }
    }

    for (const conn of igConnections) {
      try {
        await metaAuth.subscribeInstagramToWebhook(conn.platformUserId, conn.accessToken);
        results.subscribed++;
        results.instagram.push({ instagramId: conn.platformUserId, name: conn.platformUsername, ok: true });
      } catch (err) {
        results.failed++;
        results.instagram.push({
          instagramId: conn.platformUserId,
          name: conn.platformUsername,
          ok: false,
          error: err.message || 'Subscription failed'
        });
      }
    }

    res.json({
      success: true,
      data: results,
      message: `Re-subscribed ${results.subscribed} Facebook/Instagram webhook subscription(s). ${results.failed} failed.`
    });
  } catch (error) {
    console.error('❌ [Meta Pages] Error resubscribing webhooks:', error);
    next(error);
  }
};

/**
 * @desc    Disconnect a specific page
 * @route   DELETE /api/meta/pages/:pageId
 * @access  Private
 */
exports.disconnectPage = async (req, res, next) => {
  try {
    const { pageId } = req.params;
    const { platform } = req.query; // 'facebook' or 'instagram'
    const organizationId = req.user.organization._id || req.user.organization;

    const connection = await PlatformConnection.findOne({
      organization: organizationId,
      platform: platform || 'facebook',
      $or: [
        { platformUserId: pageId },
        { platformPageId: pageId }
      ],
      isActive: true
    });

    if (!connection) {
      return res.status(404).json({
        success: false,
        error: 'Connection not found'
      });
    }

    // Use the platform service to handle disconnect (includes counter decrement)
    const wasCounted = platformConnectionService.shouldCountConnection({
      platform: connection.platform,
      metadata: connection.metadata
    });

    connection.isActive = false;
    connection.status = 'disconnected';
    await connection.save();

    if (wasCounted) {
      await platformConnectionService.decrementConnectionCount(organizationId);
    }

    res.json({
      success: true,
      message: 'Page disconnected successfully'
    });
  } catch (error) {
    console.error('❌ [Meta Pages] Error disconnecting page:', error);
    next(error);
  }
};

module.exports = exports;
