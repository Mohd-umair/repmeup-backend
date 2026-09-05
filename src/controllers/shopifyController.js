'use strict';

/**
 * shopifyController
 *
 * Handles:
 *  - POST /api/platforms/shopify/connect         — validate token, save connection, register webhooks, start backfill
 *  - POST /api/platforms/shopify/:id/disconnect  — unregister webhooks, mark disconnected
 *  - POST /api/platforms/shopify/:id/sync        — trigger a full manual re-sync
 *  - POST /api/webhooks/shopify                  — receive real-time events from Shopify (HMAC verified)
 */

const logger = require('../config/logger');
const PlatformConnection = require('../models/PlatformConnection');
const platformConnectionService = require('../services/platformConnectionService');
const {
  verifyToken,
  verifyAccessScopes,
  formatMissingScopesError,
  registerWebhooks,
  unregisterWebhooks,
  verifyWebhookHmac
} = require('../integrations/shopify/shopifyService');
const { runFullSync, handleWebhookTopic } = require('../services/shopifySyncService');

// ─── Helpers ──────────────────────────────────────────────────────────────────

function normalizeShopDomain(raw) {
  return raw
    .replace(/^https?:\/\//, '')
    .replace(/\/$/, '')
    .toLowerCase();
}

function callbackBaseUrl() {
  return process.env.BACKEND_URL || process.env.API_BASE_URL || 'https://api.repmeup.com';
}

// ─── Connect ──────────────────────────────────────────────────────────────────

/**
 * POST /api/platforms/shopify/connect
 * Body: { shopDomain, accessToken }
 */
exports.connectShopify = async (req, res, next) => {
  try {
    const { shopDomain: rawDomain, accessToken } = req.body;
    if (!rawDomain || !accessToken) {
      return res.status(400).json({ success: false, error: 'shopDomain and accessToken are required' });
    }

    const shopDomain = normalizeShopDomain(rawDomain);
    const orgId = req.user.organization._id;

    // 1. Verify the token against Shopify
    let shopInfo;
    try {
      shopInfo = await verifyToken(shopDomain, accessToken);
    } catch (err) {
      const status = err.response?.status;
      if (status === 401 || status === 403) {
        return res.status(400).json({ success: false, error: 'Invalid Shopify access token. Please check your credentials and try again.' });
      }
      logger.error('[shopifyController] Token verify failed', { shopDomain, error: err.message });
      return res.status(502).json({ success: false, error: `Could not reach Shopify store: ${err.message}` });
    }

    // 1b. Verify sync scopes — shop.json alone is not enough for products/customers/orders
    try {
      const { missing, missingRecommended } = await verifyAccessScopes(shopDomain, accessToken);
      if (missing.length > 0) {
        return res.status(400).json({ success: false, error: formatMissingScopesError(missing) });
      }
      if (missingRecommended.length > 0) {
        logger.warn('[shopifyController] Shopify token missing recommended scopes', {
          shopDomain,
          missingRecommended
        });
      }
    } catch (err) {
      const status = err.response?.status;
      if (status === 401 || status === 403) {
        return res.status(400).json({
          success: false,
          error: formatMissingScopesError(['read_products', 'read_customers', 'read_orders'])
        });
      }
      logger.error('[shopifyController] Scope verify failed', { shopDomain, error: err.message });
      return res.status(502).json({ success: false, error: `Could not verify Shopify API scopes: ${err.message}` });
    }

    // 2. Upsert PlatformConnection
    const connection = await PlatformConnection.findOneAndUpdate(
      { organization: orgId, platform: 'shopify', 'platformData.shopDomain': shopDomain },
      {
        $set: {
          organization: orgId,
          platform: 'shopify',
          platformUserId: shopInfo.shopId,
          platformUsername: shopInfo.shopDomain,
          platformDisplayName: shopInfo.shopName,
          accessToken,
          isActive: true,
          status: 'connected',
          createdBy: req.user._id,
          connectedAt: new Date(),
          platformData: {
            shopDomain: shopInfo.shopDomain,
            shopName: shopInfo.shopName,
            shopId: shopInfo.shopId,
            apiVersion: '2024-10'
          }
        },
        $setOnInsert: {
          createdAt: new Date(),
          stats: { totalInteractionsSynced: 0, lastSyncCount: 0, failedSyncAttempts: 0 }
        }
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    // 3. Increment usage (fire-and-forget so a quota spike doesn't block connect)
    platformConnectionService.incrementConnectionCount(orgId).catch(() => {});

    // 4. Register Shopify webhooks
    try {
      await registerWebhooks(shopDomain, accessToken, callbackBaseUrl());
    } catch (err) {
      logger.warn('[shopifyController] Webhook registration failed (non-fatal)', { shopDomain, error: err.message });
    }

    // 5. Kick off async full backfill in the API process (do not rely on worker queue alone)
    setImmediate(async () => {
      try {
        await runFullSync(connection);
      } catch (err) {
        logger.error('[shopifyController] Initial backfill failed', { shopDomain, error: err.message });
      }
    });

    res.status(201).json({
      success: true,
      message: `Shopify store "${shopInfo.shopName}" connected. Product, contact and order sync has started in the background.`,
      data: {
        connectionId: connection._id,
        shopName: shopInfo.shopName,
        shopDomain: shopInfo.shopDomain
      }
    });
  } catch (err) {
    logger.error('[shopifyController] connectShopify error', { error: err.message });
    next(err);
  }
};

// ─── Disconnect ───────────────────────────────────────────────────────────────

/**
 * DELETE /api/platforms/:id
 * The generic disconnectPlatform in platformController handles this for most platforms.
 * We hook into it via the shop-specific cleanup in the platform model lifecycle.
 * This dedicated endpoint handles Shopify-specific cleanup (webhook unregistration).
 */
exports.disconnectShopify = async (req, res, next) => {
  try {
    const connection = await PlatformConnection.findOne({
      _id: req.params.id,
      organization: req.user.organization._id,
      platform: 'shopify'
    });

    if (!connection) {
      return res.status(404).json({ success: false, error: 'Shopify connection not found' });
    }

    const shopDomain = connection.platformData?.shopDomain;
    const accessToken = connection.accessToken;

    // Unregister webhooks from Shopify (best-effort)
    if (shopDomain && accessToken) {
      unregisterWebhooks(shopDomain, accessToken, callbackBaseUrl()).catch(err => {
        logger.warn('[shopifyController] Webhook unregistration failed', { shopDomain, error: err.message });
      });
    }

    // Mark as disconnected (backfill createdBy for legacy Shopify rows missing it)
    connection.isActive = false;
    connection.status = 'disconnected';
    connection.disconnectedAt = new Date();
    if (!connection.createdBy) {
      connection.createdBy = req.user._id;
    }
    await connection.save();

    // Decrement usage counter
    const wasCounted = platformConnectionService.shouldCountConnection({ platform: 'shopify', metadata: connection.metadata });
    if (wasCounted) {
      await platformConnectionService.decrementConnectionCount(req.user.organization._id);
    }

    res.status(200).json({ success: true, message: 'Shopify store disconnected successfully.' });
  } catch (err) {
    logger.error('[shopifyController] disconnectShopify error', { error: err.message });
    next(err);
  }
};

// ─── Manual sync ──────────────────────────────────────────────────────────────

/**
 * POST /api/platforms/shopify/:id/sync
 * Triggers a full re-sync for the given connection.
 */
exports.syncShopify = async (req, res, next) => {
  try {
    const connection = await PlatformConnection.findOne({
      _id: req.params.id,
      organization: req.user.organization._id,
      platform: 'shopify',
      isActive: true
    });

    if (!connection) {
      return res.status(404).json({ success: false, error: 'Active Shopify connection not found' });
    }

    // Fire off sync without awaiting — respond immediately
    runFullSync(connection).catch(err => {
      logger.error('[shopifyController] syncShopify background error', { error: err.message });
    });

    res.status(202).json({ success: true, message: 'Shopify sync started in the background.' });
  } catch (err) {
    next(err);
  }
};

// ─── Webhook receiver ─────────────────────────────────────────────────────────

/**
 * POST /api/webhooks/shopify
 * Public endpoint; Shopify posts signed JSON payloads here.
 */
exports.handleShopifyWebhook = async (req, res) => {
  try {
    // ACK immediately — Shopify requires a 200 within 5 seconds
    res.sendStatus(200);

    const signature = req.headers['x-shopify-hmac-sha256'];
    const topic = req.headers['x-shopify-topic'];
    const shopDomain = req.headers['x-shopify-shop-domain'];

    // Signature check (use rawBody captured in app.js)
    const rawBody = req.rawBody;
    if (!rawBody) {
      logger.warn('[shopifyController] rawBody not available — HMAC cannot be verified');
      return;
    }

    if (!verifyWebhookHmac(rawBody, signature)) {
      logger.warn('[shopifyController] Shopify HMAC mismatch — dropping webhook', { shopDomain, topic });
      return;
    }

    if (!topic || !shopDomain) {
      logger.warn('[shopifyController] Missing topic or shopDomain header', { topic, shopDomain });
      return;
    }

    // Find the matching PlatformConnection
    const connection = await PlatformConnection.findOne({
      platform: 'shopify',
      isActive: true,
      'platformData.shopDomain': shopDomain
    }).lean();

    if (!connection) {
      logger.warn('[shopifyController] No active Shopify connection found for domain', { shopDomain });
      return;
    }

    // Enqueue through the webhook queue so processing is async and retryable
    try {
      const { webhookQueue } = require('../config/queue');
      await webhookQueue.add(
        {
          platform: 'shopify',
          topic,
          payload: req.body,
          organizationId: connection.organization.toString(),
          connectionId: connection._id.toString()
        },
        { attempts: 3, backoff: { type: 'exponential', delay: 3000 } }
      );
    } catch (qErr) {
      // Queue unavailable — process inline as a fallback
      logger.warn('[shopifyController] Queue unavailable, processing inline', { error: qErr.message });
      await handleWebhookTopic(connection, topic, req.body);
    }
  } catch (err) {
    logger.error('[shopifyController] handleShopifyWebhook error', { error: err.message });
    // Response already sent (200); nothing more to do
  }
};
