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
    const userConnection = await PlatformConnection.findOne({
      organization: organizationId,
      platform: 'facebook',
      platformPageId: null, // User-level connection
      'metadata.type': 'user_token',
      isActive: true
    });

    if (!userConnection) {
      return res.status(404).json({
        success: false,
        error: 'No Facebook user connection found. Please connect Facebook first.',
        code: 'USER_CONNECTION_NOT_FOUND'
      });
    }

    // Fetch pages from Facebook API
    const pages = await metaAuth.getUserPages(userConnection.accessToken);

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

    res.json({
      success: true,
      data: {
        pages: pagesWithStatus,
        remainingSlots,
        totalPages: pagesWithStatus.length,
        connectedCount: connectedPages.length
      }
    });
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

    // Find user-level connection for access token
    const userConnection = await PlatformConnection.findOne({
      organization: organizationId,
      platform: 'facebook',
      platformPageId: null,
      'metadata.type': 'user_token',
      isActive: true
    });

    if (!userConnection) {
      return res.status(404).json({
        success: false,
        error: 'User connection not found',
        code: 'USER_CONNECTION_NOT_FOUND'
      });
    }

    // Fetch pages from Facebook API to get tokens
    const pages = await metaAuth.getUserPages(userConnection.accessToken);
    const pagesMap = new Map(pages.map(p => [p.id, p]));

    const results = {
      connected: [],
      failed: [],
      skipped: []
    };

    // Check remaining slots before starting
    let remainingSlots = await platformConnectionService.getRemainingSlots(organizationId);

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
        // Check if we have remaining slots
        if (remainingSlots <= 0) {
          results.failed.push({
            pageId,
            pageName: pageData.name,
            reason: 'Plan limit reached',
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
          remainingSlots--;
        } catch (error) {
          console.error(`Failed to connect Facebook page ${pageId}:`, error);
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
          // Check limit again
          if (remainingSlots <= 0) {
            results.failed.push({
              pageId: instagramId,
              pageName: pageData.instagram_business_account.username,
              reason: 'Plan limit reached',
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
            remainingSlots--;
          } catch (error) {
            console.error(`Failed to connect Instagram ${instagramId}:`, error);
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
