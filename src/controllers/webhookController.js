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

    // Process webhook event
    if (eventType === 'NEW_REVIEW' || eventType === 'UPDATE_REVIEW') {
      try {
        // Fetch the specific review
        await googleService.fetchReviews(connection, locationId);
        
        // Queue for AI processing
        await processWebhook({
          platform: 'google',
          type: 'review',
          platformId: reviewId,
          organizationId: connection.organization
        });
      } catch (error) {
        console.error('Error processing Google webhook:', error);
      }
    }

    // Always return 200 to acknowledge receipt
    res.status(200).json({ success: true });
  } catch (error) {
    console.error('Google webhook error:', error);
    // Still return 200 to prevent retries
    res.status(200).json({ success: false, error: error.message });
  }
};

/**
 * @desc    Handle YouTube webhook (via Pub/Sub)
 * @route   POST /api/webhooks/youtube
 * @access  Public (called by Google)
 */
exports.handleYouTubeWebhook = async (req, res, next) => {
  try {
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

    // Find platform connection by channel
    const connection = await PlatformConnection.findOne({
      platform: 'youtube',
      isActive: true
    });

    if (!connection) {
      console.log('No active YouTube connection found');
      return res.status(200).json({ success: true, message: 'No connection found' });
    }

    // Process webhook event
    if (eventType === 'NEW_COMMENT' || eventType === 'UPDATE_COMMENT') {
      try {
        // Fetch comments for the video
        await youtubeService.fetchVideoComments(connection, videoId);
        
        // Queue for AI processing
        await processWebhook({
          platform: 'youtube',
          type: 'comment',
          platformId: commentId,
          organizationId: connection.organization
        });
      } catch (error) {
        console.error('Error processing YouTube webhook:', error);
      }
    }

    // Always return 200 to acknowledge receipt
    res.status(200).json({ success: true });
  } catch (error) {
    console.error('YouTube webhook error:', error);
    // Still return 200 to prevent retries
    res.status(200).json({ success: false, error: error.message });
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

