const Interaction = require('../models/Interaction');
const PlatformConnection = require('../models/PlatformConnection');
const googleService = require('../integrations/google/googleService');
const youtubeService = require('../integrations/google/youtubeService');
const { processWebhook } = require('../jobs/processWebhook');
const logger = require('../config/logger');
const logEvents = require('../utils/logEvents');
const { generateChatRef } = require('../utils/chatRefHelper');

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
 * Meta sends: hub.mode=subscribe&hub.verify_token=YOUR_TOKEN&hub.challenge=CHALLENGE
 * We must respond 200 with body = challenge if token matches META_WEBHOOK_VERIFY_TOKEN.
 */
exports.verifyFacebookWebhook = (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  const expectedToken = process.env.META_WEBHOOK_VERIFY_TOKEN;
  const tokenMatches = !!expectedToken && token === expectedToken;

  console.log('Facebook webhook verification request:', {
    mode,
    hasToken: !!token,
    tokenLength: token?.length,
    hasChallenge: !!challenge,
    tokenMatches
  });

  if (mode === 'subscribe' && tokenMatches && challenge) {
    console.log('Facebook webhook verified successfully');
    res.status(200).send(challenge);
  } else {
    const reason = !mode || mode !== 'subscribe' ? 'mode not subscribe'
      : !expectedToken ? 'META_WEBHOOK_VERIFY_TOKEN not set in env'
      : !tokenMatches ? 'verify token does not match META_WEBHOOK_VERIFY_TOKEN'
      : !challenge ? 'missing hub.challenge'
      : 'unknown';
    console.error('Facebook webhook verification failed:', reason);
    res.sendStatus(403);
  }
};

/**
 * Handle Facebook webhook events
 * POST /api/webhooks/facebook
 */
exports.handleFacebookWebhook = async (req, res) => {
  // Log every POST immediately (even empty body) so we know if Meta is calling
  console.log('[Facebook Webhook] POST hit – Meta is calling this URL');

  try {
    // If we get a body but no entry/object, log raw keys to debug Meta's payload format
    const hasBody = !!req.body;
    const bodyKeys = req.body && typeof req.body === 'object' ? Object.keys(req.body) : [];
    const obj = req.body?.object;
    const entryCount = req.body?.entry?.length ?? 0;
    const firstEntry = req.body?.entry?.[0];
    const pageId = firstEntry?.id;
    const hasMessaging = !!(firstEntry?.messaging && firstEntry.messaging.length > 0);

    console.log('[Facebook Webhook] POST received', {
      hasBody,
      object: obj,
      entryCount,
      pageId: pageId || '(no entry.id)',
      hasMessaging,
      messagingCount: firstEntry?.messaging?.length ?? 0
    });

    // When Meta sends something but entry is empty, show what we got so we can fix parsing
    if (hasBody && (entryCount === 0 || !obj)) {
      console.log('[Facebook Webhook] Payload keys:', bodyKeys.join(', '), '| body.entry type:', Array.isArray(req.body?.entry) ? 'array' : typeof req.body?.entry);
    }

    const { webhookQueue } = require('../config/queue');

    // Acknowledge receipt immediately
    res.sendStatus(200);

    // Only process Page webhooks (messages, feed, etc.). Ignore others (e.g. object: 'permissions')
    if (obj !== 'page') {
      if (obj) console.log('[Facebook Webhook] Ignoring non-page object:', obj);
      return;
    }

    if (!firstEntry) {
      console.log('[Facebook Webhook] No entry in payload – nothing to process');
      return;
    }

    // For debugging: if this is a messaging event but we'll skip, log why
    if (hasMessaging) {
      console.log('[Facebook Webhook] Messenger DM event: pageId=%s, sender=%s', pageId, firstEntry.messaging?.[0]?.sender?.id);
    }

    // Determine organization from page ID (must match a connected Page in the app)
    const PlatformConnection = require('../models/PlatformConnection');
    const connection = await PlatformConnection.findOne({
      platform: 'facebook',
      platformPageId: { $in: [String(pageId), pageId].filter(Boolean) },
      isActive: true
    });

    if (!connection) {
      console.log('[Facebook Webhook] No active Facebook connection found for pageId:', pageId, '- Ensure this Page is connected in the app (Settings → Connect Facebook → Page Manager) and that the Page you messaged is the same one.');
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

    console.log('[Facebook Webhook] Queued for processing, pageId=%s', pageId);
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
 * Saves DM to DB immediately in this request so it shows in inbox (with polling) without clicking Sync.
 */
exports.handleInstagramWebhook = async (req, res) => {
  try {
    // Acknowledge receipt immediately so Meta doesn't retry
    res.sendStatus(200);

    console.log('📩 [Instagram Webhook] Received POST:', JSON.stringify(req.body, null, 2));

    const entry = req.body.entry?.[0];
    if (!entry) {
      console.log('No entry in Instagram webhook payload');
      return;
    }

    // Process DMs (messaging/standby), comments, or mentions
    const hasMessaging = entry.messaging && entry.messaging.length > 0;
    const hasStandby = entry.standby && entry.standby.length > 0;
    const hasChanges = entry.changes && entry.changes.length > 0;
    const hasCommentChange = hasChanges && entry.changes.some(c => c.field === 'comments');
    const hasMentionChange = hasChanges && entry.changes.some(c => c.field === 'mentions');
    if (!hasMessaging && !hasStandby && !hasCommentChange && !hasMentionChange) {
      return;
    }

    const instagramId = entry.id;
    const isMetaTestEvent = String(instagramId) === '0';
    const PlatformConnection = require('../models/PlatformConnection');

    // Lookup Facebook Login connections only (exclude IGAA tokens — those are
    // handled by the dedicated /api/webhooks/instagram-login endpoint).
    const fbLoginFilter = {
      platform: 'instagram',
      accessToken: { $not: /^IGAA/ },
      isActive: true
    };

    let connection = await PlatformConnection.findOne({
      ...fbLoginFilter,
      platformUserId: { $in: [instagramId, String(instagramId)].filter(Boolean) }
    });

    if (!connection) {
      connection = await PlatformConnection.findOne({
        ...fbLoginFilter,
        $or: [
          { platformPageId: { $in: [instagramId, String(instagramId)].filter(Boolean) } },
          { 'platformData.businessAccountId': String(instagramId) }
        ]
      });
    }

    if (!connection) {
      if (isMetaTestEvent && hasMentionChange) {
        console.log('[Instagram Webhook] Received Meta test mention event (entry.id=0). This confirms callback URL works.');
      } else {
        console.log(`[Instagram Webhook] No active Instagram connection for account ${instagramId}. Connect this Instagram in Settings → Page Manager to receive DMs/comments/mentions here.`);
      }
      return;
    }

    // If DM arrived in standby, take thread control immediately so we can reply later.
    // "Take control of conversations" must be ON in the Page's app settings for this to work.
    if (hasStandby && !hasMessaging) {
      const axios = require('axios');
      const pageId = connection.platformPageId || connection.platformData?.pageId;
      const accessToken = connection.accessToken;
      if (pageId && accessToken) {
        for (const event of entry.standby) {
          const senderId = event.sender?.id;
          if (!senderId) continue;
          try {
            await axios.post(`https://graph.facebook.com/v19.0/${pageId}/take_thread_control`, null, {
              params: { recipient_id: senderId, access_token: accessToken }
            });
            console.log(`[Instagram Webhook] ✅ Took thread control for standby sender ${senderId}`);
          } catch (ttcErr) {
            console.warn(`[Instagram Webhook] ⚠️ take_thread_control failed for ${senderId}:`, ttcErr.response?.data?.error?.message || ttcErr.message);
          }
        }
      }
    }

    const organizationId = connection.organization.toString();

    // Save DM to DB immediately so inbox polling shows it without Sync
    const processWebhook = require('../jobs/processWebhook');
    try {
      const result = await processWebhook({
        data: { platform: 'instagram', payload: req.body, organizationId },
        id: 'instagram-' + Date.now()
      });
      if (result && result.interactionId) {
        console.log('Instagram webhook processed and DM saved to database');
      }
    } catch (processErr) {
      console.error('Instagram webhook processing error:', processErr.message);
    }
  } catch (error) {
    console.error('Instagram webhook handler error:', error);
    // Don't send error response as we already sent 200
  }
};

// =============================================================================
// Instagram Login (Repmeup-IG app) — separate webhook endpoint
// =============================================================================

/**
 * Verify Instagram Login webhook (Repmeup-IG app)
 * GET /api/webhooks/instagram-login
 */
exports.verifyInstagramLoginWebhook = (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  console.log('[IG-Login Webhook] Verification request:', { mode, token });

  const verifyToken = process.env.INSTAGRAM_LOGIN_WEBHOOK_VERIFY_TOKEN || process.env.META_WEBHOOK_VERIFY_TOKEN;
  if (mode === 'subscribe' && token === verifyToken) {
    console.log('[IG-Login Webhook] Verified successfully');
    res.status(200).send(challenge);
  } else {
    console.error('[IG-Login Webhook] Verification failed');
    res.sendStatus(403);
  }
};

/**
 * Handle Instagram Login webhook events (Repmeup-IG app)
 * POST /api/webhooks/instagram-login
 *
 * Only looks up connections created via Instagram Login (IGAA token prefix).
 * Self-heals the app-scoped → real IG Business Account ID on first webhook.
 */
exports.handleInstagramLoginWebhook = async (req, res) => {
  try {
    res.sendStatus(200);

    console.log('📩 [IG-Login Webhook] Received POST:', JSON.stringify(req.body, null, 2));

    const entry = req.body.entry?.[0];
    if (!entry) return;

    const hasMessaging = entry.messaging && entry.messaging.length > 0;
    const hasStandby = entry.standby && entry.standby.length > 0;
    const hasChanges = entry.changes && entry.changes.length > 0;
    const hasCommentChange = hasChanges && entry.changes.some(c => c.field === 'comments');
    const hasMentionChange = hasChanges && entry.changes.some(c => c.field === 'mentions');
    if (!hasMessaging && !hasStandby && !hasCommentChange && !hasMentionChange) return;

    // entry.id is the global Instagram Business Account ID. Since saveConnection
    // now stores user_id (the same global ID) as platformUserId, the lookup is
    // deterministic — no fallbacks, no self-healing, no cross-account leakage.
    const instagramId = String(entry.id);
    const PlatformConnection = require('../models/PlatformConnection');

    const connection = await PlatformConnection.findOne({
      platform: 'instagram',
      platformUserId: instagramId,
      accessToken: { $regex: /^IGAA/ },
      isActive: true
    });

    if (!connection) {
      console.log(`[IG-Login Webhook] No active Instagram Login connection for account ${instagramId}. Connect this account via Settings → Connect Instagram (Instagram Login).`);
      return;
    }

    const organizationId = connection.organization.toString();

    const processWebhook = require('../jobs/processWebhook');
    try {
      const result = await processWebhook({
        data: { platform: 'instagram', payload: req.body, organizationId },
        id: 'instagram-login-' + Date.now()
      });
      if (result && result.interactionId) {
        console.log('[IG-Login Webhook] Processed and saved to database');
      }
    } catch (processErr) {
      console.error('[IG-Login Webhook] Processing error:', processErr.message);
    }
  } catch (error) {
    console.error('[IG-Login Webhook] Handler error:', error);
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

    console.log('💼 [LinkedIn Webhook] Verification request:', { 
      challengeCode: challengeCode ? 'present' : 'missing',
      applicationId: applicationId || 'none',
      clientSecretSet: !!process.env.LINKEDIN_CLIENT_SECRET
    });

    // Check if client secret is configured
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

    console.log('✅ [LinkedIn Webhook] Challenge response computed');

    // Return JSON response with both challengeCode and challengeResponse
    // Must respond within 3 seconds with 200 OK and content-type: application/json
    const response = {
      challengeCode: challengeCode,
      challengeResponse: challengeResponse
    };

    res.setHeader('Content-Type', 'application/json');
    res.status(200).json(response);

    console.log('✅ [LinkedIn Webhook] Verification response sent', {
      challengeCode: challengeCode.substring(0, 8) + '...',
      responseLength: JSON.stringify(response).length
    });
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
    
    console.log('💼 [LinkedIn Webhook] Received:', JSON.stringify(req.body, null, 2));

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
      
      console.log('✅ [LinkedIn Webhook] Signature verified');
    } else {
      console.warn('⚠️  [LinkedIn Webhook] No X-LI-Signature header present');
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

    console.log('💬 [WhatsApp Webhook] Verification request:', { 
      mode, 
      tokenProvided: !!token,
      challengeProvided: !!challenge 
    });

    // Verify the token and mode
    if (mode === 'subscribe' && token === process.env.META_WEBHOOK_VERIFY_TOKEN) {
      console.log('✅ [WhatsApp Webhook] Verification successful');
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

    console.log('💬 [WhatsApp Webhook] Received event');
    console.log('📦 [WhatsApp Webhook] Request body:', JSON.stringify(req.body, null, 2));
    console.log('📋 [WhatsApp Webhook] Headers:', {
      'x-hub-signature-256': req.headers['x-hub-signature-256'] ? 'present' : 'missing',
      'content-type': req.headers['content-type']
    });

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
      console.log('✅ [WhatsApp Webhook] Signature verified');
    } else {
      console.log('⚠️  [WhatsApp Webhook] Signature verification skipped (no signature or META_APP_SECRET)');
    }

    // Acknowledge receipt immediately
    res.sendStatus(200);

    // Check if it's a WhatsApp Business Account event
    if (req.body.object !== 'whatsapp_business_account') {
      console.log('⏭️  [WhatsApp Webhook] Not a WhatsApp business account event');
      console.log('   Object type:', req.body.object);
      console.log('   Expected: whatsapp_business_account');
      return;
    }

    // Check if there are entries
    if (!req.body.entry || req.body.entry.length === 0) {
      console.log('⏭️  [WhatsApp Webhook] No entries in webhook');
      console.log('   Entry count:', req.body.entry ? req.body.entry.length : 0);
      return;
    }

    console.log(`📥 [WhatsApp Webhook] Processing ${req.body.entry.length} entry/entries`);

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

          console.log(`💬 [WhatsApp Webhook] New message from ${message.from}`);

          // Find platform connection by phone number ID
          console.log(`🔍 [WhatsApp Webhook] Looking for connection with phoneNumberId: ${phoneNumberId}`);
          
          const connection = await PlatformConnection.findOne({
            platform: 'whatsapp',
            'platformData.phoneNumberId': phoneNumberId,
            isActive: true
          }).populate('organization');

          if (!connection) {
            console.log(`⚠️  [WhatsApp Webhook] No active connection found for phone: ${phoneNumberId}`);
            console.log(`   Checking all WhatsApp connections...`);
            
            // Debug: List all WhatsApp connections
            const allConnections = await PlatformConnection.find({ platform: 'whatsapp' });
            console.log(`   Found ${allConnections.length} WhatsApp connection(s) in database:`);
            allConnections.forEach((conn, idx) => {
              console.log(`   [${idx + 1}] ID: ${conn._id}, PhoneNumberId: ${conn.platformData?.phoneNumberId}, Active: ${conn.isActive}`);
            });
            
            continue;
          }

          console.log(`✅ [WhatsApp Webhook] Found connection for: ${connection.platformData.verifiedName}`);

          // Process the message
          const messageData = await whatsappService.processWebhookMessage(req.body);

          if (messageData.success && !messageData.skipped) {
            // Transform to interaction
            const interaction = await whatsappService.transformToInteraction(
              messageData.messageData,
              connection,
              connection.organization
            );

            // Assign chat ticket ref before saving
            try {
              const chatData = await generateChatRef(connection.organization);
              interaction.chatNumber = chatData.chatNumber;
              interaction.chatRef = chatData.chatRef;
            } catch (_chatRefErr) {
              console.warn('[WhatsApp] Could not generate chatRef:', _chatRefErr.message);
            }

            // Save interaction
            const savedInteraction = await Interaction.create(interaction);
            console.log(`✅ [WhatsApp] Interaction saved: ${savedInteraction._id}`);

            // AUTOMATIC SENTIMENT ANALYSIS: Analyze immediately for real-time filtering
            if (savedInteraction.content && !savedInteraction.sentiment) {
              try {
                const aiService = require('../services/aiService');
                const sentimentResult = aiService.fallbackSentimentAnalysis(savedInteraction.content);
                savedInteraction.sentiment = sentimentResult.sentiment;
                savedInteraction.sentimentScore = sentimentResult.sentimentScore;
                savedInteraction.sentimentConfidence = sentimentResult.sentimentConfidence;
                await savedInteraction.save();
                console.log(`🎭 [WhatsApp] Sentiment analyzed: ${sentimentResult.sentiment} for ${savedInteraction._id}`);
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

            // Full AI pipeline + auto-reply queue (respects triggerMode, platforms, types, delay)
            try {
              const { aiQueue } = require('../config/queue');
              const autoReplyScheduler = require('../services/autoReplyScheduler');
              await aiQueue.add(
                { interactionId: savedInteraction._id },
                {
                  attempts: 3,
                  backoff: 2000,
                  jobId: `ai-${savedInteraction._id}`
                }
              );
              const queued = await autoReplyScheduler.queueImmediateAutoReply(
                savedInteraction._id.toString(),
                connection.organization._id.toString()
              );
              if (queued) {
                console.log(`✅ [WhatsApp] AI + auto-reply queued: ${savedInteraction._id}`);
              }
            } catch (queueError) {
              console.error('❌ [WhatsApp] Failed to queue AI/auto-reply:', queueError.message);
            }
          }
        } 
        // Handle message status updates (optional)
        else if (change.field === 'messages' && value.statuses && value.statuses.length > 0) {
          const status = value.statuses[0];
          console.log(`📊 [WhatsApp Webhook] Message status update: ${status.status} for ${status.id}`);
          
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

// ─────────────────────────────────────────────────────────────────────────────
// Product Payment Webhook
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @desc    Handle payment confirmation from any payment provider.
 *          Matches the order by orderToken, sends a confirmation DM, and updates the order.
 * @route   POST /api/webhooks/product-payment
 * @access  Public (verified by HMAC or shared secret header)
 *
 * Expected payload:
 *   { order_token: string, payment_ref?: string, [signature]: string }
 *
 * HMAC verification (optional but recommended):
 *   Set PRODUCT_PAYMENT_SECRET in env; caller must include header `x-repmeup-sig` = HMAC-SHA256(body, secret).
 */
exports.handleProductPaymentWebhook = async (req, res) => {
  // Always ack early so payment provider doesn't retry while we process
  res.sendStatus(200);

  try {
    const crypto = require('crypto');
    const secret = process.env.PRODUCT_PAYMENT_SECRET;

    // If secret is configured, verify the signature
    if (secret) {
      const sig = req.headers['x-repmeup-sig'] || req.headers['x-webhook-sig'] || '';
      const rawBody = typeof req.rawBody === 'string'
        ? req.rawBody
        : JSON.stringify(req.body);
      const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
      if (sig !== expected) {
        console.warn('[ProductPayment] Invalid signature — request rejected');
        return;
      }
    }

    const { order_token: orderToken, payment_ref: paymentRef } = req.body || {};
    if (!orderToken) {
      console.warn('[ProductPayment] Missing order_token in payload');
      return;
    }

    const ProductOrder = require('../models/ProductOrder');
    const Organization = require('../models/Organization');
    const Product = require('../models/Product');
    const commentToDmService = require('../services/commentToDmService');

    const order = await ProductOrder.findOne({ orderToken }).populate('product');
    if (!order) {
      console.warn('[ProductPayment] No ProductOrder found for token', orderToken);
      return;
    }

    if (order.status === 'paid') {
      console.log('[ProductPayment] Order already marked paid — skipping duplicate webhook', orderToken);
      return;
    }

    const product = order.product;
    const organizationId = order.organization.toString();

    // Load confirmation template from org settings
    const org = await Organization.findById(organizationId).select('commentToDmSettings').lean();
    const template = org?.commentToDmSettings?.confirmationTemplate ||
      'Hi! 🎉 Your order for *{{product_name}}* has been confirmed! We\'ll be in touch with shipping details soon. Thank you! 🙏';

    const dmText = commentToDmService.buildTemplate(template, {
      product_name: product?.name || 'your order',
      username: 'there'
    });

    // Resolve Instagram platform connection for this org
    const conn = await PlatformConnection.findOne({
      organization: organizationId,
      platform: 'instagram',
      isActive: true
    }).select('accessToken platformData platformPageId platformUserId metadata').lean();

    if (!conn) {
      console.warn('[ProductPayment] No Instagram connection for org', organizationId);
      return;
    }

    const accessToken = conn.accessToken;
    const connType = conn.metadata?.connectionType
      || (typeof conn.accessToken === 'string' && conn.accessToken.startsWith('IGAA') ? 'instagram_login' : null);
    const pageId = connType === 'instagram_login'
      ? (conn.metadata?.igLoginScopedId || conn.platformUserId)
      : (conn.platformData?.pageId || conn.platformPageId || conn.platformUserId);

    try {
      await require('../integrations/meta/instagramService').sendMessage(
        order.instagramUserId,
        dmText,
        accessToken,
        pageId,
        false,
        connType
      );
      console.log('[ProductPayment] Confirmation DM sent to', order.instagramUserId);
    } catch (dmErr) {
      console.error('[ProductPayment] Failed to send confirmation DM:', dmErr.message);
    }

    // Update order status
    order.status = 'paid';
    order.paymentRef = paymentRef || null;
    order.paidAt = new Date();
    await order.save();

    console.log('[ProductPayment] Order updated to paid', orderToken);
  } catch (err) {
    console.error('[ProductPayment] Webhook handler error:', err.message);
  }
};

