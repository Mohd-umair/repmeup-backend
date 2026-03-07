const Interaction = require('../models/Interaction');
const PlatformConnection = require('../models/PlatformConnection');
const googleService = require('../integrations/google/googleService');
const youtubeService = require('../integrations/google/youtubeService');
const { processWebhook } = require('../jobs/processWebhook');
const logger = require('../config/logger');
const logEvents = require('../utils/logEvents');

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

    logEvents.webhook.received({
      platform: 'google',
      eventType,
      objectId: reviewId || locationId
    });

    // Find platform connection by location ID
    const connection = await PlatformConnection.findOne({
      platform: 'google',
      'platformData.locationIds': locationId,
      isActive: true
    });

    if (!connection) {
      req.log?.info('No active connection found for webhook', { 
        platform: 'google',
        locationId 
      });
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

    // Find platform connection by channel
    const connection = await PlatformConnection.findOne({
      platform: 'youtube',
      isActive: true
    });

    if (!connection) {
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

  if (mode === 'subscribe' && token === process.env.META_WEBHOOK_VERIFY_TOKEN) {
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

    // Acknowledge receipt immediately
    res.sendStatus(200);

    const entry = req.body.entry?.[0];
    if (!entry) return;

    // Determine organization from page ID
    const pageId = entry.id;
    const PlatformConnection = require('../models/PlatformConnection');
    const connection = await PlatformConnection.findOne({
      platform: 'facebook',
      platformPageId: { $in: [String(pageId), pageId].filter(Boolean) },
      isActive: true
    });

    if (!connection) return;

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

  if (mode === 'subscribe' && token === process.env.META_WEBHOOK_VERIFY_TOKEN) {
    res.status(200).send(challenge);
  } else {
    console.error('Instagram webhook verification failed');
    res.sendStatus(403);
  }
};

/**
 * Handle Instagram webhook events
 * POST /api/webhooks/instagram
 * Saves DM to DB immediately in this request so it shows in inbox (with polling) without clicking Sync.
 */
exports.handleInstagramWebhook = async (req, res) => {
  try {
    // Acknowledge receipt immediately so Meta doesn't retry
    res.sendStatus(200);

    const entry = req.body.entry?.[0];
    if (!entry) return;

    // Don't skip when standby has messages — we'll process standby in the job (same as incoming DMs)
    const hasMessaging = entry.messaging && entry.messaging.length > 0;
    const hasStandby = entry.standby && entry.standby.length > 0;
    if (!hasMessaging && !hasStandby) {
      return;
    }

    const instagramId = entry.id;
    const PlatformConnection = require('../models/PlatformConnection');
    const connection = await PlatformConnection.findOne({
      platform: 'instagram',
      platformUserId: { $in: [instagramId, String(instagramId)].filter(Boolean) },
      isActive: true
    });

    if (!connection) return;

    const organizationId = connection.organization.toString();

    // Save DM to DB immediately so inbox polling shows it without Sync
    const processWebhook = require('../jobs/processWebhook');
    try {
      const result = await processWebhook({
        data: { platform: 'instagram', payload: req.body, organizationId },
        id: 'instagram-' + Date.now()
      });
    } catch (processErr) {
      console.error('Instagram webhook processing error:', processErr.message);
    }
  } catch (error) {
    console.error('Instagram webhook handler error:', error);
    // Don't send error response as we already sent 200
  }
};

/**
 * Verify LinkedIn webhook
 * GET /api/webhooks/linkedin
 * 
 * LinkedIn uses HMACSHA256 challenge-response validation:
 * 1. LinkedIn sends challengeCode (UUID) as query parameter
 * 2. We compute: challengeResponse = Hex(HMACSHA256(challengeCode, clientSecret))
 * 3. Return JSON: { challengeCode, challengeResponse }
 * 
 * Reference: https://learn.microsoft.com/en-us/linkedin/shared/api-guide/webhook-validation
 */
exports.verifyLinkedInWebhook = (req, res) => {
  try {
    const crypto = require('crypto');
    const challengeCode = req.query['challengeCode'];
    const applicationId = req.query['applicationId']; // For parent-child apps

    if (!process.env.LINKEDIN_CLIENT_SECRET) {
      console.error('❌ [LinkedIn Webhook] LINKEDIN_CLIENT_SECRET not set in environment');
      return res.status(500).json({
        error: 'LinkedIn client secret not configured',
        message: 'Please set LINKEDIN_CLIENT_SECRET in your .env file'
      });
    }

    // Check if challenge code is provided
    if (!challengeCode) {
      console.error('❌ [LinkedIn Webhook] No challengeCode provided');
      return res.status(400).json({
        error: 'Missing challenge code',
        message: 'LinkedIn must provide challengeCode query parameter'
      });
    }

    // Compute challenge response using HMACSHA256
    // challengeResponse = Hex-encoded(HMACSHA256(challengeCode, clientSecret))
    const clientSecret = process.env.LINKEDIN_CLIENT_SECRET;
    const challengeResponse = crypto
      .createHmac('sha256', clientSecret)
      .update(challengeCode)
      .digest('hex');

    // Return JSON response with both challengeCode and challengeResponse
    // Must respond within 3 seconds with 200 OK and content-type: application/json
    const response = {
      challengeCode: challengeCode,
      challengeResponse: challengeResponse
    };

    res.setHeader('Content-Type', 'application/json');
    res.status(200).json(response);
  } catch (error) {
    console.error('❌ [LinkedIn Webhook] Verification error:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
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

    // Verify webhook signature for security
    // LinkedIn uses X-LI-Signature header with format: hmacsha256=<hash>
    // The hash is computed on the JSON body prefixed by "hmacsha256="
    const signatureHeader = req.headers['x-li-signature'];
    
    if (signatureHeader) {
      if (!process.env.LINKEDIN_CLIENT_SECRET) {
        console.error('❌ [LinkedIn Webhook] LINKEDIN_CLIENT_SECRET not set for signature verification');
        return res.sendStatus(500);
      }

      // Extract the hash from "hmacsha256=<hash>" format
      const signature = signatureHeader.replace('hmacsha256=', '');
      
      // Compute expected signature: HMACSHA256("hmacsha256=" + JSON body, clientSecret)
      const bodyString = JSON.stringify(req.body);
      const expectedSignature = crypto
        .createHmac('sha256', process.env.LINKEDIN_CLIENT_SECRET)
        .update('hmacsha256=' + bodyString)
        .digest('hex');
      
      if (signature !== expectedSignature) {
        console.error('❌ [LinkedIn Webhook] Invalid signature', {
          received: signature.substring(0, 10) + '...',
          expected: expectedSignature.substring(0, 10) + '...'
        });
        return res.sendStatus(403);
      }
    }

    // Acknowledge receipt immediately
    res.sendStatus(200);

    // Process webhook asynchronously
    const { eventType, organizationUrn, data } = req.body;
    
    if (!eventType || !data) return;

    // Extract organization ID
    const orgId = organizationUrn?.split(':').pop();
    
    if (!orgId) return;

    // Find platform connection
    const connection = await PlatformConnection.findOne({
      platform: 'linkedin',
      $or: [
        { 'platformData.organizationUrn': organizationUrn },
        { 'platformData.organizationId': orgId },
        { platformPageId: orgId }
      ],
      isActive: true
    });

    if (!connection) return;

    // Queue webhook for processing
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

  } catch (error) {
    console.error('❌ [LinkedIn Webhook] Handler error:', error);
    // Don't send error response as we already sent 200
  }
};

/**
 * @desc    Verify WhatsApp webhook
 * @route   GET /api/webhooks/whatsapp
 * @access  Public (called by Meta)
 */
exports.verifyWhatsAppWebhook = (req, res) => {
  try {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.META_WEBHOOK_VERIFY_TOKEN) {
    res.status(200).send(challenge);
  } else {
    console.error('❌ [WhatsApp Webhook] Verification failed');
    res.sendStatus(403);
  }
  } catch (error) {
    console.error('❌ [WhatsApp Webhook] Verification error:', error);
    res.sendStatus(500);
  }
};

/**
 * @desc    Handle WhatsApp webhook
 * @route   POST /api/webhooks/whatsapp
 * @access  Public (called by Meta)
 */
exports.handleWhatsAppWebhook = async (req, res) => {
  try {
    const { webhookQueue } = require('../config/queue');
    const whatsappService = require('../integrations/whatsapp/whatsappService');
    const PlatformConnection = require('../models/PlatformConnection');
    const Interaction = require('../models/Interaction');

    // Verify webhook signature (Meta signature verification)
    const signature = req.headers['x-hub-signature-256'];
    if (signature && process.env.META_APP_SECRET) {
      const crypto = require('crypto');
      const expectedSignature = 'sha256=' + crypto
        .createHmac('sha256', process.env.META_APP_SECRET)
        .update(JSON.stringify(req.body))
        .digest('hex');

      if (signature !== expectedSignature) {
        console.error('❌ [WhatsApp Webhook] Invalid signature');
        console.error('   Expected:', expectedSignature);
        console.error('   Received:', signature);
        return res.sendStatus(403);
      }
    }

    // Acknowledge receipt immediately
    res.sendStatus(200);

    // Check if it's a WhatsApp Business Account event
    if (req.body.object !== 'whatsapp_business_account') return;

    if (!req.body.entry || req.body.entry.length === 0) return;

    // Process each entry
    for (const entry of req.body.entry) {
      if (!entry.changes || entry.changes.length === 0) {
        continue;
      }

      for (const change of entry.changes) {
        const value = change.value;
        
        // Check if it's a message event
        if (change.field === 'messages' && value.messages && value.messages.length > 0) {
          const message = value.messages[0];
          const phoneNumberId = value.metadata.phone_number_id;

          const connection = await PlatformConnection.findOne({
            platform: 'whatsapp',
            'platformData.phoneNumberId': phoneNumberId,
            isActive: true
          }).populate('organization');

          if (!connection) {
            continue;
          }

          // Process the message
          const messageData = await whatsappService.processWebhookMessage(req.body);

          if (messageData.success && !messageData.skipped) {
            // Transform to interaction
            const interaction = await whatsappService.transformToInteraction(
              messageData.messageData,
              connection,
              connection.organization
            );

            // Save interaction
            const savedInteraction = await Interaction.create(interaction);

            // AUTOMATIC SENTIMENT ANALYSIS: Analyze immediately for real-time filtering
            if (savedInteraction.content && !savedInteraction.sentiment) {
              try {
                const aiService = require('../services/aiService');
                const sentimentResult = aiService.fallbackSentimentAnalysis(savedInteraction.content);
                savedInteraction.sentiment = sentimentResult.sentiment;
                savedInteraction.sentimentScore = sentimentResult.sentimentScore;
                savedInteraction.sentimentConfidence = sentimentResult.sentimentConfidence;
                await savedInteraction.save();
              } catch (sentError) {
                console.error(`⚠️ [WhatsApp] Sentiment analysis failed:`, sentError.message);
              }
            }

            // Mark message as read (optional)
            try {
              await whatsappService.markAsRead(message.id);
            } catch (readError) {
              console.error('❌ [WhatsApp] Failed to mark as read:', readError.message);
            }

            // Queue for auto-reply processing
            const organization = connection.organization;
            if (organization.autoReplySettings && organization.autoReplySettings.enabled) {
              try {
                const { autoReplyQueue } = require('../config/queue');
                await autoReplyQueue.add({
                  interactionId: savedInteraction._id.toString(),
                  organizationId: connection.organization._id.toString(),
                  platform: 'whatsapp'
                }, {
                  attempts: 3,
                  backoff: {
                    type: 'exponential',
                    delay: 2000
                  }
                });
              } catch (queueError) {
                console.error('❌ [WhatsApp] Failed to queue auto-reply:', queueError.message);
              }
            }
          }
        } 
        // Handle message status updates (optional)
        else if (change.field === 'messages' && value.statuses && value.statuses.length > 0) {
          const status = value.statuses[0];
          
          // Update interaction status in database
          await Interaction.updateOne(
            { platformId: status.id, platform: 'whatsapp' },
            { 
              $set: { 
                'metadata.deliveryStatus': status.status,
                'metadata.statusTimestamp': new Date(parseInt(status.timestamp) * 1000)
              } 
            }
          );
        }
      }
    }

  } catch (error) {
    console.error('❌ [WhatsApp Webhook] Handler error:', error);
    // Don't send error response as we already sent 200
  }
};

