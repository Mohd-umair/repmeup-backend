const Interaction = require('../models/Interaction');
const PlatformConnection = require('../models/PlatformConnection');
const googleService = require('../integrations/google/googleService');
const youtubeService = require('../integrations/google/youtubeService');
const logger = require('../config/logger');
const { ingestInstagramWebhook } = require('../services/webhook/instagramWebhookIngress');
const logEvents = require('../utils/logEvents');
const { generateChatRef } = require('../utils/chatRefHelper');
const { upsertWhatsAppThread } = require('../services/webhook/whatsappWebhookService');

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

        logger.info('Google webhook queued for processing');
      } catch (error) {
        logger.error('Error processing Google webhook', { error: error.message, stack: error.stack });
      }
    }
  } catch (error) {
    logger.error('Google webhook handler error', { error: error.message, stack: error.stack });
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

    logger.info('YouTube webhook received', { videoId, commentId, eventType });

    // Find platform connection by channel
    const connection = await PlatformConnection.findOne({
      platform: 'youtube',
      isActive: true
    });

    if (!connection) {
      logger.info('No active YouTube connection found');
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

        logger.info('YouTube webhook queued for processing');
      } catch (error) {
        logger.error('Error processing YouTube webhook', { error: error.message, stack: error.stack });
      }
    }
  } catch (error) {
    logger.error('YouTube webhook handler error', { error: error.message, stack: error.stack });
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

  logger.info('Facebook webhook verification request', {
    mode,
    hasToken: !!token,
    tokenLength: token?.length,
    hasChallenge: !!challenge,
    tokenMatches
  });

  if (mode === 'subscribe' && tokenMatches && challenge) {
    logger.info('Facebook webhook verified successfully');
    res.status(200).send(challenge);
  } else {
    const reason = !mode || mode !== 'subscribe' ? 'mode not subscribe'
      : !expectedToken ? 'META_WEBHOOK_VERIFY_TOKEN not set in env'
      : !tokenMatches ? 'verify token does not match META_WEBHOOK_VERIFY_TOKEN'
      : !challenge ? 'missing hub.challenge'
      : 'unknown';
    logger.error('Facebook webhook verification failed', { reason });
    res.sendStatus(403);
  }
};

/**
 * Handle Facebook webhook events
 * POST /api/webhooks/facebook
 */
exports.handleFacebookWebhook = async (req, res) => {
  // Log every POST immediately (even empty body) so we know if Meta is calling
  logger.info('[Facebook Webhook] POST hit – Meta is calling this URL');

  try {
    const obj = req.body?.object;

    // Meta often sends Instagram messaging (object: "instagram") to the same callback URL as Page webhooks.
    if (obj === 'instagram') {
      logger.info('[Facebook Webhook] Routing object=instagram to Instagram handler');
      return exports.handleInstagramWebhook(req, res);
    }

    // If we get a body but no entry/object, log raw keys to debug Meta's payload format
    const hasBody = !!req.body;
    const bodyKeys = req.body && typeof req.body === 'object' ? Object.keys(req.body) : [];
    const entryCount = req.body?.entry?.length ?? 0;
    const firstEntry = req.body?.entry?.[0];
    const pageId = firstEntry?.id;
    const hasMessaging = !!(firstEntry?.messaging && firstEntry.messaging.length > 0);

    logger.info('[Facebook Webhook] POST received', {
      hasBody,
      object: obj,
      entryCount,
      pageId: pageId || '(no entry.id)',
      hasMessaging,
      messagingCount: firstEntry?.messaging?.length ?? 0
    });

    // When Meta sends something but entry is empty, show what we got so we can fix parsing
    if (hasBody && (entryCount === 0 || !obj)) {
      logger.info('[Facebook Webhook] Payload keys', { keys: bodyKeys.join(', '), entryType: Array.isArray(req.body?.entry) ? 'array' : typeof req.body?.entry });
    }

    const { webhookQueue } = require('../config/queue');

    // Acknowledge receipt immediately
    res.sendStatus(200);

    // Only process Page webhooks (messages, feed, etc.). Ignore others (e.g. object: 'permissions')
    if (obj !== 'page') {
      if (obj) logger.info('[Facebook Webhook] Ignoring non-page object', { obj });
      return;
    }

    if (!firstEntry) {
      logger.info('[Facebook Webhook] No entry in payload – nothing to process');
      return;
    }

    // For debugging: if this is a messaging event but we'll skip, log why
    if (hasMessaging) {
      logger.info('[Facebook Webhook] Messenger DM event: pageId=%s, sender=%s', { pageId, id: firstEntry.messaging?.[0]?.sender?.id });
    }

    // Determine organization from page ID (must match a connected Page in the app)
    const PlatformConnection = require('../models/PlatformConnection');
    const connection = await PlatformConnection.findOne({
      platform: 'facebook',
      platformPageId: { $in: [String(pageId), pageId].filter(Boolean) },
      isActive: true
    });

    if (!connection) {
      logger.info('[Facebook Webhook] No active Facebook connection found for pageId — ensure this Page is connected in the app (Settings → Connect Facebook → Page Manager) and that the Page you messaged is the same one', { pageId });
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

    logger.info('[Facebook Webhook] Queued for processing, pageId=%s', { pageId });
  } catch (error) {
    logger.error('Facebook webhook handler error', { error: error.message, stack: error.stack });
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

  logger.info('Instagram webhook verification request', { mode, token });

  const expectedToken =
    process.env.INSTAGRAM_LOGIN_WEBHOOK_VERIFY_TOKEN || process.env.META_WEBHOOK_VERIFY_TOKEN;

  if (mode === 'subscribe' && token === expectedToken) {
    logger.info('Instagram webhook verified successfully');
    res.status(200).send(challenge);
  } else {
    logger.error('Instagram webhook verification failed');
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
    res.sendStatus(200);

    logger.info('[Instagram Webhook] Received POST', {
      object: req.body?.object,
      entryId: req.body?.entry?.[0]?.id
    });

    await ingestInstagramWebhook(req.body, '[Instagram Webhook]');
  } catch (error) {
    logger.error('Instagram webhook handler error', { error: error.message, stack: error.stack });
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

  logger.info('[IG-Login Webhook] Verification request', { mode, token });

  const verifyToken = process.env.INSTAGRAM_LOGIN_WEBHOOK_VERIFY_TOKEN || process.env.META_WEBHOOK_VERIFY_TOKEN;
  if (mode === 'subscribe' && token === verifyToken) {
    logger.info('[IG-Login Webhook] Verified successfully');
    res.status(200).send(challenge);
  } else {
    logger.error('[IG-Login Webhook] Verification failed');
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

    logger.info('[IG-Login Webhook] Received POST', {
      object: req.body?.object,
      entryId: req.body?.entry?.[0]?.id
    });

    await ingestInstagramWebhook(req.body, '[IG-Login Webhook]');
  } catch (error) {
    logger.error('[IG-Login Webhook] Handler error', { error: error.message, stack: error.stack });
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

    logger.info('💼 [LinkedIn Webhook] Verification request', { 
      challengeCode: challengeCode ? 'present' : 'missing',
      applicationId: applicationId || 'none',
      clientSecretSet: !!process.env.LINKEDIN_CLIENT_SECRET
    });

    // Check if client secret is configured
    if (!process.env.LINKEDIN_CLIENT_SECRET) {
      logger.error('❌ [LinkedIn Webhook] LINKEDIN_CLIENT_SECRET not set in environment');
      return res.status(500).json({
        error: 'LinkedIn client secret not configured',
        message: 'Please set LINKEDIN_CLIENT_SECRET in your .env file'
      });
    }

    // Check if challenge code is provided
    if (!challengeCode) {
      logger.error('❌ [LinkedIn Webhook] No challengeCode provided');
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

    logger.info('✅ [LinkedIn Webhook] Challenge response computed');

    // Return JSON response with both challengeCode and challengeResponse
    // Must respond within 3 seconds with 200 OK and content-type: application/json
    const response = {
      challengeCode: challengeCode,
      challengeResponse: challengeResponse
    };

    res.setHeader('Content-Type', 'application/json');
    res.status(200).json(response);

    logger.info('✅ [LinkedIn Webhook] Verification response sent', {
      challengeCode: challengeCode.substring(0, 8) + '...',
      responseLength: JSON.stringify(response).length
    });
  } catch (error) {
    logger.error('❌ [LinkedIn Webhook] Verification error', { error: error.message, stack: error.stack });
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
    
    logger.info('💼 [LinkedIn Webhook] Received', { body: req.body });

    // Verify webhook signature for security
    // LinkedIn uses X-LI-Signature header with format: hmacsha256=<hash>
    // The hash is computed on the JSON body prefixed by "hmacsha256="
    const signatureHeader = req.headers['x-li-signature'];
    
    if (signatureHeader) {
      if (!process.env.LINKEDIN_CLIENT_SECRET) {
        logger.error('❌ [LinkedIn Webhook] LINKEDIN_CLIENT_SECRET not set for signature verification');
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
        logger.error('❌ [LinkedIn Webhook] Invalid signature', {
          received: signature.substring(0, 10) + '...',
          expected: expectedSignature.substring(0, 10) + '...'
        });
        return res.sendStatus(403);
      }
      
      logger.info('✅ [LinkedIn Webhook] Signature verified');
    } else {
      logger.warn('⚠️  [LinkedIn Webhook] No X-LI-Signature header present');
    }

    // Acknowledge receipt immediately
    res.sendStatus(200);

    // Process webhook asynchronously
    const { eventType, organizationUrn, data } = req.body;
    
    if (!eventType || !data) {
      logger.info('⚠️  [LinkedIn Webhook] Invalid payload structure');
      return;
    }

    // Extract organization ID from URN (format: urn:li:organization:12345)
    const orgId = organizationUrn?.split(':').pop();
    
    if (!orgId) {
      logger.info('⚠️  [LinkedIn Webhook] No organization ID in payload');
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
      logger.info(`⚠️  [LinkedIn Webhook] No active connection found for org: ${orgId}`);
      return;
    }

    logger.info(`✅ [LinkedIn Webhook] Found connection for org: ${connection.platformName}`);

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

    logger.info(`✅ [LinkedIn Webhook] Queued ${eventType} for processing`);
  } catch (error) {
    logger.error('❌ [LinkedIn Webhook] Handler error', { error: error.message, stack: error.stack });
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

    logger.info('💬 [WhatsApp Webhook] Verification request', { 
      mode, 
      tokenProvided: !!token,
      challengeProvided: !!challenge 
    });

    // Verify the token and mode
    // Accept either the WhatsApp-specific token or the generic Meta verify token
    const expectedToken = process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN || process.env.META_WEBHOOK_VERIFY_TOKEN;
    if (mode === 'subscribe' && token === expectedToken) {
      logger.info('✅ [WhatsApp Webhook] Verification successful');
      res.status(200).send(challenge);
    } else {
      logger.error('❌ [WhatsApp Webhook] Verification failed — token mismatch');
      res.sendStatus(403);
    }
  } catch (error) {
    logger.error('❌ [WhatsApp Webhook] Verification error', { error: error.message, stack: error.stack });
    res.sendStatus(500);
  }
};

/**
 * @desc    Handle WhatsApp webhook.
 *
 * Responsibilities that stay in the controller:
 *   1. Meta signature verification (x-hub-signature-256)
 *   2. Immediate 200 ACK so Meta does not retry while we process
 *   3. Top-level object-type guard
 *
 * Everything else — connection lookup, message persistence, sentiment,
 * socket emit, AI/auto-reply queuing, delivery-status updates — is handled
 * by whatsappWebhookService.processWhatsAppWebhook().
 *
 * @route   POST /api/webhooks/whatsapp
 * @access  Public (called by Meta)
 */
/**
 * @desc    Verify the Interakt partner webhook (some consoles probe with a GET).
 * @route   GET /api/webhooks/interakt
 * @access  Public
 */
exports.verifyInteraktWebhook = async (req, res) => {
  // Meta-style handshake, in case Interakt's console uses one.
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  const expected =
    process.env.INTERAKT_WEBHOOK_VERIFY_TOKEN || process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN;

  if (mode === 'subscribe' && challenge && expected && token === expected) {
    logger.info('[Interakt Webhook] Verification succeeded');
    return res.status(200).send(challenge);
  }
  // Plain reachability probe.
  if (!mode && !challenge) return res.status(200).send('OK');

  logger.warn('[Interakt Webhook] Verification failed', { mode, hasChallenge: Boolean(challenge) });
  return res.sendStatus(403);
};

/**
 * @desc    Interakt partner (tech-partner) webhook — onboarding lifecycle events.
 *
 * This is the partner-level callback shared between us and Interakt. It is NOT the
 * per-number message webhook (that is /api/webhooks/whatsapp, which carries Meta-format
 * messages and delivery statuses). Interakt posts here when a WABA/phone number
 * finishes onboarding against our solution:
 *
 *   { "event": "WABA_ONBOARDED",
 *     "isv_name_token": "<our ISV token>",
 *     "waba_id": "...",
 *     "phone_number_id": "..." }
 *
 * Authentication is the echoed `isv_name_token` — Interakt sends our own partner token
 * back to us, so a constant-time compare against INTERAKT_ISV_TOKEN proves the sender.
 *
 * Only WABA_ONBOARDED is documented today; anything else is acknowledged and logged in
 * full rather than dropped, so we can see what Interakt actually sends on failure.
 *
 * @route   POST /api/webhooks/interakt
 * @access  Public (authenticated by the echoed ISV token in the body)
 */
exports.handleInteraktWebhook = async (req, res) => {
  const body = req.body || {};
  const { event, isv_name_token: isvToken, waba_id: wabaId, phone_number_id: phoneNumberId } = body;

  const expected = process.env.INTERAKT_ISV_TOKEN;
  if (!expected) {
    logger.error('[Interakt Webhook] INTERAKT_ISV_TOKEN not configured — cannot authenticate');
    return res.sendStatus(503);
  }

  const crypto = require('crypto');
  const a = Buffer.from(String(isvToken || ''));
  const b = Buffer.from(String(expected));
  const authed = a.length === b.length && crypto.timingSafeEqual(a, b);
  if (!authed) {
    logger.warn('[Interakt Webhook] Rejected: isv_name_token mismatch', { event, wabaId });
    return res.sendStatus(403);
  }

  // ACK before doing any work — Interakt should never wait on our DB.
  res.sendStatus(200);

  logger.info('[Interakt Webhook] Event received', { event, wabaId, phoneNumberId });

  // Onboarding failure. Observed shape (note the doubly-nested error):
  //   { event: 'WABA_ONBOARDING_FAILED', waba_id, phone_number_id,
  //     error: { error: { message, type, code, fbtrace_id } } }
  if (event === 'WABA_ONBOARDING_FAILED') {
    const metaError = body.error?.error || body.error || {};
    const reason = metaError.message || 'Interakt could not complete onboarding for this WABA.';
    logger.error('[Interakt Webhook] Onboarding failed', {
      wabaId, phoneNumberId, code: metaError.code, reason
    });

    const interaktLog = require('../services/interaktLogService');
    await interaktLog.logInbound({
      event, success: false, reason, wabaId, phoneNumberId,
      errorCode: metaError.code, payload: body
    });

    try {
      const PlatformConnection = require('../models/PlatformConnection');
      const or = [];
      if (phoneNumberId) {
        or.push({ 'platformData.phoneNumberId': String(phoneNumberId) });
        or.push({ platformUserId: String(phoneNumberId) });
      }
      if (wabaId) {
        or.push({ 'platformData.wabaId': String(wabaId) });
        or.push({ 'platformData.businessAccountId': String(wabaId) });
      }
      // Only the Interakt-transported rows — a pre-existing Meta-direct connection on
      // the same WABA is still perfectly healthy and must not be marked failed.
      const connections = await PlatformConnection.find({
        platform: 'whatsapp',
        'platformData.provider': 'interakt',
        $or: or
      });

      for (const connection of connections) {
        if (!connection.platformData) connection.platformData = {};
        connection.platformData.interaktLastError = String(reason).slice(0, 500);
        connection.markModified('platformData');
        connection.status = 'error';
        await connection.save();
      }
      logger.info('[Interakt Webhook] Marked connections failed', { count: connections.length, wabaId });
    } catch (err) {
      logger.error('[Interakt Webhook] Could not apply onboarding failure', { error: err.message, wabaId });
    }
    return;
  }

  if (event !== 'WABA_ONBOARDED') {
    // Still-unseen event type. Log the payload (minus the token) rather than guessing
    // at semantics, so it can be implemented once a real one has been observed.
    const { isv_name_token, ...safe } = body;
    logger.warn('[Interakt Webhook] Unhandled event type — logging payload for follow-up', { payload: safe });
    // Recorded as failed so it surfaces in the super-admin panel rather than only
    // existing in pm2 logs — that is how WABA_ONBOARDING_FAILED was discovered.
    const interaktLogUnknown = require('../services/interaktLogService');
    await interaktLogUnknown.logInbound({
      event, success: false, reason: `Unhandled Interakt event: ${event}`,
      wabaId, phoneNumberId, payload: body
    });
    return;
  }

  if (!phoneNumberId && !wabaId) {
    logger.warn('[Interakt Webhook] WABA_ONBOARDED without waba_id or phone_number_id — ignoring');
    return;
  }

  try {
    const PlatformConnection = require('../models/PlatformConnection');
    const or = [];
    if (phoneNumberId) {
      or.push({ 'platformData.phoneNumberId': String(phoneNumberId) });
      or.push({ platformUserId: String(phoneNumberId) });
    }
    if (wabaId) {
      or.push({ 'platformData.wabaId': String(wabaId) });
      or.push({ 'platformData.businessAccountId': String(wabaId) });
    }

    const connection = await PlatformConnection.findOne({ platform: 'whatsapp', $or: or });
    if (!connection) {
      // Interakt can confirm before our signup handler has finished writing. Not an
      // error — the signup path sets the same fields itself.
      logger.warn('[Interakt Webhook] No matching connection yet', { wabaId, phoneNumberId });
      return;
    }

    if (!connection.platformData) connection.platformData = {};
    connection.platformData.provider = 'interakt';
    if (wabaId) {
      connection.platformData.wabaId = String(wabaId);
      connection.platformData.businessAccountId = String(wabaId);
    }
    if (phoneNumberId) connection.platformData.phoneNumberId = String(phoneNumberId);
    connection.platformData.interaktRegisteredAt = new Date();
    connection.platformData.interaktLastError = null;
    connection.markModified('platformData');
    connection.status = 'connected';
    connection.isActive = true;
    await connection.save();

    logger.info('[Interakt Webhook] Connection marked onboarded', {
      connectionId: connection._id.toString(),
      organization: connection.organization?.toString()
    });

    const interaktLogOk = require('../services/interaktLogService');
    await interaktLogOk.logInbound({
      event, success: true, wabaId, phoneNumberId,
      organization: connection.organization || null,
      platformConnection: connection._id,
      payload: body
    });
  } catch (err) {
    logger.error('[Interakt Webhook] Failed to apply WABA_ONBOARDED', { error: err.message, wabaId, phoneNumberId });
  }
};

exports.handleWhatsAppWebhook = async (req, res) => {
  logger.info('[WhatsApp Webhook] Received event');

  // Signature verification.
  //
  // Meta signs with OUR app secret, so the HMAC below is authoritative for
  // Meta-direct numbers. Interakt-proxied deliveries are signed by Interakt's app
  // (or unsigned), so that HMAC can never match — a mismatch there means "different
  // sender", not "forged". We therefore verify whenever a signature is present and
  // it validates, and only hard-reject when it is present AND provably wrong AND we
  // are not expecting Interakt traffic.
  const signature = req.headers['x-hub-signature-256'];
  const appSecret = process.env.META_APP_SECRET || process.env.FACEBOOK_APP_SECRET;

  if (signature && appSecret) {
    const crypto = require('crypto');
    const raw =
      req.rawBody && Buffer.isBuffer(req.rawBody)
        ? req.rawBody
        : Buffer.from(JSON.stringify(req.body ?? {}));
    if (!req.rawBody) {
      logger.warn(
        '[WhatsApp Webhook] req.rawBody missing — signature may fail. Ensure POST /api/webhooks/whatsapp uses express.json verify (see app.js).'
      );
    }
    const expected =
      'sha256=' + crypto.createHmac('sha256', appSecret).update(raw).digest('hex');

    // Constant-time compare, and never log `expected` — that hands out a valid
    // signature for this exact body to anyone who can read the logs.
    const expectedBuf = Buffer.from(expected);
    const receivedBuf = Buffer.from(String(signature));
    const valid =
      expectedBuf.length === receivedBuf.length &&
      crypto.timingSafeEqual(expectedBuf, receivedBuf);

    if (!valid) {
      const interaktEnabled = Boolean(process.env.INTERAKT_ISV_TOKEN);
      if (!interaktEnabled) {
        logger.error('[WhatsApp Webhook] Invalid signature — rejecting', {
          received: String(signature).slice(0, 16) + '…'
        });
        return res.sendStatus(403);
      }
      // Interakt is configured: accept, but make it visible rather than silent.
      logger.warn(
        '[WhatsApp Webhook] Signature did not match our app secret; accepting as Interakt-proxied delivery',
        { received: String(signature).slice(0, 16) + '…' }
      );
    }
  } else {
    logger.warn(
      '[WhatsApp Webhook] Signature verification skipped (no signature header, or META_APP_SECRET / FACEBOOK_APP_SECRET unset)'
    );
  }

  // ACK immediately so Meta does not retry while we do async work.
  res.sendStatus(200);

  if (req.body?.object !== 'whatsapp_business_account') {
    logger.info('[WhatsApp Webhook] Ignoring non-whatsapp_business_account event', {
      objectType: req.body?.object
    });
    return;
  }

  try {
    const { webhookQueue } = require('../config/queue');
    const hasStatuses = req.body?.entry?.some((e) =>
      e.changes?.some((c) => c.value?.statuses?.length > 0)
    );
    const messageCount = req.body?.entry?.reduce(
      (n, e) => n + (e.changes?.reduce((c, ch) => c + (ch.value?.messages?.length ?? 0), 0) ?? 0), 0
    );

    // Deterministic jobId so retried/duplicate deliveries (Meta retries the exact
    // same webhook body when our 200 OK doesn't arrive in time, and some BSPs like
    // Interakt also redeliver) are deduped by Bull itself at enqueue time — Bull
    // will not create a second job for a jobId that already exists in Redis.
    // Hash the exact bytes we received (falls back to serialized body if rawBody
    // capture is ever unavailable) so retries of the same payload map to the same id.
    const crypto = require('crypto');
    const rawForId =
      req.rawBody && Buffer.isBuffer(req.rawBody)
        ? req.rawBody
        : Buffer.from(JSON.stringify(req.body ?? {}));
    const jobId = `wa_webhook_${crypto.createHash('sha256').update(rawForId).digest('hex')}`;

    const job = await webhookQueue.add(
      {
        platform: 'whatsapp_webhook',
        payload: req.body
      },
      {
        jobId,
        attempts: 3,
        backoff: { type: 'exponential', delay: 2000 },
        priority: hasStatuses ? 2 : 1
      }
    );
    logger.info('[WhatsApp Webhook] Enqueued', {
      jobId: job.id,
      messages: messageCount,
      statuses: hasStatuses
    });
  } catch (error) {
    logger.error('[WhatsApp Webhook] Failed to enqueue', { error: error.message, stack: error.stack });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Product Payment Webhook
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @desc    Handle payment confirmation from any payment provider (legacy commerce flow).
 *          Matches the order by orderToken, queues a confirmation DM, and atomically marks paid.
 *
 *          Hardening (Phase 0):
 *            - raw body HMAC-SHA256 via exact bytes (req.rawBody captured in app.js)
 *            - timing-safe comparison via timingSafeEqual
 *            - PRODUCT_PAYMENT_SECRET mandatory in production
 *            - atomic findOneAndUpdate with status guard (dedup)
 *            - bridges to canonical CommerceOrder when orderToken matches
 *            - confirmation DM is queued, not sent inline
 *
 * @route   POST /api/webhooks/product-payment
 * @access  Public (verified by HMAC)
 */
exports.handleProductPaymentWebhook = async (req, res) => {
  // ACK immediately so the payment provider does not retry while we process
  res.sendStatus(200);

  try {
    const crypto = require('crypto');
    const secret = process.env.PRODUCT_PAYMENT_SECRET;

    // Require webhook secret in production
    if (!secret && process.env.NODE_ENV === 'production') {
      logger.error('[ProductPayment] PRODUCT_PAYMENT_SECRET not configured in production — webhook rejected');
      return;
    }

    if (secret) {
      const sig = req.headers['x-repmeup-sig'] || req.headers['x-webhook-sig'] || '';
      // Always use exact raw bytes captured in app.js express.json verify callback
      const rawBody = Buffer.isBuffer(req.rawBody)
        ? req.rawBody
        : Buffer.from(req.rawBody || JSON.stringify(req.body || '{}'));
      const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
      const sigBuf = Buffer.from(sig);
      const expBuf = Buffer.from(expected);
      const signaturesMatch =
        sigBuf.length === expBuf.length &&
        crypto.timingSafeEqual(sigBuf, expBuf);
      if (!signaturesMatch) {
        logger.warn('[ProductPayment] Invalid signature — request rejected');
        return;
      }
    }

    const { order_token: orderToken, payment_ref: paymentRef, amount: rawAmount, currency } = req.body || {};
    if (!orderToken) {
      logger.warn('[ProductPayment] Missing order_token in payload');
      return;
    }

    const ProductOrder = require('../models/ProductOrder');
    const CommerceOrder = require('../models/CommerceOrder');

    // Atomic status transition — guards against duplicate webhook delivery
    const claimed = await ProductOrder.findOneAndUpdate(
      { orderToken, status: { $ne: 'paid' } },
      {
        $set: {
          status: 'paid',
          paymentRef: paymentRef || null,
          paidAt: new Date()
        }
      },
      { new: true }
    ).populate('product');

    if (!claimed) {
      logger.info('[ProductPayment] Order already paid or not found — skipping duplicate', { orderToken });
      return;
    }

    logger.info('[ProductPayment] ProductOrder marked paid', { orderToken, paymentRef });

    // Bridge to canonical CommerceOrder if one references the same orderToken
    const bridgeUpdate = {
      $set: {
        status: 'paid',
        paymentRef: paymentRef || null,
        paymentMethod: 'external',
        paidAt: new Date()
      },
      $push: {
        statusHistory: {
          status: 'paid',
          at: new Date(),
          note: `Payment confirmed via product-payment webhook (ref: ${paymentRef || 'unknown'})`
        }
      }
    };
    const bridged = await CommerceOrder.findOneAndUpdate(
      { orderToken, status: { $nin: ['paid', 'delivered', 'cancelled', 'refunded'] } },
      bridgeUpdate,
      { new: true }
    );
    if (bridged) {
      logger.info('[ProductPayment] Bridged payment status to CommerceOrder', {
        orderToken,
        commerceOrderId: String(bridged._id)
      });
    }

    // Queue confirmation DM — async, does not block ACK
    const { paymentWebhookQueue } = require('../config/queue');
    await paymentWebhookQueue.add(
      'product-payment-dm',
      {
        type: 'product_payment_confirmation',
        productOrderId: String(claimed._id),
        commerceOrderId: bridged ? String(bridged._id) : null,
        organizationId: String(claimed.organization),
        instagramUserId: claimed.instagramUserId,
        productName: claimed.product?.name || null
      },
      { attempts: 3, backoff: { type: 'exponential', delay: 3000 }, removeOnComplete: 50, removeOnFail: 100 }
    );
  } catch (err) {
    logger.error('[ProductPayment] Webhook handler error', { error: err.message });
  }
};

// ── Gmail Pub/Sub Webhook ─────────────────────────────────────────────────────

/**
 * POST /api/webhooks/gmail
 *
 * Receives push notifications from Google Pub/Sub when new Gmail messages arrive.
 * Payload shape (base64-encoded JSON in message.data):
 *   { emailAddress: string, historyId: string }
 *
 * Google requires a 2xx response within 10 seconds; processing is queued
 * so we ACK immediately and do the DB work asynchronously.
 */
exports.handleGmailWebhook = async (req, res) => {
  // Always ACK immediately to prevent Pub/Sub from retrying
  res.status(200).json({ received: true });

  try {
    const message = req.body?.message;
    if (!message?.data) {
      logger.warn('[GmailWebhook] push received with no message.data');
      return;
    }

    // Decode base64-encoded JSON payload
    let payload;
    try {
      payload = JSON.parse(Buffer.from(message.data, 'base64').toString('utf-8'));
    } catch {
      logger.warn('[GmailWebhook] could not decode message.data');
      return;
    }

    const { emailAddress, historyId } = payload;
    if (!emailAddress) {
      logger.warn('[GmailWebhook] push missing emailAddress');
      return;
    }

    logger.debug('[GmailWebhook] push received', { emailAddress, historyId });

    // Queue the processing job — same pattern as WhatsApp
    const { emailWebhookQueue, queueConfig } = require('../config/queue');
    await emailWebhookQueue.add(
      { provider: 'gmail', emailAddress, historyId },
      queueConfig
    );
  } catch (err) {
    logger.error('[GmailWebhook] error queuing job', { error: err.message });
  }
};

// ── Outlook / Microsoft Graph Webhook ────────────────────────────────────────

/**
 * POST /api/webhooks/outlook
 *
 * Handles both the Graph subscription validation challenge (GET-like POST with
 * validationToken query param) and the actual change notification payload.
 *
 * Security: validates the clientState secret on every notification.
 */
exports.handleOutlookWebhook = async (req, res) => {
  // Graph subscription validation: respond with the validationToken as plain text
  const validationToken = req.query.validationToken;
  if (validationToken) {
    return res.status(200).contentType('text/plain').send(validationToken);
  }

  // ACK immediately
  res.status(202).json({ received: true });

  try {
    const notifications = req.body?.value;
    if (!Array.isArray(notifications) || notifications.length === 0) return;

    const expectedClientState = process.env.OUTLOOK_WEBHOOK_CLIENT_STATE;

    for (const notification of notifications) {
      // Validate clientState to prevent spoofing
      if (expectedClientState && notification.clientState !== expectedClientState) {
        logger.warn('[OutlookWebhook] clientState mismatch — ignoring notification');
        continue;
      }

      const { subscriptionId, resource, resourceData } = notification;
      const messageId = resourceData?.id || resource?.split('/').pop();
      if (!messageId) continue;

      logger.debug('[OutlookWebhook] notification received', { subscriptionId, messageId });

      const { emailWebhookQueue, queueConfig } = require('../config/queue');
      await emailWebhookQueue.add(
        { provider: 'outlook', subscriptionId, messageId },
        queueConfig
      );
    }
  } catch (err) {
    logger.error('[OutlookWebhook] error queuing job', { error: err.message });
  }
};

