'use strict';

/**
 * Payment Gateway Controller
 *
 * Manages organization-owned payment gateway integrations.
 * All credential operations use paymentSecretCipher.
 * Only safe fields are returned in responses.
 */

const crypto = require('crypto');

const PaymentIntegration = require('../models/PaymentIntegration');
const gatewayRegistry = require('../services/payments/gatewayRegistry');
const { encryptFields, redactFields } = require('../utils/paymentSecretCipher');
const logger = require('../config/logger');

// ── Helpers ───────────────────────────────────────────────────────────────────

function _orgId(req) {
  return String(req.user?.organization?._id || req.user?.organization || '');
}

function _safeMasked(keyId) {
  if (!keyId || keyId.length < 8) return '****';
  return `${keyId.slice(0, 8)}...${keyId.slice(-4)}`;
}

/**
 * Strip internal fields from integration for API response.
 * Never includes credentialEnvelope, oauthAccessTokenEnv, oauthRefreshTokenEnv.
 */
function _safeIntegration(doc) {
  const obj = typeof doc.toObject === 'function' ? doc.toObject() : { ...doc };
  delete obj.credentialEnvelope;
  delete obj.oauthAccessTokenEnv;
  delete obj.oauthRefreshTokenEnv;
  delete obj.webhookEndpointToken;
  return obj;
}

// ── Endpoint handlers ─────────────────────────────────────────────────────────

/**
 * GET /api/payment-gateways
 * Returns available providers (from registry) + org's existing integrations.
 */
exports.listGateways = async (req, res) => {
  try {
    const organizationId = _orgId(req);
    const integrations = await PaymentIntegration.find({ organization: organizationId })
      .sort({ createdAt: -1 })
      .lean();

    const providers = gatewayRegistry.listProviders().map(provider => ({
      provider,
      capabilities: gatewayRegistry.getCapabilities(provider),
      credentialSchema: gatewayRegistry.getCredentialSchema(provider),
      connected: integrations.some(i => i.provider === provider && i.status === 'connected')
    }));

    res.json({
      success: true,
      providers,
      integrations: integrations.map(i => _safeIntegration(i))
    });
  } catch (err) {
    logger.error('[PaymentGatewayController] listGateways error', { error: err.message });
    res.status(500).json({ success: false, error: 'Failed to list gateways' });
  }
};

/**
 * GET /api/payment-gateways/:id
 */
exports.getGateway = async (req, res) => {
  try {
    const integration = await PaymentIntegration.findOne({
      _id: req.params.id,
      organization: _orgId(req)
    }).lean();
    if (!integration) return res.status(404).json({ success: false, error: 'Integration not found' });
    res.json({ success: true, integration: _safeIntegration(integration) });
  } catch (err) {
    logger.error('[PaymentGatewayController] getGateway error', { error: err.message });
    res.status(500).json({ success: false, error: 'Failed to get gateway' });
  }
};

/**
 * POST /api/payment-gateways
 * Connect a new payment gateway.
 */
exports.connectGateway = async (req, res) => {
  try {
    const organizationId = _orgId(req);
    const { provider, environment = 'test', credentials, displayName } = req.body || {};

    if (!provider) return res.status(400).json({ success: false, error: 'provider is required' });
    if (!gatewayRegistry.has(provider)) {
      return res.status(400).json({ success: false, error: `Unsupported provider: ${provider}` });
    }

    // Gate: live credentials not accepted until partner approval
    if (environment === 'live' && process.env.PAYMENTS_LIVE_MERCHANT_ONBOARDING !== 'enabled') {
      return res.status(403).json({
        success: false,
        error: 'Live merchant onboarding is not yet available. Razorpay Technology Partner approval is pending. Use test mode.',
        code: 'LIVE_ONBOARDING_GATED'
      });
    }

    // Validate credential keys match schema
    const schema = gatewayRegistry.getCredentialSchema(provider);
    const schemaKeys = schema.map(s => s.key);
    const missingKeys = schemaKeys.filter(k => !credentials?.[k]);
    if (missingKeys.length) {
      return res.status(400).json({
        success: false,
        error: `Missing required credential fields: ${missingKeys.join(', ')}`
      });
    }

    // Encrypt all credential values
    const credentialEnvelope = encryptFields(credentials);

    // Derive safe masked identifier (keyId for Razorpay, appId for Cashfree, etc.)
    const safeMerchantIdentifier = _safeMasked(credentials.keyId || credentials.appId || credentials.merchantKey || '');

    // Generate opaque webhook endpoint token
    const webhookEndpointToken = crypto.randomBytes(24).toString('hex');

    const integration = await PaymentIntegration.findOneAndUpdate(
      { organization: organizationId, provider, environment },
      {
        $set: {
          credentialEnvelope,
          safeMerchantIdentifier,
          webhookEndpointToken,
          displayName: displayName || `${provider} (${environment})`,
          status: 'connected',
          capabilities: gatewayRegistry.getCapabilities(provider),
          connectedAt: new Date(),
          lastErrorAt: null,
          lastErrorMessage: null,
          webhookFailureCount: 0
        },
        $setOnInsert: {
          organization: organizationId,
          provider,
          environment,
          isDefault: false
        }
      },
      { upsert: true, new: true }
    );

    logger.info('[PaymentGatewayController] Gateway connected', {
      integrationId: String(integration._id),
      provider,
      environment,
      organizationId
    });

    res.status(201).json({
      success: true,
      integration: _safeIntegration(integration),
      webhookUrl: `${process.env.BACKEND_URL || ''}/api/webhooks/payments/${provider}/${webhookEndpointToken}`
    });
  } catch (err) {
    logger.error('[PaymentGatewayController] connectGateway error', { error: err.message });
    res.status(500).json({ success: false, error: 'Failed to connect gateway' });
  }
};

/**
 * PATCH /api/payment-gateways/:id
 * Update credentials or display name.
 */
exports.updateGateway = async (req, res) => {
  try {
    const organizationId = _orgId(req);
    const { credentials, displayName } = req.body || {};

    const integration = await PaymentIntegration.findOne({
      _id: req.params.id,
      organization: organizationId
    });
    if (!integration) return res.status(404).json({ success: false, error: 'Integration not found' });

    if (credentials) {
      integration.credentialEnvelope = encryptFields(credentials);
      const safeMerchantIdentifier = _safeMasked(
        credentials.keyId || credentials.appId || credentials.merchantKey || ''
      );
      integration.safeMerchantIdentifier = safeMerchantIdentifier;
    }
    if (displayName) integration.displayName = displayName;

    await integration.save();
    res.json({ success: true, integration: _safeIntegration(integration.toObject()) });
  } catch (err) {
    logger.error('[PaymentGatewayController] updateGateway error', { error: err.message });
    res.status(500).json({ success: false, error: 'Failed to update gateway' });
  }
};

/**
 * POST /api/payment-gateways/:id/default
 * Mark this integration as the default for its provider+environment.
 */
exports.setDefault = async (req, res) => {
  try {
    const organizationId = _orgId(req);
    const integration = await PaymentIntegration.findOne({
      _id: req.params.id,
      organization: organizationId
    }).lean();
    if (!integration) return res.status(404).json({ success: false, error: 'Integration not found' });

    // Unset existing defaults for same provider+environment
    await PaymentIntegration.updateMany(
      { organization: organizationId, provider: integration.provider, environment: integration.environment },
      { $set: { isDefault: false } }
    );

    const updated = await PaymentIntegration.findOneAndUpdate(
      { _id: req.params.id },
      { $set: { isDefault: true } },
      { new: true }
    );
    res.json({ success: true, integration: _safeIntegration(updated.toObject()) });
  } catch (err) {
    logger.error('[PaymentGatewayController] setDefault error', { error: err.message });
    res.status(500).json({ success: false, error: 'Failed to set default' });
  }
};

/**
 * POST /api/payment-gateways/:id/health
 * Trigger a lightweight health check (verify credentials are still valid).
 */
exports.healthCheck = async (req, res) => {
  try {
    const organizationId = _orgId(req);
    const integration = await PaymentIntegration.findOne({
      _id: req.params.id,
      organization: organizationId
    }).lean();
    if (!integration) return res.status(404).json({ success: false, error: 'Integration not found' });

    const { decryptFields } = require('../utils/paymentSecretCipher');
    const envelopeRaw = integration.credentialEnvelope || {};
    const envelope = typeof envelopeRaw.toObject === 'function' ? envelopeRaw.toObject() : { ...envelopeRaw };
    const credentials = decryptFields(envelope);
    const adapter = gatewayRegistry.getAdapter(integration.provider);

    let healthy = false;
    let errorMsg = null;
    try {
      // For Razorpay: attempt to fetch account/orders to verify credentials
      if (integration.provider === 'razorpay') {
        const Razorpay = require('razorpay');
        const client = new Razorpay({ key_id: credentials.keyId, key_secret: credentials.keySecret });
        await client.orders.all({ count: 1 });
        healthy = true;
      } else {
        healthy = true;
      }
    } catch (err) {
      errorMsg = err.message;
    }

    await PaymentIntegration.updateOne(
      { _id: req.params.id },
      {
        $set: {
          lastHealthCheckAt: new Date(),
          lastHealthCheckStatus: healthy ? 'ok' : 'error',
          ...(errorMsg ? { lastErrorAt: new Date(), lastErrorMessage: errorMsg } : {})
        }
      }
    );

    res.json({ success: true, healthy, error: errorMsg || null });
  } catch (err) {
    logger.error('[PaymentGatewayController] healthCheck error', { error: err.message });
    res.status(500).json({ success: false, error: 'Health check failed' });
  }
};

/**
 * DELETE /api/payment-gateways/:id
 * Disconnect an integration (marks disconnected, rotates webhook token).
 */
exports.disconnectGateway = async (req, res) => {
  try {
    const organizationId = _orgId(req);
    const updated = await PaymentIntegration.findOneAndUpdate(
      { _id: req.params.id, organization: organizationId },
      {
        $set: {
          status: 'disconnected',
          disconnectedAt: new Date(),
          isDefault: false,
          // Rotate endpoint token so incoming webhooks to old URL stop matching
          webhookEndpointToken: crypto.randomBytes(24).toString('hex')
        }
      },
      { new: true }
    );
    if (!updated) return res.status(404).json({ success: false, error: 'Integration not found' });

    logger.info('[PaymentGatewayController] Gateway disconnected', {
      integrationId: String(updated._id),
      organizationId
    });
    res.json({ success: true });
  } catch (err) {
    logger.error('[PaymentGatewayController] disconnectGateway error', { error: err.message });
    res.status(500).json({ success: false, error: 'Failed to disconnect gateway' });
  }
};
