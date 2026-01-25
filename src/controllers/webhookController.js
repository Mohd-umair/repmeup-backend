const Interaction = require('../models/Interaction');
const PlatformConnection = require('../models/PlatformConnection');
const googleService = require('../integrations/google/googleService');
const youtubeService = require('../integrations/google/youtubeService');
const { processWebhook } = require('../jobs/processWebhook');

/**
 * @desc    Handle Google Business Profile webhook
 * @route   POST /api/webhooks/google
 * @access  Public (called by Google)
 */
exports.handleGoogleWebhook = async (req, res, next) => {
  try {
    const { webhookQueue } = require('../config/queue');
    
    // Google webhooks use Pub/Sub format
    const { message } = req.body;

    if (!message) {
      return res.status(400).json({
        success: false,
        error: 'Invalid webhook payload'
      });
    }

    // Decode base64 message data
    const messageData = JSON.parse(Buffer.from(message.data, 'base64').toString());
    const { eventType, locationId, reviewId } = messageData;

    console.log('Google webhook received:', { eventType, locationId, reviewId });

    // Find platform connection by location ID
    const connection = await PlatformConnection.findOne({
      platform: 'google',
      'platformData.locationIds': locationId,
      isActive: true
    });

    if (!connection) {
      console.log(`No active connection found for location ${locationId}`);
      return res.status(200).json({ success: true, message: 'No connection found' });
    }

    // Acknowledge receipt immediately
    res.sendStatus(200);

    // Process webhook event asynchronously
    if (eventType === 'NEW_REVIEW' || eventType === 'UPDATE_REVIEW') {
      try {
        // Fetch the specific review
        await googleService.fetchReviews(connection, locationId);
        
        // Queue webhook for processing (this will trigger auto-reply)
        await webhookQueue.add({
          platform: 'google',
          payload: { eventType, locationId, reviewId },
          organizationId: connection.organization.toString()
        }, {
          attempts: 3,
          backoff: {
            type: 'exponential',
            delay: 2000
          }
        });

        console.log('Google webhook queued for processing');
      } catch (error) {
        console.error('Error processing Google webhook:', error);
      }
    }
  } catch (error) {
    console.error('Google webhook handler error:', error);
    // Don't send error response if we already sent 200
  }
};

/**
 * @desc    Handle YouTube webhook (via Pub/Sub)
 * @route   POST /api/webhooks/youtube
 * @access  Public (called by Google)
 */
exports.handleYouTubeWebhook = async (req, res, next) => {
  try {
    const { webhookQueue } = require('../config/queue');
    
    // YouTube webhooks use Pub/Sub format
    const { message } = req.body;

    if (!message) {
      return res.status(400).json({
        success: false,
        error: 'Invalid webhook payload'
      });
    }

    // Decode base64 message data
    const messageData = JSON.parse(Buffer.from(message.data, 'base64').toString());
    const { videoId, commentId, eventType } = messageData;

    console.log('YouTube webhook received:', { videoId, commentId, eventType });

    // Find platform connection by channel
    const connection = await PlatformConnection.findOne({
      platform: 'youtube',
      isActive: true
    });

    if (!connection) {
      console.log('No active YouTube connection found');
      return res.status(200).json({ success: true, message: 'No connection found' });
    }

    // Acknowledge receipt immediately
    res.sendStatus(200);

    // Process webhook event asynchronously
    if (eventType === 'NEW_COMMENT' || eventType === 'UPDATE_COMMENT') {
      try {
        // Fetch comments for the video to ensure we have the latest data
        await youtubeService.fetchVideoComments(connection, videoId);
        
        // Queue webhook for processing (this will trigger auto-reply)
        await webhookQueue.add({
          platform: 'youtube',
          payload: { videoId, commentId, eventType },
          organizationId: connection.organization.toString()
        }, {
          attempts: 3,
          backoff: {
            type: 'exponential',
            delay: 2000
          }
        });

        console.log('YouTube webhook queued for processing');
      } catch (error) {
        console.error('Error processing YouTube webhook:', error);
      }
    }
  } catch (error) {
    console.error('YouTube webhook handler error:', error);
    // Don't send error response if we already sent 200
  }
};

/**
 * @desc    Verify webhook (for Google Pub/Sub)
 * @route   GET /api/webhooks/google
 * @access  Public
 */
exports.verifyGoogleWebhook = async (req, res, next) => {
  try {
    // Google Pub/Sub sends verification request
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    // Verify token matches your configured token
    if (mode === 'subscribe' && token === process.env.GOOGLE_WEBHOOK_VERIFY_TOKEN) {
      res.status(200).send(challenge);
    } else {
      res.status(403).send('Verification failed');
    }
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Verify YouTube webhook
 * @route   GET /api/webhooks/youtube
 * @access  Public
 */
exports.verifyYouTubeWebhook = async (req, res, next) => {
  try {
    // YouTube uses same Pub/Sub verification
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode === 'subscribe' && token === process.env.YOUTUBE_WEBHOOK_VERIFY_TOKEN) {
      res.status(200).send(challenge);
    } else {
      res.status(403).send('Verification failed');
    }
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Health check for webhooks
 * @route   GET /api/webhooks/health
 * @access  Public
 */
exports.webhookHealth = async (req, res) => {
  res.status(200).json({
    success: true,
    message: 'Webhook endpoint is active',
    timestamp: new Date().toISOString()
  });
};

/**
 * Verify Facebook webhook
 * GET /api/webhooks/facebook
 */
exports.verifyFacebookWebhook = (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  console.log('Facebook webhook verification request:', { mode, token });

  if (mode === 'subscribe' && token === process.env.META_WEBHOOK_VERIFY_TOKEN) {
    console.log('Facebook webhook verified successfully');
    res.status(200).send(challenge);
  } else {
    console.error('Facebook webhook verification failed');
    res.sendStatus(403);
  }
};

/**
 * Handle Facebook webhook events
 * POST /api/webhooks/facebook
 */
exports.handleFacebookWebhook = async (req, res) => {
  try {
    const { webhookQueue } = require('../config/queue');
    
    console.log('Facebook webhook received:', JSON.stringify(req.body, null, 2));

    // Acknowledge receipt immediately
    res.sendStatus(200);

    // Process webhook asynchronously
    const entry = req.body.entry?.[0];
    if (!entry) {
      console.log('No entry in Facebook webhook payload');
      return;
    }

    // Determine organization from page ID
    const pageId = entry.id;
    const PlatformConnection = require('../models/PlatformConnection');
    const connection = await PlatformConnection.findOne({
      platform: 'facebook',
      platformPageId: pageId,
      isActive: true
    });

    if (!connection) {
      console.log(`No active Facebook connection found for page: ${pageId}`);
      return;
    }

    // Queue webhook for processing
    await webhookQueue.add({
      platform: 'facebook',
      payload: req.body,
      organizationId: connection.organization.toString()
    }, {
      attempts: 3,
      backoff: {
        type: 'exponential',
        delay: 2000
      }
    });

    console.log('Facebook webhook queued for processing');
  } catch (error) {
    console.error('Facebook webhook handler error:', error);
    // Don't send error response as we already sent 200
  }
};

/**
 * Verify Instagram webhook
 * GET /api/webhooks/instagram
 */
exports.verifyInstagramWebhook = (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  console.log('Instagram webhook verification request:', { mode, token });

  if (mode === 'subscribe' && token === process.env.META_WEBHOOK_VERIFY_TOKEN) {
    console.log('Instagram webhook verified successfully');
    res.status(200).send(challenge);
  } else {
    console.error('Instagram webhook verification failed');
    res.sendStatus(403);
  }
};

/**
 * Handle Instagram webhook events
 * POST /api/webhooks/instagram
 */
exports.handleInstagramWebhook = async (req, res) => {
  try {
    const { webhookQueue } = require('../config/queue');
    
    console.log('Instagram webhook received:', JSON.stringify(req.body, null, 2));

    // Acknowledge receipt immediately
    res.sendStatus(200);

    // Process webhook asynchronously
    const entry = req.body.entry?.[0];
    if (!entry) {
      console.log('No entry in Instagram webhook payload');
      return;
    }

    // Determine organization from Instagram account ID
    const instagramId = entry.id;
    const PlatformConnection = require('../models/PlatformConnection');
    const connection = await PlatformConnection.findOne({
      platform: 'instagram',
      platformUserId: instagramId,
      isActive: true
    });

    if (!connection) {
      console.log(`No active Instagram connection found for account: ${instagramId}`);
      return;
    }

    // Queue webhook for processing
    await webhookQueue.add({
      platform: 'instagram',
      payload: req.body,
      organizationId: connection.organization.toString()
    }, {
      attempts: 3,
      backoff: {
        type: 'exponential',
        delay: 2000
      }
    });

    console.log('Instagram webhook queued for processing');
  } catch (error) {
    console.error('Instagram webhook handler error:', error);
    // Don't send error response as we already sent 200
  }
};

/**
 * Verify LinkedIn webhook
 * GET /api/webhooks/linkedin
 */
exports.verifyLinkedInWebhook = (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  console.log('💼 [LinkedIn Webhook] Verification request:', { mode, token });

  if (mode === 'subscribe' && token === process.env.LINKEDIN_WEBHOOK_VERIFY_TOKEN) {
    console.log('✅ [LinkedIn Webhook] Verified successfully');
    res.status(200).send(challenge);
  } else {
    console.error('❌ [LinkedIn Webhook] Verification failed');
    res.sendStatus(403);
  }
};

/**
 * Handle LinkedIn webhook events
 * POST /api/webhooks/linkedin
 * 
 * LinkedIn webhook events include:
 * - SHARE_CREATED: When a new post is created
 * - SHARE_COMMENT_CREATED: When someone comments on a post
 * - SHARE_COMMENT_UPDATED: When a comment is edited
 * - SHARE_LIKE_CREATED: When someone likes a post
 */
exports.handleLinkedInWebhook = async (req, res) => {
  try {
    const { webhookQueue } = require('../config/queue');
    const crypto = require('crypto');
    
    console.log('💼 [LinkedIn Webhook] Received:', JSON.stringify(req.body, null, 2));

    // Verify webhook signature for security
    const signature = req.headers['x-linkedin-signature'];
    if (signature && process.env.LINKEDIN_WEBHOOK_SECRET) {
      const expectedSignature = crypto
        .createHmac('sha256', process.env.LINKEDIN_WEBHOOK_SECRET)
        .update(JSON.stringify(req.body))
        .digest('hex');
      
      if (signature !== expectedSignature) {
        console.error('❌ [LinkedIn Webhook] Invalid signature');
        return res.sendStatus(403);
      }
    }

    // Acknowledge receipt immediately
    res.sendStatus(200);

    // Process webhook asynchronously
    const { eventType, organizationUrn, data } = req.body;
    
    if (!eventType || !data) {
      console.log('⚠️  [LinkedIn Webhook] Invalid payload structure');
      return;
    }

    // Extract organization ID from URN (format: urn:li:organization:12345)
    const orgId = organizationUrn?.split(':').pop();
    
    if (!orgId) {
      console.log('⚠️  [LinkedIn Webhook] No organization ID in payload');
      return;
    }

    // Find platform connection by organization URN or platform page ID
    const connection = await PlatformConnection.findOne({
      platform: 'linkedin',
      $or: [
        { 'platformData.organizationUrn': organizationUrn },
        { 'platformData.organizationId': orgId },
        { platformPageId: orgId }
      ],
      isActive: true
    });

    if (!connection) {
      console.log(`⚠️  [LinkedIn Webhook] No active connection found for org: ${orgId}`);
      return;
    }

    console.log(`✅ [LinkedIn Webhook] Found connection for org: ${connection.platformName}`);

    // Queue webhook for processing based on event type
    await webhookQueue.add({
      platform: 'linkedin',
      eventType,
      payload: req.body,
      organizationId: connection.organization.toString(),
      connectionId: connection._id.toString()
    }, {
      attempts: 3,
      backoff: {
        type: 'exponential',
        delay: 2000
      }
    });

    console.log(`✅ [LinkedIn Webhook] Queued ${eventType} for processing`);
  } catch (error) {
    console.error('❌ [LinkedIn Webhook] Handler error:', error);
    // Don't send error response as we already sent 200
  }
};

