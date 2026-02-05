/**
 * Meta (Facebook/Instagram) Routes
 * Handles Facebook Pages and Instagram account management
 */

const express = require('express');
const router = express.Router();
const { protect } = require('../middlewares/auth');
const PlatformConnection = require('../models/PlatformConnection');
const metaAuth = require('../integrations/meta/metaAuth');

/**
 * @route   GET /api/meta/pages
 * @desc    Get all Facebook Pages user can manage
 * @access  Private
 */
router.get('/pages', protect, async (req, res) => {
  try {
    // Find user's Facebook connection (contains user access token)
    const fbConnection = await PlatformConnection.findOne({
      user: req.user._id,
      platform: 'facebook',
      status: 'connected'
    });

    if (!fbConnection) {
      return res.status(404).json({ 
        success: false,
        message: 'Facebook not connected. Please connect Facebook first.' 
      });
    }

    // Fetch all pages user can manage from Facebook API
    const pages = await metaAuth.getUserPages(fbConnection.accessToken);

    if (!pages || pages.length === 0) {
      return res.json({ 
        success: true,
        pages: [],
        message: 'No pages found. Make sure you have Facebook Pages you manage.'
      });
    }

    // Get all connected pages/Instagram accounts for this user
    const connectedAccounts = await PlatformConnection.find({
      user: req.user._id,
      organization: req.user.organization,
      platform: { $in: ['facebook', 'instagram'] },
      status: 'connected'
    });

    // Create a map for quick lookup
    const connectedMap = new Map();
    connectedAccounts.forEach(conn => {
      const key = conn.platformPageId || conn.platformUserId;
      connectedMap.set(key, {
        connectionId: conn._id,
        platform: conn.platform,
        username: conn.platformUsername
      });
    });

    // Enrich pages with connection status
    const enrichedPages = pages.map(page => {
      const fbConnection = connectedMap.get(page.id);
      const igConnection = page.instagram_business_account 
        ? connectedMap.get(page.instagram_business_account.id)
        : null;

      return {
        id: page.id,
        name: page.name,
        accessToken: page.access_token, // Will be used when connecting
        hasInstagram: !!page.instagram_business_account,
        instagram: page.instagram_business_account ? {
          id: page.instagram_business_account.id,
          username: page.instagram_business_account.username,
          profilePicture: page.instagram_business_account.profile_picture_url
        } : null,
        connections: {
          facebook: fbConnection ? {
            connected: true,
            connectionId: fbConnection.connectionId,
            username: fbConnection.username
          } : {
            connected: false
          },
          instagram: igConnection ? {
            connected: true,
            connectionId: igConnection.connectionId,
            username: igConnection.username
          } : {
            connected: false
          }
        }
      };
    });

    res.json({ 
      success: true,
      pages: enrichedPages,
      total: enrichedPages.length
    });

  } catch (error) {
    console.error('❌ [Meta Routes] Error fetching pages:', error);
    res.status(500).json({ 
      success: false,
      message: 'Failed to fetch pages',
      error: error.message 
    });
  }
});

/**
 * @route   POST /api/meta/pages/:pageId/connect
 * @desc    Connect a specific Facebook Page or Instagram account
 * @access  Private
 */
router.post('/pages/:pageId/connect', protect, async (req, res) => {
  try {
    const { pageId } = req.params;
    const { platform, pageName, pageAccessToken, instagramData } = req.body;

    // Validate input
    if (!platform || !['facebook', 'instagram'].includes(platform)) {
      return res.status(400).json({ 
        success: false,
        message: 'Invalid platform. Must be "facebook" or "instagram".' 
      });
    }

    if (!pageName || !pageAccessToken) {
      return res.status(400).json({ 
        success: false,
        message: 'Missing required fields: pageName and pageAccessToken' 
      });
    }

    if (platform === 'instagram' && !instagramData) {
      return res.status(400).json({ 
        success: false,
        message: 'Instagram data is required when connecting Instagram' 
      });
    }

    let connection;

    if (platform === 'facebook') {
      // Connect Facebook Page
      connection = await metaAuth.saveFacebookConnection(
        req.user._id,
        req.user.organization,
        { id: pageId, name: pageName },
        pageAccessToken
      );
    } else if (platform === 'instagram') {
      // Connect Instagram account
      const pageData = {
        id: pageId,
        name: pageName,
        instagram_business_account: {
          id: instagramData.id,
          username: instagramData.username,
          profile_picture_url: instagramData.profilePicture
        }
      };

      connection = await metaAuth.saveInstagramConnection(
        req.user._id,
        req.user.organization,
        pageData,
        pageAccessToken
      );
    }

    res.json({ 
      success: true,
      message: `${platform === 'facebook' ? 'Facebook Page' : 'Instagram account'} connected successfully`,
      connection: {
        id: connection._id,
        platform: connection.platform,
        username: connection.platformUsername
      }
    });

  } catch (error) {
    console.error('❌ [Meta Routes] Error connecting page:', error);
    res.status(500).json({ 
      success: false,
      message: 'Failed to connect page',
      error: error.message 
    });
  }
});

/**
 * @route   DELETE /api/meta/connections/:connectionId
 * @desc    Disconnect a Facebook Page or Instagram account
 * @access  Private
 */
router.delete('/connections/:connectionId', protect, async (req, res) => {
  try {
    const { connectionId } = req.params;

    // Find and verify ownership
    const connection = await PlatformConnection.findOne({
      _id: connectionId,
      user: req.user._id
    });

    if (!connection) {
      return res.status(404).json({ 
        success: false,
        message: 'Connection not found or you do not have permission to delete it' 
      });
    }

    const platformName = connection.platform;
    const username = connection.platformUsername;

    // Delete the connection
    await PlatformConnection.findByIdAndDelete(connectionId);

    res.json({ 
      success: true,
      message: `${platformName} account "${username}" disconnected successfully`
    });

  } catch (error) {
    console.error('❌ [Meta Routes] Error disconnecting:', error);
    res.status(500).json({ 
      success: false,
      message: 'Failed to disconnect account',
      error: error.message 
    });
  }
});

/**
 * @route   GET /api/meta/connections
 * @desc    Get all connected Facebook/Instagram accounts for user
 * @access  Private
 */
router.get('/connections', protect, async (req, res) => {
  try {
    const connections = await PlatformConnection.find({
      user: req.user._id,
      organization: req.user.organization,
      platform: { $in: ['facebook', 'instagram'] },
      status: 'connected'
    }).sort({ createdAt: -1 });

    res.json({ 
      success: true,
      connections: connections.map(conn => ({
        id: conn._id,
        platform: conn.platform,
        username: conn.platformUsername,
        displayName: conn.platformDisplayName,
        connectedAt: conn.createdAt,
        lastSync: conn.lastSyncAt,
        status: conn.status
      })),
      total: connections.length
    });

  } catch (error) {
    console.error('❌ [Meta Routes] Error fetching connections:', error);
    res.status(500).json({ 
      success: false,
      message: 'Failed to fetch connections',
      error: error.message 
    });
  }
});

module.exports = router;
